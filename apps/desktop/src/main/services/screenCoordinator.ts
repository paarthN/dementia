import type { ToolResult } from '../../shared/agent'
import { controlSignature, describeControlMatch, type ControlLookup } from '../../shared/controls'
import {
  reduceGuide,
  startGuide as beginGuide,
  startPoint,
  type GuideAction,
  type GuideState,
  type GuideView
} from '../../shared/guides'
import type { DisplaySpace } from '../../shared/highlightGeometry'
import {
  captureMetaSchema,
  explainFromInspection,
  redactSnapshot,
  uiSnapshotSchema,
  type InspectionView,
  type UiSnapshot
} from '../../shared/inspection'
import { unavailableVision, type VisionProvider } from '../../shared/vision'
import { HelperCallError, helperCallUnresolved, type OsBridge } from './osBridge'

export interface ScreenStatus {
  access: 'off' | 'on'
  captureActive: boolean
}

function guideState(view: GuideView): GuideState {
  return {
    guideId: view.guideId,
    stepIndex: view.stepIndex,
    status: view.status,
    ...(view.targetName ? { targetName: view.targetName } : {}),
    ...(view.targetRole ? { targetRole: view.targetRole } : {})
  }
}

const permissionResult: ToolResult = {
  status: 'requires_permission',
  summary:
    "I can't see the screen without permission. You can describe the message, or turn on screen access for this request.",
  errorCode: 'screen_permission',
  verification: { method: 'none', passed: false }
}

const protectedResult: ToolResult = {
  status: 'failed',
  summary:
    "I can't work with that secure screen. If this is a password or lock screen, you should decide. I won't press Continue.",
  errorCode: 'protected_context',
  verification: { method: 'accessibility', passed: false }
}

const helperDown: ToolResult = {
  status: 'failed',
  summary: 'Some screen-help features are unavailable.',
  errorCode: 'helper_unavailable',
  verification: { method: 'none', passed: false }
}

export function createScreenCoordinator(options: {
  bridge: OsBridge
  vision?: VisionProvider
  displays?: () => DisplaySpace[]
}): {
  status: () => ScreenStatus
  grant: () => void
  revoke: () => void
  beginCapture: () => AbortSignal | null
  finishCapture: () => void
  endCapture: () => void
  promptAccessibility: () => Promise<void>
  inspect: () => Promise<ToolResult>
  captureOnce: (explicitConsent: boolean) => Promise<ToolResult>
  startGuide: (guideId: string) => Promise<ToolResult>
  point: (name: string, role?: string) => Promise<ToolResult>
  describeControl: (input: { name: string; role?: string }) => Promise<ControlLookup>
  press: (input: {
    name: string
    role?: string
    text?: string
    signal?: AbortSignal
  }) => Promise<ToolResult>
  guideAction: (action: GuideAction) => Promise<ToolResult>
  currentGuide: () => GuideView | null
  clearGuide: () => void
  inspectionView: () => InspectionView | null
  setDeveloperInspection: (enabled: boolean) => void
  close: () => void
} {
  let access: ScreenStatus['access'] = 'off'
  let captureActive = false
  let developerInspection = false
  let lastView: InspectionView | null = null
  let captureAbort: AbortController | null = null
  let guide: GuideView | null = null
  let followedPid: number | null = null
  const vision = options.vision ?? unavailableVision
  const displays = options.displays ?? (() => [])

  async function readSnapshot(reading?: {
    processId?: number
    bringForward?: boolean
  }): Promise<UiSnapshot | null> {
    const raw = await options.bridge.request(
      'ui.inspectForeground',
      {
        depth: 8,
        maxNodes: 120,
        ...(reading?.processId ? { processId: reading.processId } : {}),
        ...(reading?.bringForward ? { bringForward: true } : {})
      },
      { timeoutMs: 8_000 }
    )
    const parsed = uiSnapshotSchema.safeParse(raw)
    const snapshot = parsed.success ? redactSnapshot(parsed.data) : null
    if (snapshot && !snapshot.protected && !reading?.processId) {
      followedPid = snapshot.processId
    }
    return snapshot
  }

  function remember(snapshot: UiSnapshot | null, known: string[], unknown: string[]): void {
    if (!developerInspection || !snapshot || snapshot.protected) {
      lastView = developerInspection
        ? {
            title: '',
            appName: '',
            controls: [],
            known,
            unknown
          }
        : null
      return
    }
    lastView = {
      title: snapshot.title,
      appName: snapshot.processName || snapshot.bundleId || '',
      controls: snapshot.controls.slice(0, 40).map((control) => ({
        name: control.name,
        role: control.role,
        enabled: control.enabled
      })),
      known,
      unknown
    }
  }

  return {
    status: () => ({ access, captureActive }),
    grant() {
      access = 'on'
    },
    beginCapture() {
      if (access !== 'on' || captureActive) {
        return null
      }
      const abort = new AbortController()
      captureAbort = abort
      captureActive = true
      return abort.signal
    },
    finishCapture() {
      captureActive = false
      captureAbort = null
    },
    endCapture() {
      captureActive = false
      captureAbort?.abort()
      captureAbort = null
    },
    revoke() {
      access = 'off'
      captureActive = false
      captureAbort?.abort()
      captureAbort = null
      guide = null
      followedPid = null
    },
    async promptAccessibility() {
      try {
        await options.bridge.request('system.promptAccessibility', {}, { timeoutMs: 3_000 })
      } catch {
        // The prompt is shown by macOS. A timeout still leaves the switch for the user.
      }
    },
    async inspect() {
      if (access !== 'on') {
        return permissionResult
      }
      try {
        const raw = await options.bridge.request(
          'ui.inspectForeground',
          { depth: 8, maxNodes: 120 },
          { timeoutMs: 8_000 }
        )
        const parsed = uiSnapshotSchema.safeParse(raw)
        if (!parsed.success) {
          return {
            status: 'failed',
            summary: "I couldn't read the screen.",
            errorCode: 'bad_snapshot',
            verification: { method: 'accessibility', passed: false }
          }
        }
        const snapshot = redactSnapshot(parsed.data)
        const explained = explainFromInspection({
          permission: 'granted',
          snapshot,
          capture: 'not_requested',
          vision: 'unused'
        })
        remember(snapshot, explained.known, explained.unknown)
        const thin = snapshot.metadataMissing || snapshot.controls.length === 0
        return {
          status: 'succeeded',
          summary: explained.summary,
          data: {
            known: explained.known,
            unknown: explained.unknown,
            title: snapshot.protected ? '' : snapshot.title
          },
          recovery: thin
            ? [{ label: 'Take one screenshot', actionKey: 'capture_screen' }]
            : [{ label: 'Show me what to do next', actionKey: 'guide_next' }],
          verification: {
            method: 'accessibility',
            passed: true,
            details: snapshot.protected ? 'protected' : snapshot.title
          }
        }
      } catch (error) {
        if (error instanceof HelperCallError && error.code === 'protected_context') {
          const explained = explainFromInspection({
            permission: 'granted',
            snapshot: null,
            capture: 'protected',
            vision: 'unused'
          })
          remember(null, explained.known, explained.unknown)
          return {
            status: 'succeeded',
            summary: explained.summary,
            data: { known: explained.known, unknown: explained.unknown },
            verification: { method: 'accessibility', passed: true, details: 'protected' }
          }
        }
        if (error instanceof HelperCallError && error.code === 'access_denied') {
          return {
            status: 'failed',
            summary:
              "I won't look at your screen. Turn on Accessibility for the Companion helper, or describe the message.",
            errorCode: 'access_denied',
            verification: { method: 'accessibility', passed: false }
          }
        }
        return {
          status: 'failed',
          summary: 'Some screen-help features are unavailable.',
          errorCode: 'helper_unavailable',
          verification: { method: 'none', passed: false }
        }
      }
    },
    async captureOnce(explicitConsent) {
      if (!explicitConsent || access !== 'on') {
        return {
          status: 'failed',
          summary: "I won't look at your screen.",
          errorCode: 'capture_refused',
          verification: { method: 'none', passed: false }
        }
      }
      if (captureActive) {
        return {
          status: 'failed',
          summary: "I'm already looking at the screen.",
          errorCode: 'capture_busy',
          verification: { method: 'none', passed: false }
        }
      }
      const abort = new AbortController()
      captureAbort = abort
      captureActive = true
      try {
        const raw = await options.bridge.request(
          'screen.captureOnce',
          { consent: true, prompt: true },
          { timeoutMs: 15_000, signal: abort.signal }
        )
        const meta = captureMetaSchema.safeParse(raw)
        if (
          !meta.success ||
          meta.data.allBlack ||
          meta.data.protected ||
          meta.data.byteLength <= 0
        ) {
          return {
            status: 'failed',
            summary: "I couldn't use that capture. I discarded it.",
            errorCode: 'capture_unusable',
            verification: { method: 'os', passed: false }
          }
        }
        const picture = await vision.explainImage()
        if (picture.available) {
          return {
            status: 'failed',
            summary: "I discarded the screenshot. I won't describe a picture I cannot verify.",
            errorCode: 'vision_untrusted',
            verification: { method: 'none', passed: false }
          }
        }
        const explained = explainFromInspection({
          permission: 'granted',
          snapshot: null,
          capture: 'discarded',
          vision: 'unavailable'
        })
        return {
          status: 'succeeded',
          summary: explained.summary,
          data: {
            byteLength: meta.data.byteLength,
            width: meta.data.width,
            height: meta.data.height
          },
          verification: { method: 'os', passed: true, details: 'frame_discarded' }
        }
      } catch (error) {
        if (
          abort.signal.aborted ||
          (error instanceof HelperCallError && error.code === 'aborted')
        ) {
          return {
            status: 'cancelled',
            summary: 'Screen access has stopped.',
            errorCode: 'capture_revoked',
            verification: { method: 'none', passed: false }
          }
        }
        if (error instanceof HelperCallError && error.code === 'protected_context') {
          return {
            status: 'failed',
            summary:
              "I can't work with that secure screen. If this is a password or lock screen, you should decide. I won't press Continue.",
            errorCode: 'protected_context',
            verification: { method: 'accessibility', passed: false }
          }
        }
        if (error instanceof HelperCallError && error.code === 'capture_refused') {
          return {
            status: 'failed',
            summary: "I won't look at your screen.",
            errorCode: 'capture_refused',
            verification: { method: 'none', passed: false }
          }
        }
        return {
          status: 'failed',
          summary: "I couldn't take a screenshot.",
          errorCode: 'capture_unavailable',
          verification: { method: 'os', passed: false }
        }
      } finally {
        captureActive = false
        if (captureAbort === abort) {
          captureAbort = null
        }
      }
    },
    async startGuide(guideId) {
      if (access !== 'on') {
        return permissionResult
      }
      try {
        const snapshot = await readSnapshot({ bringForward: true })
        if (snapshot?.protected) {
          guide = null
          followedPid = null
          return {
            status: 'failed',
            summary:
              "I can't work with that secure screen. If this is a password or lock screen, you should decide. I won't press Continue.",
            errorCode: 'protected_context',
            verification: { method: 'accessibility', passed: false }
          }
        }
        const started = beginGuide(guideId, snapshot, displays())
        if (!started) {
          guide = null
          return {
            status: 'failed',
            summary: "I don't have a guide for that.",
            errorCode: 'unknown_guide',
            verification: { method: 'none', passed: false }
          }
        }
        guide = started.view
        const grounded = started.view.highlight !== null || started.view.status !== 'showing'
        return {
          status: 'succeeded',
          summary: started.view.instruction,
          data: { guide: started.view },
          verification: {
            method: 'accessibility',
            passed: true,
            details: grounded ? started.view.status : 'ungrounded'
          }
        }
      } catch (error) {
        guide = null
        if (error instanceof HelperCallError && error.code === 'protected_context') {
          return {
            status: 'failed',
            summary:
              "I can't work with that secure screen. If this is a password or lock screen, you should decide. I won't press Continue.",
            errorCode: 'protected_context',
            verification: { method: 'accessibility', passed: false }
          }
        }
        return {
          status: 'failed',
          summary: 'Some screen-help features are unavailable.',
          errorCode: 'helper_unavailable',
          verification: { method: 'none', passed: false }
        }
      }
    },
    async point(name, role) {
      if (access !== 'on') {
        return permissionResult
      }
      const trimmed = name.trim()
      if (!trimmed) {
        guide = null
        return {
          status: 'failed',
          summary: 'What should I point at?',
          errorCode: 'not_found',
          verification: { method: 'accessibility', passed: false }
        }
      }
      try {
        const snapshot = await readSnapshot({ bringForward: true })
        if (snapshot?.protected) {
          guide = null
          followedPid = null
          return protectedResult
        }
        const started = startPoint(
          { name: trimmed, ...(role ? { role } : {}) },
          snapshot,
          displays()
        )
        const grounded = started.view.highlight !== null
        guide = grounded ? started.view : null
        return {
          status: grounded ? 'succeeded' : 'failed',
          summary: started.view.instruction,
          data: { guide: started.view },
          ...(grounded ? {} : { errorCode: 'not_found' }),
          verification: {
            method: 'accessibility',
            passed: grounded,
            details: started.view.status
          }
        }
      } catch {
        guide = null
        return helperDown
      }
    },
    async describeControl(input) {
      const snapshot = await readSnapshot(
        followedPid ? { processId: followedPid, bringForward: true } : { bringForward: true }
      )
      return describeControlMatch(snapshot, input.name, input.role)
    },
    async press(input) {
      if (access !== 'on') {
        return permissionResult
      }
      try {
        const before = await readSnapshot(
          followedPid ? { processId: followedPid, bringForward: true } : { bringForward: true }
        )
        const lookup = describeControlMatch(before, input.name, input.role)
        if (lookup.blocked) {
          return {
            status: 'failed',
            summary: lookup.summary,
            errorCode: 'protected_context',
            verification: { method: 'accessibility', passed: false }
          }
        }
        if (lookup.matchCount !== 1 || !lookup.match) {
          return {
            status: 'failed',
            summary: lookup.summary,
            errorCode: lookup.matchCount > 1 ? 'ambiguous' : 'not_found',
            verification: { method: 'accessibility', passed: false }
          }
        }
        const raw = await options.bridge.request(
          'ui.invokeElement',
          {
            name: lookup.match.name,
            role: lookup.match.role,
            ...(before?.processId ? { processId: before.processId } : {}),
            ...(input.text ? { text: input.text } : {})
          },
          { timeoutMs: 8_000, signal: input.signal }
        )
        const body =
          raw && typeof raw === 'object'
            ? (raw as { pressed?: boolean; typed?: boolean; changed?: boolean })
            : {}
        const after = await readSnapshot(
          before?.processId ? { processId: before.processId } : undefined
        )
        const changed =
          body.changed === true || controlSignature(before) !== controlSignature(after)
        const app = before?.processName || before?.bundleId
        const where = app ? `${lookup.match.name} in ${app}` : lookup.match.name
        const acted = body.pressed === true || body.typed === true
        if (!acted || !changed) {
          return {
            status: 'failed',
            summary: input.text
              ? `I tried to type into ${where}, but I couldn't confirm the screen changed.`
              : `I pressed ${where}, but I couldn't confirm the screen changed.`,
            errorCode: 'unverified',
            verification: { method: 'accessibility', passed: false }
          }
        }
        return {
          status: 'succeeded',
          summary: input.text ? `I typed that into ${where}.` : `I pressed ${where}.`,
          verification: { method: 'accessibility', passed: true }
        }
      } catch (error) {
        if (helperCallUnresolved(error)) {
          throw error
        }
        if (error instanceof HelperCallError && error.code === 'protected_context') {
          return protectedResult
        }
        if (
          error instanceof HelperCallError &&
          (error.code === 'not_found' || error.code === 'ambiguous')
        ) {
          return {
            status: 'failed',
            summary: error.message,
            errorCode: error.code,
            verification: { method: 'accessibility', passed: false }
          }
        }
        return helperDown
      }
    },
    async guideAction(action) {
      if (!guide) {
        return {
          status: 'failed',
          summary: 'There is no guide to continue.',
          errorCode: 'no_guide',
          verification: { method: 'none', passed: false }
        }
      }
      if (action === 'stop') {
        const reduced = reduceGuide(guideState(guide), 'stop', null, displays())
        guide = null
        followedPid = null
        return {
          status: 'cancelled',
          summary: reduced.view.instruction,
          verification: { method: 'local_state', passed: true }
        }
      }
      try {
        const snapshot = await readSnapshot(followedPid ? { processId: followedPid } : undefined)
        const reduced = reduceGuide(guideState(guide), action, snapshot, displays())
        guide = reduced.view.status === 'stopped' ? null : reduced.view
        return {
          status: reduced.view.status === 'stopped' ? 'cancelled' : 'succeeded',
          summary: reduced.view.instruction,
          data: { guide: reduced.view },
          verification: { method: 'accessibility', passed: true, details: reduced.view.status }
        }
      } catch {
        guide = null
        return {
          status: 'failed',
          summary: 'Some screen-help features are unavailable.',
          errorCode: 'helper_unavailable',
          verification: { method: 'none', passed: false }
        }
      }
    },
    currentGuide: () => guide,
    clearGuide() {
      guide = null
      followedPid = null
    },
    inspectionView: () => (developerInspection ? lastView : null),
    setDeveloperInspection(enabled) {
      developerInspection = enabled
      if (!enabled) {
        lastView = null
      }
    },
    close() {
      captureAbort?.abort()
      options.bridge.close()
    }
  }
}
