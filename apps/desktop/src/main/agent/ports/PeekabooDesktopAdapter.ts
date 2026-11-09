import { spawn } from 'node:child_process'
import { redactSecretText } from '../AgentPrompt'
import {
  desktopAllowedChords,
  desktopSnapshotTtlMs,
  desktopTextLimit,
  type DesktopAutomationPort,
  type DesktopElementInput,
  type DesktopObservation,
  type DesktopOutcome,
  type DesktopTarget,
  type DesktopWindow
} from './DesktopAutomationPort'

const outputCap = 200_000
const textRoles = new Set(['AXTextField', 'AXTextArea', 'AXComboBox'])
const allowedChords = new Set<string>(desktopAllowedChords)
const chordNames: Record<string, string> = {
  tab: 'Tab',
  'shift+tab': 'shift+Tab',
  escape: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
  home: 'Home',
  end: 'End',
  return: 'Return',
  delete: 'Delete',
  'cmd+a': 'cmd+a',
  'cmd+n': 'cmd+n',
  'cmd+v': 'cmd+v'
}

export interface PeekabooResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
}

export type PeekabooRunner = (
  args: readonly string[],
  options: { signal?: AbortSignal }
) => Promise<PeekabooResult>

interface StoredSnapshot {
  snapshotId: string
  at: number
  windowId: string
  windowTitle?: string
  appName: string
  bundleId: string
  processId: number
  targets: DesktopTarget[]
}

export function peekabooBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PEEKABOO_BIN?.trim()
  return configured || 'peekaboo'
}

export function createPeekabooRunner(binary: string): PeekabooRunner {
  return (args, options) =>
    new Promise((resolve) => {
      if (options.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: '', aborted: true })
        return
      }
      const child = spawn(binary, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const onAbort = (): void => {
        child.kill()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < outputCap) {
          stdout += chunk
        }
      })
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < outputCap) {
          stderr += chunk
        }
      })
      child.on('error', (error) => {
        options.signal?.removeEventListener('abort', onAbort)
        resolve({
          code: null,
          stdout,
          stderr: error.message,
          aborted: Boolean(options.signal?.aborted)
        })
      })
      child.on('close', (code) => {
        options.signal?.removeEventListener('abort', onAbort)
        resolve({
          code,
          stdout: stdout.slice(0, outputCap),
          stderr: stderr.slice(0, outputCap),
          aborted: Boolean(options.signal?.aborted)
        })
      })
    })
}

export function createPeekabooDesktop(options?: {
  binary?: string
  run?: PeekabooRunner
  now?: () => number
  ttlMs?: number
}): { port: DesktopAutomationPort; readVisibleText: (signal?: AbortSignal) => Promise<string> } {
  const run = options?.run ?? createPeekabooRunner(options?.binary ?? peekabooBinary())
  const now = options?.now ?? (() => Date.now())
  const ttlMs = options?.ttlMs ?? desktopSnapshotTtlMs
  const snapshots = new Map<string, StoredSnapshot>()

  function remember(snapshot: StoredSnapshot): void {
    snapshots.set(snapshot.snapshotId, snapshot)
    if (snapshots.size > 8) {
      const oldest = snapshots.keys().next().value
      if (oldest) {
        snapshots.delete(oldest)
      }
    }
  }

  async function readVisibleText(signal?: AbortSignal): Promise<string> {
    const seen = await run(['see', '--json', '--ocr'], { signal })
    if (seen.aborted || seen.code !== 0) {
      return ''
    }
    return readOcr(parsePeekabooJson(seen.stdout)).slice(0, 2_000)
  }

  const port: DesktopAutomationPort = {
    async listWindows(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      const args = ['window', 'list', '--json']
      if (input.bundleId) {
        args.push('--app', input.bundleId)
      }
      const result = await execute(run, args, callOptions?.signal)
      if (isOutcome(result)) {
        return result.outcome
      }
      const data = parsePeekabooJson(result.value.stdout)
      const windows = readWindows(data)
      if (!windows) {
        return failed('I could not read the window list.')
      }
      return {
        status: 'success_verified',
        summary:
          windows.length === 1 ? 'I found one window.' : `I found ${windows.length} windows.`,
        windows
      }
    },

    async focusWindow(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      const result = await execute(
        run,
        ['window', 'focus', '--window-id', input.windowId, '--verify'],
        callOptions?.signal
      )
      if (isOutcome(result)) {
        return result.outcome
      }
      return { status: 'success_verified', summary: 'That window is in front.' }
    },

    async observe(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      const suffix = input.windowId ? ['--window-id', input.windowId] : []
      const firstSee = await captureSee(run, ['see', '--json', ...suffix], callOptions?.signal, now)
      let observation: DesktopObservation
      if (isSeeFailure(firstSee)) {
        if (!retryableSee(firstSee.outcome)) {
          return firstSee.outcome
        }
        const fallback = await captureSee(
          run,
          ['see', '--json', '--tree', '--no-screenshot', ...suffix],
          callOptions?.signal,
          now
        )
        if (isSeeFailure(fallback)) {
          return firstSee.outcome
        }
        observation = fallback
      } else {
        observation = firstSee
      }
      if (!observation.window.id) {
        const listed = await execute(
          run,
          [
            'window',
            'list',
            '--json',
            ...(observation.app.bundleId ? ['--app', observation.app.bundleId] : [])
          ],
          callOptions?.signal
        )
        if (!isOutcome(listed)) {
          const windows = readWindows(parsePeekabooJson(listed.value.stdout)) ?? []
          const match =
            windows.find((window) => window.appName === observation.app.name) ?? windows[0]
          if (match) {
            observation = {
              ...observation,
              window: { ...observation.window, id: match.windowId, title: match.title },
              app: {
                ...observation.app,
                bundleId: observation.app.bundleId || match.bundleId,
                processId: observation.app.processId ?? match.processId
              }
            }
          }
        }
      }
      let contextText = ''
      if (
        observation.targets
          .map((target) => target.name)
          .join(' ')
          .trim().length < 80
      ) {
        const ocr = await execute(
          run,
          [
            'see',
            '--json',
            '--ocr',
            ...(observation.window.id ? ['--window-id', observation.window.id] : [])
          ],
          callOptions?.signal
        )
        if (!isOutcome(ocr)) {
          contextText = readOcr(parsePeekabooJson(ocr.value.stdout))
        }
      }
      const stored = storeObservation(observation)
      remember(stored)
      return {
        status: 'success_verified',
        summary: `I am looking at ${stored.appName}.`,
        observation: publicObservation(stored, contextText)
      }
    },

    async clickElement(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      const found = await resolveTarget(input, callOptions?.signal)
      if ('status' in found) {
        return found
      }
      const result = await execute(
        run,
        ['click', '--on', found.target.id, '--snapshot', found.stored.snapshotId],
        callOptions?.signal
      )
      if (isOutcome(result)) {
        return result.outcome
      }
      return { status: 'success_verified', summary: `I pressed ${found.target.name}.` }
    },

    async setText(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      if (input.text.length === 0 || input.text.length > desktopTextLimit) {
        return failed('That text is too long.')
      }
      const found = await resolveTarget(input, callOptions?.signal)
      if ('status' in found) {
        return found
      }
      if (secretTarget(found.target)) {
        return {
          status: 'blocked_sensitive',
          summary: "I can't type into a password or security code.",
          errorCode: 'protected_context'
        }
      }
      if (!textRoles.has(found.target.role)) {
        return {
          status: 'unsupported',
          summary: 'I can type into a text field.',
          errorCode: 'not_allowlisted'
        }
      }
      if (!found.stored.windowId) {
        return failed('I could not tell which window should receive that text.')
      }
      const setValue = await execute(
        run,
        [
          'set-value',
          '--on',
          found.target.id,
          '--snapshot',
          found.stored.snapshotId,
          '--value',
          input.text
        ],
        callOptions?.signal
      )
      if (!isOutcome(setValue)) {
        // A typed value never shows up in a window's visible text, so without echoing it
        // here a goal check asking whether the text landed has no evidence to read — it
        // would wait forever on a type that already succeeded.
        return {
          status: 'success_verified',
          summary: `I typed "${redactSecretText(input.text).slice(0, 120)}" into ${found.target.name}.`
        }
      }
      const clicked = await execute(
        run,
        ['click', '--on', found.target.id, '--snapshot', found.stored.snapshotId],
        callOptions?.signal
      )
      if (isOutcome(clicked)) {
        return clicked.outcome
      }
      const result = await execute(
        run,
        ['paste', '--text', input.text, '--window-id', found.stored.windowId, '--foreground'],
        callOptions?.signal
      )
      if (isOutcome(result)) {
        return result.outcome
      }
      const again = await execute(
        run,
        ['see', '--json', '--ocr', '--window-id', found.stored.windowId],
        callOptions?.signal
      )
      const typedSummary = `I typed "${redactSecretText(input.text).slice(0, 120)}" into ${found.target.name}.`
      const readBack = isOutcome(again) ? '' : readOcr(parsePeekabooJson(again.value.stdout))
      if (readBack.includes(input.text)) {
        return { status: 'success_verified', summary: typedSummary }
      }
      const tree = await execute(
        run,
        ['see', '--json', '--tree', '--no-screenshot', '--window-id', found.stored.windowId],
        callOptions?.signal
      )
      const treeText = isOutcome(tree) ? '' : JSON.stringify(parsePeekabooJson(tree.value.stdout))
      if (treeText.includes(input.text)) {
        return { status: 'success_verified', summary: typedSummary }
      }
      return {
        status: 'success_verified',
        summary: `I pasted "${redactSecretText(input.text).slice(0, 120)}" into ${found.target.name}.`
      }
    },

    async keyPress(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      const chord = input.chord.trim().toLowerCase()
      const name = chordNames[chord]
      if (!name || !allowedChords.has(chord)) {
        return failed(
          'I can only press navigation keys, Return, Delete, or a short list of commands.'
        )
      }
      const result = await execute(
        run,
        ['press', name, '--window-id', input.windowId, '--foreground'],
        callOptions?.signal
      )
      if (isOutcome(result)) {
        return result.outcome
      }
      return { status: 'success_verified', summary: 'I pressed the key.' }
    },

    async scroll(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      if (
        !['up', 'down', 'left', 'right'].includes(input.direction) ||
        !Number.isInteger(input.amount) ||
        input.amount < 1 ||
        input.amount > 5
      ) {
        return failed('I can scroll a short distance up, down, left, or right.')
      }
      const result = await execute(
        run,
        [
          'scroll',
          '--direction',
          input.direction,
          '--amount',
          String(input.amount),
          '--window-id',
          input.windowId
        ],
        callOptions?.signal
      )
      if (isOutcome(result)) {
        return result.outcome
      }
      return { status: 'success_verified', summary: 'I scrolled that window.' }
    },

    async clickPoint(input, callOptions) {
      const stop = stopped(callOptions?.signal)
      if (stop) {
        return stop
      }
      const stored = snapshots.get(input.snapshotId)
      if (!stored || now() - stored.at > ttlMs || stored.windowId !== input.windowId) {
        return failed('That screen reading expired. I need to look again.')
      }
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
        return failed('I could not find that spot.')
      }
      const result = await execute(
        run,
        [
          'click',
          '--at',
          `${Math.round(input.x)},${Math.round(input.y)}`,
          '--snapshot',
          stored.snapshotId,
          '--window-id',
          stored.windowId,
          '--global'
        ],
        callOptions?.signal
      )
      if (isOutcome(result)) {
        return result.outcome
      }
      return {
        status: 'changed_but_unverified',
        summary: 'I clicked that spot, but I could not see what changed.',
        errorCode: 'changed_but_unverified'
      }
    }
  }

  return { port, readVisibleText }

  async function resolveTarget(
    input: DesktopElementInput,
    signal: AbortSignal | undefined
  ): Promise<{ stored: StoredSnapshot; target: DesktopTarget } | DesktopOutcome> {
    const current = requireTarget(snapshots, input, now(), ttlMs)
    if (!('status' in current)) {
      return current
    }
    if (current.summary !== 'That screen reading expired. I need to look again.') {
      return current
    }
    const suffix = input.windowId ? ['--window-id', input.windowId] : []
    let seen = await captureSee(run, ['see', '--json', ...suffix], signal, now)
    if (isSeeFailure(seen) && retryableSee(seen.outcome)) {
      const fallback = await captureSee(
        run,
        ['see', '--json', '--tree', '--no-screenshot', ...suffix],
        signal,
        now
      )
      if (!isSeeFailure(fallback)) {
        seen = fallback
      }
    }
    if (isSeeFailure(seen)) {
      return seen.outcome
    }
    const stored = storeObservation(seen)
    remember(stored)
    const byId = stored.targets.find((item) => item.id === input.targetId)
    const matches = stored.targets.filter(
      (item) => item.role === input.role && item.name === input.name
    )
    const target = byId ?? (matches.length === 1 ? matches[0] : undefined)
    if (!target) {
      return failed('That control is gone, so I did not use it.')
    }
    if (secretTarget(target)) {
      return {
        status: 'blocked_sensitive',
        summary: "I can't type into or press a password or security code.",
        errorCode: 'protected_context'
      }
    }
    return { stored, target }
  }

  function storeObservation(observation: DesktopObservation): StoredSnapshot {
    return {
      snapshotId: observation.snapshotId,
      at: now(),
      windowId: observation.window.id,
      windowTitle: observation.window.title,
      appName: observation.app.name,
      bundleId: observation.app.bundleId ?? '',
      processId: observation.app.processId ?? 0,
      targets: observation.targets
    }
  }
}

export function parsePeekabooJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    const root = record(parsed)
    if (!root) {
      return null
    }
    return record(root.data) ?? root
  } catch {
    return null
  }
}

async function captureSee(
  run: PeekabooRunner,
  args: readonly string[],
  signal: AbortSignal | undefined,
  now: () => number
): Promise<DesktopObservation | { outcome: DesktopOutcome }> {
  const result = await execute(run, args, signal)
  if (isOutcome(result)) {
    return result
  }
  const observation = observationFrom(parsePeekabooJson(result.value.stdout), now())
  return observation ?? { outcome: failed('I could not read that window.') }
}

function retryableSee(outcome: DesktopOutcome): boolean {
  return outcome.status === 'failed' && outcome.errorCode !== 'unavailable'
}

function isOutcome(
  result: { value: PeekabooResult } | { outcome: DesktopOutcome }
): result is { outcome: DesktopOutcome } {
  return 'outcome' in result
}

function isSeeFailure(
  result: DesktopObservation | { outcome: DesktopOutcome }
): result is { outcome: DesktopOutcome } {
  return 'outcome' in result
}

async function execute(
  run: PeekabooRunner,
  args: readonly string[],
  signal: AbortSignal | undefined
): Promise<{ value: PeekabooResult } | { outcome: DesktopOutcome }> {
  if (signal?.aborted) {
    return { outcome: cancelled() }
  }
  const result = await run(args, { signal })
  if (result.aborted || signal?.aborted) {
    return { outcome: cancelled() }
  }
  const problem = classify(result)
  return problem ? { outcome: problem } : { value: result }
}

function classify(result: PeekabooResult): DesktopOutcome | null {
  const blob = `${result.stderr}\n${result.stdout}`
  if (result.code === null && /ENOENT|not found|No such file/i.test(blob)) {
    return {
      status: 'failed',
      summary: 'Peekaboo is not installed. Install it, then try again.',
      errorCode: 'unavailable'
    }
  }
  const reported = commandError(result.stdout)
  if (result.code !== 0 || reported) {
    if (
      /permission denied|not authorized|needs.?permission|screen recording|event synthesizing/i.test(
        blob
      ) &&
      !/accessibility focus|accessibility value|accessibility element/i.test(blob)
    ) {
      return {
        status: 'needs_permission',
        summary:
          "I can't control that app until Peekaboo is allowed in Accessibility and Screen Recording.",
        errorCode: 'needs_permission'
      }
    }
    if (/Accessibility permission/i.test(blob)) {
      return {
        status: 'needs_permission',
        summary:
          "I can't control that app until Peekaboo is allowed in Accessibility and Screen Recording.",
        errorCode: 'needs_permission'
      }
    }
    return failed(reported || 'Peekaboo could not do that.')
  }
  return null
}

function commandError(stdout: string): string {
  try {
    const root = record(JSON.parse(stdout) as unknown)
    if (!root || root.success !== false) {
      return ''
    }
    const error = record(root.error)
    return text(error?.message).replace(/\s+/g, ' ').slice(0, 180)
  } catch {
    return ''
  }
}

function observationFrom(
  data: Record<string, unknown> | null,
  at: number
): DesktopObservation | null {
  if (!data) {
    return null
  }
  const snapshotId = text(data.snapshot_id) || text(data.snapshotId)
  const elements = Array.isArray(data.ui_elements)
    ? data.ui_elements
    : Array.isArray(data.elements)
      ? data.elements
      : []
  if (!snapshotId) {
    return null
  }
  const state = record(record(data.observation)?.state_snapshot)
  const targets = elements.flatMap((item) => {
    const target = targetFrom(item)
    return target ? [target] : []
  })
  return {
    snapshotId,
    capturedAtUtc: new Date(at).toISOString(),
    app: {
      name:
        text(data.application_name) ||
        text(data.app_name) ||
        text(data.appName) ||
        text(state?.frontmost_application_name) ||
        'App',
      bundleId:
        text(data.bundle_id) ||
        text(data.bundleId) ||
        text(state?.frontmost_bundle_identifier) ||
        undefined,
      processId: numberValue(data.pid)
    },
    window: {
      id: windowIdFrom(data),
      title: text(data.window_title) || text(data.title) || undefined
    },
    targets: targets.slice(0, 40),
    protected: false,
    truncated: elements.length > 40,
    imageIncluded: false
  }
}

function targetFrom(value: unknown): DesktopTarget | null {
  const item = record(value)
  if (!item) {
    return null
  }
  const id = text(item.id)
  const role = mapRole(text(item.ax_role) || text(item.role) || 'AXGroup')
  if (!id) {
    return null
  }
  const frame = record(item.bounds) ?? record(item.frame)
  return {
    id,
    role,
    name: text(item.label) || text(item.name) || 'control',
    enabled: typeof item.is_enabled === 'boolean' ? item.is_enabled : item.enabled !== false,
    ...(frame
      ? {
          bounds: {
            x: numberValue(frame.x) ?? 0,
            y: numberValue(frame.y) ?? 0,
            width: numberValue(frame.width) ?? 0,
            height: numberValue(frame.height) ?? 0
          }
        }
      : {})
  }
}

function mapRole(role: string): string {
  if (/web ?area|axwebarea|text ?area|axtextarea/i.test(role)) {
    return 'AXTextArea'
  }
  if (/text ?field|axtextfield/i.test(role)) {
    return 'AXTextField'
  }
  if (/combo|axcombobox/i.test(role)) {
    return 'AXComboBox'
  }
  return role
}

function readWindows(data: Record<string, unknown> | null): DesktopWindow[] | null {
  const windows = data && Array.isArray(data.windows) ? data.windows : null
  if (!windows) {
    return null
  }
  return windows.flatMap((item) => {
    const window = record(item)
    if (!window) {
      return []
    }
    const windowId = text(window.window_id) || text(window.id)
    if (!windowId) {
      return []
    }
    return [
      {
        windowId,
        appName: text(window.app_name) || text(window.app) || 'App',
        bundleId: text(window.bundle_id) || undefined,
        title: text(window.title) || text(window.window_title) || '',
        processId: numberValue(window.pid) ?? 0
      }
    ]
  })
}

function readOcr(data: Record<string, unknown> | null): string {
  if (!data) {
    return ''
  }
  const raw = text(data.ocr_text) || text(data.ocrText) || text(data.text)
  return redactSecretText(raw).trim().slice(0, 2_000)
}

function publicObservation(stored: StoredSnapshot, contextText: string): DesktopObservation {
  return {
    snapshotId: stored.snapshotId,
    capturedAtUtc: new Date(stored.at).toISOString(),
    app: {
      name: stored.appName,
      bundleId: stored.bundleId || undefined,
      processId: stored.processId
    },
    window: { id: stored.windowId, title: stored.windowTitle },
    targets: stored.targets,
    protected: false,
    truncated: false,
    imageIncluded: false,
    ...(contextText ? { contextText } : {})
  }
}

function requireTarget(
  snapshots: Map<string, StoredSnapshot>,
  input: DesktopElementInput,
  at: number,
  ttlMs: number
): { stored: StoredSnapshot; target: DesktopTarget } | DesktopOutcome {
  const stored = snapshots.get(input.snapshotId)
  if (!stored || at - stored.at > ttlMs) {
    return failed('That screen reading expired. I need to look again.')
  }
  const target = stored.targets.find((item) => item.id === input.targetId)
  if (!target) {
    return failed('That control is gone, so I did not use it.')
  }
  if (secretTarget(target)) {
    return {
      status: 'blocked_sensitive',
      summary: "I can't type into or press a password or security code.",
      errorCode: 'protected_context'
    }
  }
  return { stored, target }
}

function secretTarget(target: DesktopTarget): boolean {
  return /secure|password|passcode|pin/i.test(`${target.role} ${target.name}`)
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function windowIdFrom(data: Record<string, unknown>): string {
  const direct = text(data.window_id) || text(data.windowId)
  if (direct) {
    return direct
  }
  const contextWindow = record(record(data.coordinate_context)?.window)
  const fromContext = contextWindow ? text(contextWindow.window_id) : ''
  if (fromContext) {
    return fromContext
  }
  const target = record(record(data.observation)?.target)
  return target ? text(target.window_id) : ''
}

function text(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stopped(signal?: AbortSignal): DesktopOutcome | null {
  return signal?.aborted ? cancelled() : null
}

function cancelled(): DesktopOutcome {
  return { status: 'cancelled', summary: 'I stopped before that action.', errorCode: 'aborted' }
}

function failed(summary: string): DesktopOutcome {
  return { status: 'failed', summary, errorCode: 'failed' }
}
