import type { ToolResult } from '../../shared/agent'
import {
  reduceGuide,
  startGuide as beginGuide,
  type GuideAction,
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
import { HelperCallError, type OsBridge } from './osBridge'

export interface ScreenStatus {
  access: 'off' | 'on'
  captureActive: boolean
}

const permissionResult: ToolResult = {
  status: 'requires_permission',
  summary:
    "I can't see the screen without permission. You can describe the message, or turn on screen access for this request.",
  errorCode: 'screen_permission',
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
  endCapture: () => void
  promptAccessibility: () => Promise<void>
  inspect: () => Promise<ToolResult>
  captureOnce: (explicitConsent: boolean) => Promise<ToolResult>
  startGuide: (guideId: string) => Promise<ToolResult>
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
  const vision = options.vision ?? unavailableVision
  const displays = options.displays ?? (() => [])

  async function readSnapshot(): Promise<UiSnapshot | null> {
    const raw = await options.bridge.request(
      'ui.inspectForeground',
      { depth: 8, maxNodes: 120 },
      { timeoutMs: 8_000 }
    )
    const parsed = uiSnapshotSchema.safeParse(raw)
    return parsed.success ? redactSnapshot(parsed.data) : null
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
        const snapshot = await readSnapshot()
        if (snapshot?.protected) {
          guide = null
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
        const reduced = reduceGuide(
          { guideId: guide.guideId, stepIndex: guide.stepIndex, status: guide.status },
          'stop',
          null,
          displays()
        )
        guide = null
        return {
          status: 'cancelled',
          summary: reduced.view.instruction,
          verification: { method: 'local_state', passed: true }
        }
      }
      try {
        const snapshot = await readSnapshot()
        const reduced = reduceGuide(
          { guideId: guide.guideId, stepIndex: guide.stepIndex, status: guide.status },
          action,
          snapshot,
          displays()
        )
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
