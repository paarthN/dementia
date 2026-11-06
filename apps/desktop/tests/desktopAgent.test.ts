import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AuthorizedToolExecutor,
  type AuthorizedCall
} from '../src/main/agent/AuthorizedToolExecutor'
import { createNativeMacAdapter } from '../src/main/agent/ports/NativeMacAdapter'
import type {
  DesktopAutomationPort,
  DesktopElementInput
} from '../src/main/agent/ports/DesktopAutomationPort'
import { desktopToolDefinitions } from '../src/main/agent/tools/desktopTools'
import { createMacOsBridge, HelperCallError, type OsBridge } from '../src/main/services/osBridge'
import { createToolRegistry, type ToolContext } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'
import { canonicalJson } from '../src/shared/agent'

const noteText = 'Hello from Companion'

function windowBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    windowId: '42',
    processId: 100,
    bundleId: 'com.apple.TextEdit',
    appName: 'TextEdit',
    title: 'Untitled',
    protected: false,
    truncated: false,
    targets: [
      {
        id: 'node-0',
        role: 'AXButton',
        name: 'Save',
        enabled: true,
        bounds: null
      }
    ],
    ...overrides
  }
}

function scriptedBridge(
  respond: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<unknown> | unknown
): { bridge: OsBridge; calls: string[] } {
  const calls: string[] = []
  const bridge: OsBridge = {
    async request(method, params = {}, options) {
      calls.push(method)
      if (options?.signal?.aborted) {
        throw new HelperCallError('aborted', 'Screen access has stopped.', false)
      }
      return respond(method, params, options?.signal)
    },
    close() {
      return undefined
    }
  }
  return { bridge, calls }
}

function elementFrom(outcome: {
  observation?: {
    snapshotId: string
    window: { id: string }
    app: { bundleId?: string }
    targets: Array<{ id: string; name: string; role: string }>
  }
}): DesktopElementInput {
  const observation = outcome.observation
  const target = observation?.targets[0]
  if (!observation || !target || !observation.app.bundleId) {
    throw new Error('missing observation')
  }
  return {
    snapshotId: observation.snapshotId,
    targetId: target.id,
    windowId: observation.window.id,
    bundleId: observation.app.bundleId,
    name: target.name,
    role: target.role
  }
}

describe('native Mac desktop adapter', () => {
  it('refuses a stale snapshot without clicking', async () => {
    let time = 1_000
    const { bridge, calls } = scriptedBridge(() => windowBody())
    const adapter = createNativeMacAdapter({ bridge, now: () => time, ttlMs: 3_000 })
    const seen = await adapter.observe({})
    time = 5_000
    const clicked = await adapter.clickElement(elementFrom(seen))
    expect(clicked).toMatchObject({ status: 'unsupported', errorCode: 'stale_snapshot' })
    expect(calls).toEqual(['desktop.observe'])
  })

  it('refuses a click when the window changes before the action', async () => {
    let reads = 0
    const { bridge, calls } = scriptedBridge((method) => {
      if (method !== 'desktop.observe') {
        return { acted: true }
      }
      reads += 1
      return reads === 1 ? windowBody() : windowBody({ windowId: '99', processId: 200 })
    })
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    const clicked = await adapter.clickElement(elementFrom(seen))
    expect(clicked).toMatchObject({ status: 'failed', errorCode: 'focus_changed' })
    expect(calls).not.toContain('desktop.clickElement')
  })

  it('does not click when two controls share a name', async () => {
    const { bridge, calls } = scriptedBridge(() =>
      windowBody({
        targets: [
          { id: 'node-0', role: 'AXButton', name: 'Save', enabled: true, bounds: null },
          { id: 'node-1', role: 'AXButton', name: 'Save', enabled: true, bounds: null }
        ]
      })
    )
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    const clicked = await adapter.clickElement(elementFrom(seen))
    expect(clicked.status).toBe('ambiguous_target')
    expect(calls).not.toContain('desktop.clickElement')
  })

  it('does not click a disabled control', async () => {
    const { bridge, calls } = scriptedBridge(() =>
      windowBody({
        targets: [{ id: 'node-0', role: 'AXButton', name: 'Save', enabled: false, bounds: null }]
      })
    )
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    const clicked = await adapter.clickElement(elementFrom(seen))
    expect(clicked).toMatchObject({ status: 'failed', errorCode: 'disabled' })
    expect(calls).not.toContain('desktop.clickElement')
  })

  it('does not act on a protected window', async () => {
    const { bridge, calls } = scriptedBridge(() => windowBody({ protected: true, targets: [] }))
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    expect(seen.status).toBe('blocked_sensitive')
    const clicked = await adapter.clickElement({
      ...elementFrom({
        observation: {
          snapshotId: seen.observation?.snapshotId ?? '',
          window: { id: '42' },
          app: { bundleId: 'com.apple.TextEdit' },
          targets: [{ id: 'node-0', name: 'Save', role: 'AXButton' }]
        }
      })
    })
    expect(clicked.status).toBe('blocked_sensitive')
    expect(calls).not.toContain('desktop.clickElement')
    expect(calls).not.toContain('desktop.setText')
  })

  it('types only into the named text control and checks the text afterward', async () => {
    let reads = 0
    const { bridge, calls } = scriptedBridge((method) => {
      if (method === 'desktop.setText') {
        return { acted: true, verified: true }
      }
      reads += 1
      const value = reads < 3 ? '' : noteText
      return windowBody({
        targets: [
          {
            id: 'node-0',
            role: 'AXTextArea',
            name: 'Note',
            enabled: true,
            value,
            bounds: null
          }
        ]
      })
    })
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    const typed = await adapter.setText({ ...elementFrom(seen), text: noteText })
    expect(typed.status).toBe('success_verified')
    expect(JSON.stringify(typed)).not.toContain(noteText)
    expect(calls.filter((method) => method === 'desktop.setText')).toEqual(['desktop.setText'])
  })

  it('does not type into a button or send a key that is not on the list', async () => {
    const { bridge, calls } = scriptedBridge(() => windowBody())
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    const typed = await adapter.setText({ ...elementFrom(seen), text: 'nope' })
    const keyed = await adapter.keyPress({
      chord: 'command+q',
      windowId: '42',
      bundleId: 'com.apple.TextEdit',
      processId: 100
    })
    const scrolled = await adapter.scroll({
      direction: 'down',
      amount: 9,
      windowId: '42',
      bundleId: 'com.apple.TextEdit',
      processId: 100
    })
    expect(typed).toMatchObject({ status: 'unsupported', errorCode: 'not_allowlisted' })
    expect(keyed).toMatchObject({ status: 'failed', errorCode: 'not_allowlisted' })
    expect(scrolled).toMatchObject({ status: 'failed', errorCode: 'not_allowlisted' })
    expect(calls).toEqual(['desktop.observe'])
  })

  it('does not start a click that was already stopped', async () => {
    const { bridge, calls } = scriptedBridge(() => windowBody())
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const signal = new AbortController()
    signal.abort()
    const clicked = await adapter.clickElement(
      {
        snapshotId: 'missing',
        targetId: 'node-0',
        windowId: '42',
        bundleId: 'com.apple.TextEdit',
        name: 'Save',
        role: 'AXButton'
      },
      { signal: signal.signal }
    )
    expect(clicked.status).toBe('cancelled')
    expect(calls).toEqual([])
  })

  it('does not send a second action after an aborted type', async () => {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted
    })
    const { bridge, calls } = scriptedBridge((method, _params, signal) => {
      if (method !== 'desktop.setText') {
        return windowBody({
          targets: [
            {
              id: 'node-0',
              role: 'AXTextArea',
              name: 'Note',
              enabled: true,
              value: '',
              bounds: null
            }
          ]
        })
      }
      markStarted()
      return new Promise((_resolve, reject) => {
        const fail = (): void => {
          reject(new HelperCallError('aborted', 'Screen access has stopped.', true))
        }
        if (signal?.aborted) {
          fail()
          return
        }
        signal?.addEventListener('abort', fail, { once: true })
      })
    })
    const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
    const seen = await adapter.observe({})
    const signal = new AbortController()
    const pending = adapter.setText(
      { ...elementFrom(seen), text: noteText },
      { signal: signal.signal }
    )
    await started
    signal.abort()
    await expect(pending).resolves.toMatchObject({ status: 'uncertain_after_timeout' })
    const again = await adapter.setText({ ...elementFrom(seen), text: noteText })
    expect(again.status).toBe('uncertain_after_timeout')
    expect(calls.filter((method) => method === 'desktop.setText')).toEqual(['desktop.setText'])
  })

  it('reads a mock JSONL helper', async () => {
    const fixture = resolve(__dirname, 'fixtures/jsonl-desktop.mjs')
    const bridge = createMacOsBridge({ command: process.execPath, args: [fixture] })
    try {
      const adapter = createNativeMacAdapter({ bridge, now: () => 1_000 })
      const listed = await adapter.listWindows({ bundleId: 'com.apple.TextEdit' })
      const seen = await adapter.observe({})
      expect(listed.windows?.[0]).toMatchObject({ appName: 'TextEdit', windowId: '42' })
      expect(seen.observation?.targets[0]?.role).toBe('AXTextArea')
      expect(seen.observation?.imageIncluded).toBe(false)
    } finally {
      bridge.close()
    }
  })
})

describe('helper abort and allowlist', () => {
  it('rejects an unknown helper method before starting a process', async () => {
    const bridge = createMacOsBridge({ command: '/nonexistent/companion-helper' })
    await expect(bridge.request('osascript', { command: 'say hi' })).rejects.toMatchObject({
      code: 'unknown_method'
    })
    bridge.close()
  })

  it('does not send a timed-out request again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'companion-hang-'))
    const log = join(directory, 'methods.log')
    const bridge = createMacOsBridge({
      command: process.execPath,
      args: [resolve(__dirname, 'fixtures/jsonl-hang.mjs'), log]
    })
    await expect(bridge.request('system.ping', {}, { timeoutMs: 200 })).rejects.toMatchObject({
      code: 'timeout'
    })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    const methods = readFileSync(log, 'utf8').trim().split('\n')
    expect(methods.filter((method) => method === 'system.ping')).toEqual(['system.ping'])
    bridge.close()
  })

  it('does not repeat a click after the helper crashes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'companion-click-'))
    const log = join(directory, 'methods.log')
    const bridge = createMacOsBridge({
      command: process.execPath,
      args: [resolve(__dirname, 'fixtures/jsonl-click-crash.mjs'), log]
    })
    await expect(
      bridge.request('desktop.clickElement', { name: 'Save' }, { timeoutMs: 1_000 })
    ).rejects.toBeInstanceOf(Error)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['desktop.clickElement'])
    bridge.close()
  })
})

describe('desktop tool authorization', () => {
  it('asks before a click and keeps the typed text out of the tool result', async () => {
    const calls: string[] = []
    const desktop = {
      async setText(input: { text: string }) {
        calls.push(input.text)
        return {
          status: 'success_verified' as const,
          summary: 'I typed into Note.'
        }
      },
      async clickElement() {
        calls.push('click')
        return { status: 'success_verified' as const, summary: 'I pressed the control.' }
      }
    } as unknown as DesktopAutomationPort
    const signal = new AbortController().signal
    const context = {
      db: openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-desktop-')), 'test.sqlite')),
      run: async () => 0,
      now: () => new Date('2026-11-05T20:00:00.000Z'),
      timeZone: 'UTC',
      screenPermission: true,
      allowedBundleIds: () => [],
      signal,
      desktop
    } satisfies ToolContext
    const executor = new AuthorizedToolExecutor(createToolRegistry())
    const clickInput = {
      snapshotId: 'snap',
      targetId: 'node-0',
      windowId: '42',
      bundleId: 'com.apple.TextEdit',
      name: 'Save',
      role: 'AXButton'
    }
    const preview = await executor.execute(
      desktopCall({
        tool: 'desktop.clickElement',
        input: clickInput,
        context,
        signal
      })
    )
    expect(preview).toMatchObject({ kind: 'confirm' })
    expect(calls).toEqual([])

    const textInput = { ...clickInput, name: 'Note', role: 'AXTextArea', text: noteText }
    const typed = await executor.execute(
      desktopCall({
        tool: 'desktop.setText',
        input: textInput,
        context,
        signal,
        screenPermission: true,
        approval: {
          taskId: 'task-1',
          tool: 'desktop.setText',
          payloadJson: canonicalJson(textInput),
          expiresAtUtc: '2026-11-05T20:10:00.000Z'
        },
        liveTarget: {
          name: 'Note',
          role: 'AXTextArea',
          appName: '',
          windowId: '42',
          observationId: 'snap'
        }
      })
    )
    expect(typed.kind).toBe('result')
    if (typed.kind === 'result') {
      expect(JSON.stringify(typed.result)).not.toContain(noteText)
      expect(typed.result.verification?.passed).toBe(true)
    }
    expect(calls).toEqual([noteText])
    expect(desktopToolDefinitions().some((tool) => tool.name === 'shell')).toBe(false)
  })
})

function desktopCall(overrides: Partial<AuthorizedCall> & { tool: string }): AuthorizedCall {
  const signal = overrides.signal ?? new AbortController().signal
  const { tool, ...rest } = overrides
  return {
    taskId: 'task-1',
    tool,
    input: rest.input ?? {},
    source: rest.source ?? 'user',
    now: new Date('2026-11-05T20:00:00.000Z'),
    screenPermission: rest.screenPermission ?? true,
    approval: rest.approval ?? null,
    ...(rest.liveTarget ? { liveTarget: rest.liveTarget } : {}),
    signal,
    timeoutMs: rest.timeoutMs ?? 1000,
    deadlineAtMs: Date.parse('2026-11-05T21:00:00.000Z'),
    taskOwned: rest.taskOwned ?? true,
    context: rest.context ?? {
      db: openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-desktop-')), 'test.sqlite')),
      run: async () => 0,
      now: () => new Date('2026-11-05T20:00:00.000Z'),
      timeZone: 'UTC',
      screenPermission: true,
      allowedBundleIds: () => [],
      signal
    }
  }
}
