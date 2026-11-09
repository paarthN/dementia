import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AgentApprovalGate } from '../src/main/agent/AgentApprovalGate'
import { FakeAgentProvider, runFakeAgent } from '../src/main/agent/AgentRunner'
import { AgentSessionController } from '../src/main/agent/AgentSessionController'
import { AuthorizedToolExecutor } from '../src/main/agent/AuthorizedToolExecutor'
import {
  createTaskScope,
  scopeCovers,
  scopeRequestFor,
  scopeableTool,
  taskScopeKey,
  type TaskScope
} from '../src/main/agent/security/TaskScope'
import { decidePolicy } from '../src/main/services/policyEngine'
import { createToolRegistry, type ToolContext } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'

const now = new Date('2026-11-08T20:00:00.000Z')

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-scope-')), 'test.sqlite'))
}

function notesScope(overrides: Partial<TaskScope> = {}): TaskScope {
  return {
    ...createTaskScope({
      taskId: 'task-1',
      request: { surface: 'desktop', bundleId: 'com.apple.Notes', appName: 'Notes' },
      now
    }),
    ...overrides
  }
}

function clickInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshotId: 'snap-1',
    targetId: 'node-0',
    windowId: '9',
    bundleId: 'com.apple.Notes',
    name: 'New Note',
    role: 'AXButton',
    ...overrides
  }
}

function decide(
  tool: string,
  input: Record<string, unknown>,
  scope: TaskScope | null
): ReturnType<typeof decidePolicy> {
  return decidePolicy(createToolRegistry(), {
    tool,
    input,
    source: 'user',
    now,
    screenPermission: true,
    scopeApproved: scopeCovers(scope, { taskId: 'task-1', tool, input, now })
  })
}

describe('task scope boundaries', () => {
  it('covers an ordinary click and type in the granted app', () => {
    const scope = notesScope()
    expect(decide('desktop.clickElement', clickInput(), scope).effect).toBe('allow')
    expect(
      decide('desktop.setText', clickInput({ role: 'AXTextArea', text: 'hello' }), scope).effect
    ).toBe('allow')
    expect(decide('desktop.keyPress', { chord: 'cmd+n', ...clickInput() }, scope).effect).toBe(
      'allow'
    )
    // Without the scope every one of those is a card.
    expect(decide('desktop.clickElement', clickInput(), null).effect).toBe('confirm')
  })

  it('does not cover a different app than the one granted', () => {
    const scope = notesScope()
    const mail = clickInput({ bundleId: 'com.apple.mail', name: 'Compose' })
    expect(
      scopeCovers(scope, { taskId: 'task-1', tool: 'desktop.clickElement', input: mail, now })
    ).toBe(false)
    expect(decide('desktop.clickElement', mail, scope).effect).toBe('confirm')
  })

  it('does not cover another task, an expired scope, or a browser scope used on the desktop', () => {
    const scope = notesScope()
    const input = clickInput()
    expect(scopeCovers(scope, { taskId: 'task-2', tool: 'desktop.clickElement', input, now })).toBe(
      false
    )
    expect(
      scopeCovers(notesScope({ expiresAtUtc: '2026-11-08T19:59:00.000Z' }), {
        taskId: 'task-1',
        tool: 'desktop.clickElement',
        input,
        now
      })
    ).toBe(false)
    const browserScope = createTaskScope({
      taskId: 'task-1',
      request: { surface: 'browser', appName: 'Agent Browser' },
      now
    })
    expect(
      scopeCovers(browserScope, { taskId: 'task-1', tool: 'desktop.clickElement', input, now })
    ).toBe(false)
    expect(
      scopeCovers(browserScope, {
        taskId: 'task-1',
        tool: 'browser.click',
        input: { snapshotId: 'snap', targetId: 't1', name: 'Show the note' },
        now
      })
    ).toBe(true)
  })

  it('still refuses send, buy, delete and upload under a scope', () => {
    const scope = createTaskScope({
      taskId: 'task-1',
      request: { surface: 'browser', appName: 'Agent Browser' },
      now
    })
    for (const name of ['Send', 'Buy', 'Delete', 'Upload', 'Pay', 'Submit']) {
      const decision = decide('browser.click', { snapshotId: 'snap', targetId: 't1', name }, scope)
      expect(decision, name).toMatchObject({ effect: 'deny', risk: 'R4' })
    }
  })

  it('still asks for an ambiguous label and a password field under a scope', () => {
    const scope = createTaskScope({
      taskId: 'task-1',
      request: { surface: 'browser', appName: 'Agent Browser' },
      now
    })
    expect(
      decide('browser.click', { snapshotId: 'snap', targetId: 't1', name: 'Continue' }, scope)
        .effect
    ).toBe('confirm')
    expect(
      decide(
        'browser.fill',
        { snapshotId: 'snap', targetId: 't1', name: 'Password', inputType: 'password', text: 'x' },
        scope
      )
    ).toMatchObject({ effect: 'deny', risk: 'R4' })
    expect(
      decide(
        'desktop.clickElement',
        clickInput({ name: 'OK', contextText: 'Complete your purchase' }),
        notesScope()
      )
    ).toMatchObject({ effect: 'deny', risk: 'R4' })
  })

  it('never covers a blind coordinate click or a tool with no app identity', () => {
    expect(scopeableTool('desktop.clickPoint')).toBe(false)
    expect(scopeableTool('ui.press')).toBe(false)
    expect(scopeRequestFor('desktop.clickPoint', clickInput())).toBeNull()
    expect(
      decide(
        'desktop.clickPoint',
        { snapshotId: 'snap-1', windowId: '9', x: 10, y: 20 },
        notesScope()
      ).effect
    ).toBe('confirm')
    expect(decide('ui.press', { name: 'New Note' }, notesScope()).effect).toBe('confirm')
  })

  it('needs a bundle id before it can offer a desktop scope', () => {
    expect(scopeRequestFor('desktop.clickElement', clickInput({ bundleId: '' }))).toBeNull()
    expect(scopeRequestFor('desktop.setText', clickInput())).toMatchObject({
      surface: 'desktop',
      bundleId: 'com.apple.Notes'
    })
  })

  it('gives every surface a distinct key, so one grant never shadows another', () => {
    const browser = taskScopeKey({ surface: 'browser' })
    const notes = taskScopeKey({ surface: 'desktop', bundleId: 'com.apple.Notes' })
    const mail = taskScopeKey({ surface: 'desktop', bundleId: 'com.apple.mail' })
    expect(new Set([browser, notes, mail]).size).toBe(3)
  })
})

describe('one card for the whole task', () => {
  it('asks once, then types and clicks again without another card', async () => {
    const asked: string[] = []
    const acted: string[] = []
    const gate = new AgentApprovalGate()
    const session = new AgentSessionController()
    const context = (signal: AbortSignal): ToolContext => ({
      db: database(),
      run: async () => 0,
      now: () => now,
      timeZone: 'UTC',
      screenPermission: true,
      allowedBundleIds: () => ['com.apple.Notes'],
      signal,
      desktop: {
        async listWindows() {
          return { status: 'success_verified', summary: 'one', windows: [] }
        },
        async focusWindow() {
          return { status: 'success_verified', summary: 'focused' }
        },
        async observe() {
          return {
            status: 'success_verified',
            summary: 'I am looking at Notes.',
            observation: {
              snapshotId: 'snap-1',
              capturedAtUtc: now.toISOString(),
              app: { name: 'Notes', bundleId: 'com.apple.Notes', processId: 7 },
              window: { id: '9', title: 'Untitled' },
              targets: [{ id: 'node-0', role: 'AXTextArea', name: 'Note', enabled: true }],
              protected: false,
              truncated: false,
              imageIncluded: false
            }
          }
        },
        async clickElement(input) {
          acted.push(`click:${input.name}`)
          return { status: 'success_verified', summary: `I pressed ${input.name}.` }
        },
        async setText(input) {
          acted.push(`type:${input.text}`)
          return { status: 'success_verified', summary: `I typed into ${input.name}.` }
        },
        async keyPress() {
          return { status: 'success_verified', summary: 'I pressed the key.' }
        },
        async scroll() {
          return { status: 'failed', summary: 'unused' }
        },
        async clickPoint() {
          return { status: 'failed', summary: 'unused' }
        }
      }
    })

    const run = runFakeAgent({
      goal: 'Write a note in Notes',
      provider: new FakeAgentProvider([
        {
          type: 'tool_call',
          tool: 'task.setGoalChecks',
          args: {
            checks: [
              {
                id: 'typed',
                label: 'The note says hello',
                allTools: ['desktop.setText'],
                textIncludes: 'hello'
              }
            ]
          }
        },
        { type: 'tool_call', tool: 'desktop.clickElement', args: clickInput({ name: 'Note' }) },
        {
          type: 'tool_call',
          tool: 'desktop.setText',
          args: clickInput({ role: 'AXTextArea', name: 'Note', text: 'hello' })
        },
        { type: 'final', text: 'The note says hello.' }
      ]),
      executor: new AuthorizedToolExecutor(createToolRegistry()),
      session,
      context,
      now: () => now,
      observe: () => ({
        snapshotId: 'snap-1',
        appName: 'Notes',
        capturedAtUtc: now.toISOString(),
        untrustedText: acted.join(' ')
      }),
      onStatus: (status) => {
        if (status.approval) {
          asked.push(status.approval.confirmLabel)
        }
      },
      waitForApproval: (approval, signal) => gate.wait(approval, signal)
    })

    await waitUntil(() => asked.length > 0)
    expect(asked[0]).toBe('Allow in Notes')
    expect(acted).toEqual([])
    const taskId = session.activeId() ?? ''
    const held = gate.current()
    gate.confirm(taskId, held?.approvalId ?? '', null)

    const outcome = await run
    // One card covered both mutations.
    expect(asked).toEqual(['Allow in Notes'])
    expect(acted).toEqual(['click:Note', 'type:hello'])
    expect(outcome.actionOutcome).toBe('success_verified')
  })
})

describe('a task spanning two surfaces', () => {
  it('asks once for Agent Browser and once more for Notes, not once for the whole task', async () => {
    const asked: string[] = []
    const acted: string[] = []
    const gate = new AgentApprovalGate()
    const session = new AgentSessionController()
    const context = (signal: AbortSignal): ToolContext => ({
      db: database(),
      run: async () => 0,
      now: () => now,
      timeZone: 'UTC',
      screenPermission: true,
      allowedBundleIds: () => ['com.apple.Notes'],
      signal,
      browser: {
        isOpen: () => true,
        async launch() {
          return { status: 'success_verified', summary: 'open' }
        },
        async open() {
          return { status: 'success_verified', summary: 'opened' }
        },
        async observe() {
          return { status: 'success_verified', summary: 'looking' }
        },
        async click(input) {
          acted.push(`browser-click:${input.name}`)
          return { status: 'success_verified', summary: `I pressed ${input.name}.` }
        },
        async fill() {
          return { status: 'failed', summary: 'unused' }
        },
        async press() {
          return { status: 'failed', summary: 'unused' }
        },
        async scroll() {
          return { status: 'failed', summary: 'unused' }
        },
        async back() {
          return { status: 'failed', summary: 'unused' }
        },
        async listTabs() {
          return { status: 'success_verified', summary: 'one tab', tabs: [] }
        },
        async selectTab() {
          return { status: 'failed', summary: 'unused' }
        },
        async close() {
          return { status: 'success_verified', summary: 'closed' }
        }
      },
      desktop: {
        async listWindows() {
          return { status: 'success_verified', summary: 'one', windows: [] }
        },
        async focusWindow() {
          return { status: 'success_verified', summary: 'focused' }
        },
        async observe() {
          return {
            status: 'success_verified',
            summary: 'I am looking at Notes.',
            observation: {
              snapshotId: 'snap-notes',
              capturedAtUtc: now.toISOString(),
              app: { name: 'Notes', bundleId: 'com.apple.Notes', processId: 7 },
              window: { id: '9', title: 'Untitled' },
              targets: [{ id: 'node-0', role: 'AXTextArea', name: 'Note', enabled: true }],
              protected: false,
              truncated: false,
              imageIncluded: false
            }
          }
        },
        async clickElement(input) {
          acted.push(`desktop-click:${input.name}`)
          return { status: 'success_verified', summary: `I pressed ${input.name}.` }
        },
        async setText(input) {
          acted.push(`desktop-type:${input.text}`)
          return { status: 'success_verified', summary: `I typed into ${input.name}.` }
        },
        async keyPress() {
          return { status: 'success_verified', summary: 'I pressed the key.' }
        },
        async scroll() {
          return { status: 'failed', summary: 'unused' }
        },
        async clickPoint() {
          return { status: 'failed', summary: 'unused' }
        }
      }
    })

    const run = runFakeAgent({
      goal: 'Find a page in Agent Browser, then write what it said in Notes',
      provider: new FakeAgentProvider([
        {
          type: 'tool_call',
          tool: 'task.setGoalChecks',
          args: {
            checks: [
              {
                id: 'typed',
                label: 'The note says hello',
                allTools: ['desktop.setText'],
                textIncludes: 'hello'
              }
            ]
          }
        },
        {
          type: 'tool_call',
          tool: 'browser.click',
          args: { snapshotId: 'snap-b', targetId: 't1', name: 'Show the note' }
        },
        {
          type: 'tool_call',
          tool: 'browser.click',
          args: { snapshotId: 'snap-b', targetId: 't2', name: 'Copy' }
        },
        {
          type: 'tool_call',
          tool: 'desktop.clickElement',
          args: clickInput({ name: 'Note' })
        },
        {
          type: 'tool_call',
          tool: 'desktop.setText',
          args: clickInput({ role: 'AXTextArea', name: 'Note', text: 'hello' })
        },
        { type: 'final', text: 'The note says hello.' }
      ]),
      executor: new AuthorizedToolExecutor(createToolRegistry()),
      session,
      context,
      now: () => now,
      observe: () => ({
        snapshotId: 'snap-loop',
        appName: 'Notes',
        capturedAtUtc: now.toISOString(),
        untrustedText: acted.join(' ')
      }),
      onStatus: (status) => {
        if (status.approval) {
          asked.push(status.approval.confirmLabel)
        }
      },
      waitForApproval: (approval, signal) => gate.wait(approval, signal)
    })

    // First card: Agent Browser.
    await waitUntil(() => asked.length === 1)
    expect(asked).toEqual(['Allow in Agent Browser'])
    expect(acted).toEqual([])
    let taskId = session.activeId() ?? ''
    let held = gate.current()
    gate.confirm(taskId, held?.approvalId ?? '', null)

    // Switching to Notes needs its own card — this is the behavior this test exists
    // for. A single-slot scope would silently skip straight to per-click confirmation
    // here instead of offering one more task-wide grant. Both browser clicks run under
    // the first card alone, with no second ask for either of them.
    await waitUntil(() => asked.length === 2)
    expect(asked).toEqual(['Allow in Agent Browser', 'Allow in Notes'])
    expect(acted).toEqual(['browser-click:Show the note', 'browser-click:Copy'])
    taskId = session.activeId() ?? ''
    held = gate.current()
    gate.confirm(taskId, held?.approvalId ?? '', null)

    const outcome = await run
    // Exactly two cards for the whole task: one per surface, not one overall and not
    // one per click.
    expect(asked).toEqual(['Allow in Agent Browser', 'Allow in Notes'])
    expect(acted).toEqual([
      'browser-click:Show the note',
      'browser-click:Copy',
      'desktop-click:Note',
      'desktop-type:hello'
    ])
    expect(outcome.actionOutcome).toBe('success_verified')
  })
})

async function waitUntil(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting')
}
