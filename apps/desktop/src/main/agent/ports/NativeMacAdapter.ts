import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  HelperCallError,
  HelperUnavailable,
  helperCallUnresolved,
  type OsBridge
} from '../../services/osBridge'
import {
  desktopKeyChords,
  desktopSnapshotTtlMs,
  desktopTextLimit,
  type DesktopAutomationPort,
  type DesktopCallOptions,
  type DesktopElementInput,
  type DesktopObservation,
  type DesktopOutcome,
  type DesktopTarget,
  type DesktopWindow
} from './DesktopAutomationPort'

const boundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite()
  })
  .strict()

const targetSchema = z
  .object({
    id: z.string().min(1).max(80),
    role: z.string().max(80),
    name: z.string().max(80),
    enabled: z.boolean(),
    value: z.string().max(desktopTextLimit).optional(),
    bounds: boundsSchema.nullable().optional()
  })
  .strict()

const observeSchema = z
  .object({
    windowId: z.string().min(1).max(80),
    processId: z.number().int(),
    bundleId: z.string().min(1).max(200).optional(),
    appName: z.string().max(80),
    title: z.string().max(80),
    protected: z.boolean(),
    truncated: z.boolean(),
    targets: z.array(targetSchema).max(120)
  })
  .strict()

const listSchema = z
  .object({
    windows: z
      .array(
        z
          .object({
            windowId: z.string().min(1).max(80),
            appName: z.string().max(80),
            bundleId: z.string().min(1).max(200).optional(),
            title: z.string().max(80),
            processId: z.number().int()
          })
          .strict()
      )
      .max(40)
  })
  .strict()

const actionSchema = z
  .object({
    acted: z.boolean(),
    verified: z.boolean().optional(),
    name: z.string().max(80).optional(),
    role: z.string().max(80).optional(),
    value: z.string().max(desktopTextLimit).optional(),
    chord: z.string().max(40).optional(),
    windowId: z.string().max(80).optional(),
    processId: z.number().int().optional(),
    bundleId: z.string().max(200).optional(),
    appName: z.string().max(80).optional()
  })
  .strict()

const textRoles = new Set(['AXTextField', 'AXTextArea', 'AXComboBox'])
const chords = new Set<string>(desktopKeyChords)

interface StoredSnapshot {
  snapshotId: string
  capturedAtMs: number
  windowId: string
  processId: number
  bundleId?: string
  appName: string
  title: string
  protected: boolean
  truncated: boolean
  targets: DesktopTarget[]
}

type HelperBody = z.infer<typeof observeSchema>

export function normalizeControlName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.…]+$/g, '')
    .trim()
}

export function createNativeMacAdapter(options: {
  bridge: OsBridge
  now?: () => number
  ttlMs?: number
}): DesktopAutomationPort {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? desktopSnapshotTtlMs
  const snapshots = new Map<string, StoredSnapshot>()
  let unsettled = false

  function remember(snapshot: StoredSnapshot): void {
    snapshots.set(snapshot.snapshotId, snapshot)
    if (snapshots.size > 8) {
      const oldest = snapshots.keys().next().value
      if (oldest) {
        snapshots.delete(oldest)
      }
    }
  }

  function blocked(summary: string): DesktopOutcome {
    return { status: 'blocked_sensitive', summary, errorCode: 'protected_context' }
  }

  async function call(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    mutating: boolean
  ): Promise<{ value: unknown } | { outcome: DesktopOutcome }> {
    if (unsettled && mutating) {
      return {
        outcome: {
          status: 'uncertain_after_timeout',
          summary: 'An earlier action may still be running, so I will not start another.',
          errorCode: 'uncertain_after_timeout'
        }
      }
    }
    if (signal?.aborted) {
      if (mutating) {
        return {
          outcome: {
            status: 'cancelled',
            summary: 'I stopped before that action.',
            errorCode: 'aborted'
          }
        }
      }
      return {
        outcome: { status: 'cancelled', summary: 'I stopped.', errorCode: 'aborted' }
      }
    }
    try {
      const value = await options.bridge.request(method, params, {
        timeoutMs: mutating ? 15_000 : 8_000,
        signal
      })
      return { value }
    } catch (error) {
      return { outcome: fromHelperError(error, mutating) }
    }
  }

  function fromHelperError(error: unknown, mutating: boolean): DesktopOutcome {
    if (helperCallUnresolved(error) || (mutating && stopAfterSend(error))) {
      unsettled = true
      return {
        status: 'uncertain_after_timeout',
        summary:
          'I asked it to stop, but I could not confirm the action finished. I will not start another action.',
        errorCode: 'uncertain_after_timeout'
      }
    }
    if (error instanceof HelperCallError) {
      if (error.code === 'access_denied') {
        return {
          status: 'needs_permission',
          summary: 'Accessibility permission is not granted.',
          errorCode: error.code
        }
      }
      if (error.code === 'protected_context') {
        return blocked("I can't work with that secure screen.")
      }
      if (error.code === 'ambiguous') {
        return {
          status: 'ambiguous_target',
          summary: 'More than one control matches. I did not use one.',
          errorCode: 'ambiguous'
        }
      }
      if (error.code === 'not_found' || error.code === 'unsupported') {
        return {
          status: 'unsupported',
          summary: error.message,
          errorCode: error.code
        }
      }
      if (error.code === 'aborted') {
        return {
          status: 'cancelled',
          summary: 'I stopped before that action.',
          errorCode: 'aborted'
        }
      }
      if (error.code === 'disabled') {
        return {
          status: 'failed',
          summary: 'That control is disabled, so I did not use it.',
          errorCode: 'disabled'
        }
      }
      if (error.code === 'focus_changed') {
        return {
          status: 'failed',
          summary: 'The window changed, so I did not continue.',
          errorCode: 'focus_changed'
        }
      }
      return { status: 'failed', summary: error.message, errorCode: error.code }
    }
    if (error instanceof HelperUnavailable) {
      return {
        status: 'failed',
        summary: 'Some screen-help features are unavailable.',
        errorCode: 'unavailable'
      }
    }
    return {
      status: 'failed',
      summary: "I couldn't finish that.",
      errorCode: 'helper_error'
    }
  }

  function observationFrom(stored: StoredSnapshot): DesktopObservation {
    return {
      snapshotId: stored.snapshotId,
      capturedAtUtc: new Date(stored.capturedAtMs).toISOString(),
      app: {
        name: stored.appName || 'an app',
        ...(stored.bundleId ? { bundleId: stored.bundleId } : {}),
        processId: stored.processId
      },
      window: { id: stored.windowId, ...(stored.title ? { title: stored.title } : {}) },
      targets: stored.targets,
      protected: stored.protected,
      truncated: stored.truncated,
      imageIncluded: false
    }
  }

  async function readWindow(
    input: { windowId?: string },
    signal: AbortSignal | undefined
  ): Promise<{ stored: StoredSnapshot } | { outcome: DesktopOutcome }> {
    const params: Record<string, unknown> = {}
    if (input.windowId) {
      params.windowId = input.windowId
    }
    const result = await call('desktop.observe', params, signal, false)
    if ('outcome' in result) {
      return result
    }
    const parsed = observeSchema.safeParse(result.value)
    if (!parsed.success) {
      return {
        outcome: {
          status: 'failed',
          summary: "I couldn't read that window.",
          errorCode: 'bad_observation'
        }
      }
    }
    const stored = storeObservation(parsed.data)
    return { stored }
  }

  function storeObservation(body: HelperBody): StoredSnapshot {
    const stored: StoredSnapshot = {
      snapshotId: `snap_${randomUUID()}`,
      capturedAtMs: now(),
      windowId: body.windowId,
      processId: body.processId,
      ...(body.bundleId ? { bundleId: body.bundleId } : {}),
      appName: body.appName,
      title: body.title,
      protected: body.protected,
      truncated: body.truncated,
      targets: body.targets.map((target) => ({
        id: target.id,
        role: target.role,
        name: target.name,
        enabled: target.enabled,
        ...(target.value !== undefined ? { value: target.value } : {}),
        bounds: target.bounds ?? null
      }))
    }
    remember(stored)
    return stored
  }

  function lookup(
    input: DesktopElementInput
  ): { snapshot: StoredSnapshot; target: DesktopTarget } | DesktopOutcome {
    const snapshot = snapshots.get(input.snapshotId)
    if (!snapshot) {
      return {
        status: 'unsupported',
        summary: 'That look at the window is gone. I need to look again.',
        errorCode: 'stale_snapshot'
      }
    }
    if (now() - snapshot.capturedAtMs > ttlMs) {
      return {
        status: 'unsupported',
        summary: 'That look at the window is out of date. I need to look again.',
        errorCode: 'stale_snapshot'
      }
    }
    if (snapshot.protected) {
      return blocked("I can't work with that secure screen.")
    }
    if (snapshot.windowId !== input.windowId || (snapshot.bundleId ?? '') !== input.bundleId) {
      return {
        status: 'failed',
        summary: 'The window changed, so I did not continue.',
        errorCode: 'focus_changed'
      }
    }
    if (!snapshot.bundleId) {
      return {
        status: 'unsupported',
        summary: "I couldn't tell which app that window belongs to.",
        errorCode: 'unsupported'
      }
    }
    const target = snapshot.targets.find((item) => item.id === input.targetId)
    if (!target) {
      return {
        status: 'unsupported',
        summary: "I can't find that control.",
        errorCode: 'not_found'
      }
    }
    if (
      target.role !== input.role ||
      normalizeControlName(target.name) !== normalizeControlName(input.name)
    ) {
      return {
        status: 'failed',
        summary: 'That confirmation does not match the control I saw.',
        errorCode: 'target_mismatch'
      }
    }
    const copies = snapshot.targets.filter(
      (item) =>
        item.role === target.role &&
        normalizeControlName(item.name) === normalizeControlName(target.name)
    )
    if (
      !normalizeControlName(target.name) &&
      (!textRoles.has(target.role) || copies.length !== 1)
    ) {
      return {
        status: 'unsupported',
        summary: "That control doesn't have a name, so I didn't use it.",
        errorCode: 'not_found'
      }
    }
    if (!target.enabled) {
      return {
        status: 'failed',
        summary: 'That control is disabled, so I did not use it.',
        errorCode: 'disabled'
      }
    }
    if (copies.length !== 1) {
      return {
        status: 'ambiguous_target',
        summary: 'More than one control matches. I did not use one.',
        errorCode: 'ambiguous'
      }
    }
    return { snapshot, target }
  }

  async function refresh(
    snapshot: StoredSnapshot,
    signal: AbortSignal | undefined
  ): Promise<{ stored: StoredSnapshot } | { outcome: DesktopOutcome }> {
    const fresh = await readWindow({ windowId: snapshot.windowId }, signal)
    if ('outcome' in fresh) {
      return fresh
    }
    if (
      fresh.stored.windowId !== snapshot.windowId ||
      fresh.stored.processId !== snapshot.processId ||
      (fresh.stored.bundleId ?? '') !== (snapshot.bundleId ?? '')
    ) {
      return {
        outcome: {
          status: 'failed',
          summary: 'The window changed, so I did not continue.',
          errorCode: 'focus_changed'
        }
      }
    }
    return fresh
  }

  function sameTarget(
    stored: StoredSnapshot,
    target: DesktopTarget
  ): DesktopTarget | DesktopOutcome {
    const matches = stored.targets.filter(
      (item) =>
        item.role === target.role &&
        normalizeControlName(item.name) === normalizeControlName(target.name)
    )
    if (matches.length !== 1) {
      return {
        status: matches.length > 1 ? 'ambiguous_target' : 'unsupported',
        summary:
          matches.length > 1
            ? 'More than one control matches. I did not use one.'
            : "That control is gone, so I didn't use it.",
        errorCode: matches.length > 1 ? 'ambiguous' : 'not_found'
      }
    }
    const match = matches[0]
    if (!match || !match.enabled) {
      return {
        status: 'failed',
        summary: 'That control is disabled, so I did not use it.',
        errorCode: 'disabled'
      }
    }
    return match
  }

  return {
    async listWindows(input, callOptions) {
      const params: Record<string, unknown> = {}
      if (input.bundleId) {
        params.bundleId = input.bundleId
      }
      const result = await call('desktop.listWindows', params, callOptions?.signal, false)
      if ('outcome' in result) {
        return result.outcome
      }
      const parsed = listSchema.safeParse(result.value)
      if (!parsed.success) {
        return {
          status: 'failed',
          summary: "I couldn't read the window list.",
          errorCode: 'bad_observation'
        }
      }
      const windows: DesktopWindow[] = parsed.data.windows
      return {
        status: 'success_verified',
        summary:
          windows.length === 0
            ? 'I did not see another open window.'
            : 'I listed the open windows.',
        windows
      }
    },

    async focusWindow(input, callOptions) {
      const result = await call(
        'desktop.focusWindow',
        { windowId: input.windowId, bundleId: input.bundleId },
        callOptions?.signal,
        true
      )
      if ('outcome' in result) {
        return result.outcome
      }
      const parsed = actionSchema.safeParse(result.value)
      if (
        !parsed.success ||
        parsed.data.acted !== true ||
        parsed.data.bundleId !== input.bundleId
      ) {
        return {
          status: 'failed',
          summary: "I couldn't confirm that window was in front.",
          errorCode: 'unverified'
        }
      }
      if (parsed.data.verified !== true) {
        return {
          status: 'changed_but_unverified',
          summary: 'I tried to bring that window forward, but I could not confirm it.',
          errorCode: 'changed_but_unverified'
        }
      }
      return {
        status: 'success_verified',
        summary: `${parsed.data.appName || 'The app'} is in front.`
      }
    },

    async observe(input, callOptions) {
      const read = await readWindow({ windowId: input.windowId }, callOptions?.signal)
      if ('outcome' in read) {
        return read.outcome
      }
      if (read.stored.protected) {
        return {
          ...blocked("I can't work with that secure screen."),
          observation: observationFrom(read.stored)
        }
      }
      const seen = read.stored.targets.filter((target) => target.name.trim()).length
      const picture = input.includeImage ? ' I did not take a picture.' : ''
      return {
        status: 'success_verified',
        summary:
          (seen > 0
            ? `I looked at ${read.stored.appName || 'the window'} and can read ${seen} named controls.`
            : `I looked at ${read.stored.appName || 'the window'}, but it did not share named controls.`) +
          picture,
        observation: observationFrom(stripValues(read.stored))
      }
    },

    async clickElement(input, callOptions) {
      const found = prepareElement(input, callOptions)
      if (isOutcome(found)) {
        return found
      }
      const fresh = await refresh(found.snapshot, callOptions?.signal)
      if ('outcome' in fresh) {
        return fresh.outcome
      }
      const match = sameTarget(fresh.stored, found.target)
      if (isOutcome(match)) {
        return match
      }
      const result = await call(
        'desktop.clickElement',
        identityParams(fresh.stored, match),
        callOptions?.signal,
        true
      )
      if ('outcome' in result) {
        return result.outcome
      }
      const parsed = actionSchema.safeParse(result.value)
      if (!parsed.success || parsed.data.acted !== true) {
        return {
          status: 'unsupported',
          summary: "I couldn't press that control.",
          errorCode: 'unsupported'
        }
      }
      return verifyChange(
        fresh.stored,
        callOptions,
        'I pressed the control.',
        'I pressed it, but I could not see a change.'
      )
    },

    async setText(input, callOptions) {
      if (input.text.length > desktopTextLimit) {
        return { status: 'failed', summary: 'That text is too long.', errorCode: 'not_allowlisted' }
      }
      if (!textRoles.has(input.role)) {
        return {
          status: 'unsupported',
          summary: 'I can type into a text field.',
          errorCode: 'not_allowlisted'
        }
      }
      const found = prepareElement(input, callOptions)
      if (isOutcome(found)) {
        return found
      }
      const fresh = await refresh(found.snapshot, callOptions?.signal)
      if ('outcome' in fresh) {
        return fresh.outcome
      }
      const match = sameTarget(fresh.stored, found.target)
      if (isOutcome(match)) {
        return match
      }
      if (!textRoles.has(match.role)) {
        return {
          status: 'unsupported',
          summary: 'I can type into a text field.',
          errorCode: 'not_allowlisted'
        }
      }
      const result = await call(
        'desktop.setText',
        { ...identityParams(fresh.stored, match), text: input.text },
        callOptions?.signal,
        true
      )
      if ('outcome' in result) {
        return result.outcome
      }
      const parsed = actionSchema.safeParse(result.value)
      if (!parsed.success || parsed.data.acted !== true) {
        return {
          status: 'unsupported',
          summary: "I couldn't type into that field.",
          errorCode: 'unsupported'
        }
      }
      const verified = await readWindow({ windowId: fresh.stored.windowId }, callOptions?.signal)
      if ('outcome' in verified) {
        return {
          status: 'changed_but_unverified',
          summary: 'I tried to type into the field, but I could not read it back.',
          errorCode: 'changed_but_unverified'
        }
      }
      const after = sameTarget(verified.stored, match)
      if (!isOutcome(after) && after.value === input.text && parsed.data.verified === true) {
        return {
          status: 'success_verified',
          summary: `I typed into ${match.name}.`,
          observation: observationFrom(stripValues(verified.stored))
        }
      }
      return {
        status: 'changed_but_unverified',
        summary: 'I tried to type into the field, but the text did not match.',
        errorCode: 'changed_but_unverified',
        observation: observationFrom(stripValues(verified.stored))
      }
    },

    async keyPress(input, callOptions) {
      const chord = input.chord.trim().toLowerCase()
      if (!chords.has(chord)) {
        return {
          status: 'failed',
          summary: 'I can only press navigation keys.',
          errorCode: 'not_allowlisted'
        }
      }
      const fresh = await readWindow({ windowId: input.windowId }, callOptions?.signal)
      if ('outcome' in fresh) {
        return fresh.outcome
      }
      if (
        fresh.stored.windowId !== input.windowId ||
        fresh.stored.processId !== input.processId ||
        (fresh.stored.bundleId ?? '') !== input.bundleId
      ) {
        return {
          status: 'failed',
          summary: 'The window changed, so I did not press a key.',
          errorCode: 'focus_changed'
        }
      }
      const before = signature(fresh.stored.targets)
      const result = await call(
        'desktop.keyPress',
        {
          chord,
          windowId: input.windowId,
          bundleId: input.bundleId,
          processId: input.processId
        },
        callOptions?.signal,
        true
      )
      if ('outcome' in result) {
        return result.outcome
      }
      const parsed = actionSchema.safeParse(result.value)
      if (!parsed.success || parsed.data.acted !== true) {
        return {
          status: 'unsupported',
          summary: "I couldn't press that key.",
          errorCode: 'unsupported'
        }
      }
      const after = await readWindow({ windowId: fresh.stored.windowId }, callOptions?.signal)
      if ('outcome' in after) {
        return {
          status: 'changed_but_unverified',
          summary: 'I sent the key, but I could not look again.',
          errorCode: 'changed_but_unverified'
        }
      }
      if (signature(after.stored.targets) === before) {
        return {
          status: 'changed_but_unverified',
          summary: 'I sent the key, but I could not see a change.',
          errorCode: 'changed_but_unverified'
        }
      }
      return {
        status: 'success_verified',
        summary: 'I pressed the key and the window changed.',
        observation: observationFrom(stripValues(after.stored))
      }
    },

    async scroll(input, callOptions) {
      if (
        !['up', 'down', 'left', 'right'].includes(input.direction) ||
        !Number.isInteger(input.amount) ||
        input.amount < 1 ||
        input.amount > 5
      ) {
        return {
          status: 'failed',
          summary: 'I can scroll a short distance up, down, left, or right.',
          errorCode: 'not_allowlisted'
        }
      }
      const fresh = await readWindow({ windowId: input.windowId }, callOptions?.signal)
      if ('outcome' in fresh) {
        return fresh.outcome
      }
      if (
        fresh.stored.processId !== input.processId ||
        (fresh.stored.bundleId ?? '') !== input.bundleId
      ) {
        return {
          status: 'failed',
          summary: 'The window changed, so I did not scroll.',
          errorCode: 'focus_changed'
        }
      }
      const result = await call(
        'desktop.scroll',
        {
          direction: input.direction,
          amount: input.amount,
          windowId: input.windowId,
          bundleId: input.bundleId,
          processId: input.processId
        },
        callOptions?.signal,
        true
      )
      if ('outcome' in result) {
        return result.outcome
      }
      const parsed = actionSchema.safeParse(result.value)
      if (!parsed.success || parsed.data.acted !== true) {
        return {
          status: 'unsupported',
          summary: "I can't find a scrollbar in that window.",
          errorCode: 'unsupported'
        }
      }
      if (parsed.data.verified === true) {
        return { status: 'success_verified', summary: 'I scrolled that window.' }
      }
      return {
        status: 'changed_but_unverified',
        summary: 'I tried to scroll, but I could not see the scrollbar move.',
        errorCode: 'changed_but_unverified'
      }
    }
  }

  function prepareElement(
    input: DesktopElementInput,
    callOptions: DesktopCallOptions | undefined
  ): { snapshot: StoredSnapshot; target: DesktopTarget } | DesktopOutcome {
    if (unsettled) {
      return {
        status: 'uncertain_after_timeout',
        summary: 'An earlier action may still be running, so I will not start another.',
        errorCode: 'uncertain_after_timeout'
      }
    }
    if (callOptions?.signal?.aborted) {
      return { status: 'cancelled', summary: 'I stopped before that action.', errorCode: 'aborted' }
    }
    return lookup(input)
  }

  async function verifyChange(
    before: StoredSnapshot,
    callOptions: DesktopCallOptions | undefined,
    success: string,
    unseen: string
  ): Promise<DesktopOutcome> {
    const after = await readWindow({ windowId: before.windowId }, callOptions?.signal)
    if ('outcome' in after) {
      return {
        status: 'changed_but_unverified',
        summary: unseen,
        errorCode: 'changed_but_unverified'
      }
    }
    if (signature(after.stored.targets) === signature(before.targets)) {
      return {
        status: 'no_change',
        summary: 'I used the control, but the window looked the same afterward.',
        errorCode: 'no_change'
      }
    }
    return {
      status: 'success_verified',
      summary: success,
      observation: observationFrom(stripValues(after.stored))
    }
  }
}

function stopAfterSend(error: unknown): boolean {
  if (error instanceof HelperCallError) {
    return (
      error.dispatched &&
      (error.code === 'aborted' || error.code === 'timeout' || error.code === 'uncertain')
    )
  }
  return error instanceof HelperUnavailable && error.dispatched
}

function isOutcome(
  value: { snapshot?: StoredSnapshot; target?: DesktopTarget } | DesktopOutcome | DesktopTarget
): value is DesktopOutcome {
  return 'status' in value
}

function identityParams(snapshot: StoredSnapshot, target: DesktopTarget): Record<string, unknown> {
  return {
    windowId: snapshot.windowId,
    bundleId: snapshot.bundleId,
    processId: snapshot.processId,
    name: target.name,
    role: target.role
  }
}

function signature(targets: DesktopTarget[]): string {
  return targets
    .map(
      (target) =>
        `${target.role}|${normalizeControlName(target.name)}|${target.enabled ? 1 : 0}|${target.value ?? ''}`
    )
    .join('\n')
}

function stripValues(snapshot: StoredSnapshot): StoredSnapshot {
  return {
    ...snapshot,
    targets: snapshot.targets.map((target) => ({
      id: target.id,
      role: target.role,
      name: target.name,
      enabled: target.enabled,
      bounds: target.bounds
    }))
  }
}
