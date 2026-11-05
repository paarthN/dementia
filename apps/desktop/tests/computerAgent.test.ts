import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { defaultAgentBudget } from '../src/main/agent/AgentBudget'
import { AgentSessionController } from '../src/main/agent/AgentSessionController'
import { transitionAgentState } from '../src/main/agent/AgentStateMachine'
import {
  AuthorizedToolExecutor,
  type AuthorizedCall
} from '../src/main/agent/AuthorizedToolExecutor'
import { FakeAgentProvider, runFakeAgent } from '../src/main/agent/AgentRunner'
import { TaskOrchestrator } from '../src/main/services/taskOrchestrator'
import type { ToolContext, ToolDefinition } from '../src/main/services/toolRegistry'
import { createToolRegistry } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'
import { canonicalJson } from '../src/shared/agent'
import { actionOutcomeSchema, computerAgentStateSchema } from '../src/shared/computerAgent'

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-agent-')), 'test.sqlite'))
}

function context(
  signal = new AbortController().signal,
  run: ToolContext['run'] = async () => 0
): ToolContext {
  return {
    db: database(),
    run,
    now: () => new Date('2026-11-05T20:00:00.000Z'),
    timeZone: 'UTC',
    screenPermission: false,
    allowedBundleIds: () => [],
    signal
  }
}

function call(overrides: Partial<AuthorizedCall> = {}): AuthorizedCall {
  const signal = overrides.signal ?? new AbortController().signal
  return {
    taskId: 'task-1',
    tool: 'apps.open',
    input: { displayName: 'TextEdit', bundleId: 'com.apple.TextEdit' },
    source: 'user',
    now: new Date('2026-11-05T20:00:00.000Z'),
    screenPermission: false,
    approval: null,
    signal,
    timeoutMs: 1000,
    deadlineAtMs: Date.parse('2026-11-05T21:00:00.000Z'),
    taskOwned: true,
    context: context(signal),
    ...overrides
  }
}

describe('computer-use agent foundation', () => {
  it('rejects an unknown agent state and keeps outcome names distinct', () => {
    expect(computerAgentStateSchema.safeParse('running').success).toBe(false)
    expect(actionOutcomeSchema.safeParse('uncertain_after_timeout').success).toBe(true)
    expect(actionOutcomeSchema.safeParse('success').success).toBe(false)
  })

  it('follows the observe, act, and verify transitions', () => {
    let state = transitionAgentState('idle', 'start')
    expect(state).toEqual({ ok: true, state: 'observing' })
    state = transitionAgentState('observing', 'observed')
    state = transitionAgentState(state.ok ? state.state : 'idle', 'begin_execution')
    state = transitionAgentState(state.ok ? state.state : 'idle', 'executed')
    state = transitionAgentState(state.ok ? state.state : 'idle', 'verified_continue')
    expect(state).toEqual({ ok: true, state: 'observing' })
    expect(transitionAgentState('executing', 'stop')).toMatchObject({
      ok: false,
      state: 'executing'
    })
    expect(transitionAgentState('observing', 'pause')).toEqual({ ok: true, state: 'paused' })
    expect(transitionAgentState('paused', 'resume')).toEqual({ ok: true, state: 'observing' })
    expect(transitionAgentState('completed', 'start').ok).toBe(false)
  })

  it('refuses an unknown tool, an R4 tool, a stale approval, and the wrong task', async () => {
    const started: string[] = []
    const executor = new AuthorizedToolExecutor(createToolRegistry())
    const track = (name: string): void => {
      started.push(name)
    }

    const unknown = await executor.execute(
      call({ tool: 'widgets.spin', input: {}, onStart: track })
    )
    expect(unknown).toMatchObject({ kind: 'denied', summary: "I can't do that." })

    const blocked = await executor.execute(
      call({ tool: 'payments.transfer', input: {}, onStart: track })
    )
    expect(blocked).toMatchObject({
      kind: 'denied',
      risk: 'R4',
      summary: "I can't do that automatically. I can explain the safe choice instead."
    })

    const input = { to: 'a@example.com' }
    const stale = await executor.execute(
      call({
        tool: 'mail.send',
        input,
        onStart: track,
        approval: {
          taskId: 'task-1',
          tool: 'mail.send',
          payloadJson: canonicalJson(input),
          expiresAtUtc: '2026-11-05T19:00:00.000Z'
        }
      })
    )
    expect(stale.kind).toBe('denied')

    const wrongPayload = await executor.execute(
      call({
        tool: 'mail.send',
        input: { to: 'other@example.com' },
        onStart: track,
        approval: {
          taskId: 'task-1',
          tool: 'mail.send',
          payloadJson: canonicalJson(input),
          expiresAtUtc: '2026-11-05T20:10:00.000Z'
        }
      })
    )
    expect(wrongPayload.kind).toBe('denied')

    const wrongTask = await executor.execute(
      call({
        tool: 'mail.send',
        input,
        taskOwned: false,
        onStart: track,
        approval: {
          taskId: 'other-task',
          tool: 'mail.send',
          payloadJson: canonicalJson(input),
          expiresAtUtc: '2026-11-05T20:10:00.000Z'
        }
      })
    )
    expect(wrongTask).toMatchObject({
      kind: 'denied',
      summary: 'That request does not match the active task.'
    })
    expect(started).toEqual([])
  })

  it('does not start work that was cancelled before the call', async () => {
    const started: string[] = []
    const signal = new AbortController()
    signal.abort()
    const report = await new AuthorizedToolExecutor(createToolRegistry()).execute(
      call({ signal: signal.signal, onStart: (name) => started.push(name) })
    )
    expect(report.kind).toBe('cancelled')
    expect(started).toEqual([])
  })

  it('treats a timeout or abort during a tool as uncertain and blocks the next action', async () => {
    const started: string[] = []
    const hang: ToolDefinition = {
      name: 'test.hang',
      risk: 'R1',
      execute: () => new Promise(() => undefined)
    }
    const note: ToolDefinition = {
      name: 'test.note',
      risk: 'R1',
      async execute() {
        started.push('note')
        return {
          status: 'succeeded' as const,
          summary: 'Typed buy milk.',
          verification: { method: 'local_state' as const, passed: true }
        }
      }
    }
    const executor = new AuthorizedToolExecutor(createToolRegistry([hang, note]))
    const signal = new AbortController()
    let sawStart: () => void = () => undefined
    const startedGate = new Promise<void>((resolve) => {
      sawStart = resolve
    })
    const hanging = executor.execute(
      call({
        tool: 'test.hang',
        input: {},
        signal: signal.signal,
        timeoutMs: 50,
        onStart: () => {
          started.push('hang')
          sawStart()
        }
      })
    )
    await startedGate
    signal.abort()
    const aborted = await hanging
    expect(aborted).toMatchObject({ kind: 'uncertain', actionOutcome: 'uncertain_after_timeout' })
    const again = await executor.execute(call({ tool: 'test.note', input: { text: 'buy milk' } }))
    expect(again.kind).toBe('uncertain')
    expect(started).toEqual(['hang'])
  })

  it('does not run a second mutating action while one is in flight', async () => {
    let release: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      release = resolve
    })
    const executor = new AuthorizedToolExecutor(
      createToolRegistry([
        {
          name: 'test.hold',
          risk: 'R1',
          async execute() {
            release()
            await new Promise(() => undefined)
            return {
              status: 'succeeded' as const,
              summary: 'Held.',
              verification: { method: 'local_state' as const, passed: true }
            }
          }
        }
      ])
    )
    const first = executor.execute(call({ tool: 'test.hold', input: {}, timeoutMs: 30 }))
    await entered
    const second = await executor.execute(call({ tool: 'apps.open' }))
    expect(second).toMatchObject({ kind: 'denied', summary: 'Another action is still running.' })
    const outcome = await first
    expect(outcome.kind).toBe('uncertain')
  })

  it('stops a timed-out orchestrator step before the next tool', async () => {
    const started: string[] = []
    const outcome = await new TaskOrchestrator({
      db: database(),
      timeoutMs: 20,
      run: async () => 0,
      onTool: (name) => started.push(name),
      extraTools: [
        {
          name: 'test.hang',
          risk: 'R1',
          execute: () => new Promise(() => undefined)
        }
      ]
    }).runPlanned('two', [
      { tool: 'test.hang', input: {} },
      { tool: 'browser.search', input: { query: 'later' } }
    ])
    expect(outcome.actionOutcome).toBe('uncertain_after_timeout')
    expect(outcome.summary.toLowerCase()).not.toContain('searched')
    expect(started).toEqual(['test.hang'])
  })

  it('runs a scripted open, observation, action, and verified finish', async () => {
    const commands: string[][] = []
    const tools: string[] = []
    const session = new AgentSessionController()
    const provider = new FakeAgentProvider([
      {
        type: 'tool_call',
        tool: 'apps.open',
        args: { displayName: 'TextEdit', bundleId: 'com.apple.TextEdit' }
      },
      { type: 'tool_call', tool: 'test.note', args: { text: 'buy milk' } },
      { type: 'final', text: 'The note is ready.' }
    ])
    const outcome = await runFakeAgent({
      goal: 'Open TextEdit and type buy milk',
      provider,
      session,
      executor: new AuthorizedToolExecutor(
        createToolRegistry([
          {
            name: 'test.note',
            risk: 'R1',
            async execute(input) {
              tools.push(`note:${String(input.text)}`)
              return {
                status: 'succeeded',
                summary: 'Typed buy milk.',
                verification: { method: 'local_state', passed: true }
              }
            }
          }
        ])
      ),
      context: (signal) =>
        context(signal, async (_command, args) => {
          commands.push(args)
          return 0
        }),
      now: () => new Date('2026-11-05T20:00:00.000Z')
    })

    expect(commands).toEqual([['-b', 'com.apple.TextEdit']])
    expect(tools).toEqual(['note:buy milk'])
    expect(outcome.state).toBe('completed')
    expect(outcome.actionOutcome).toBe('success_verified')
    expect(outcome.summary).toBe('The note is ready.')
    expect(outcome.progress.map((step) => step.state)).toEqual([
      'observing',
      'planning',
      'executing',
      'verifying',
      'observing',
      'planning',
      'executing',
      'verifying',
      'observing',
      'planning',
      'completed'
    ])
    expect(outcome.progress.some((step) => step.summary.includes('screen.capture'))).toBe(false)
    expect(session.begin('next').ok).toBe(true)
  })

  it('does not call a finished task complete when nothing was verified', async () => {
    const outcome = await runFakeAgent({
      goal: 'Claim success',
      provider: new FakeAgentProvider([{ type: 'final', text: 'Done.' }]),
      session: new AgentSessionController(),
      executor: new AuthorizedToolExecutor(createToolRegistry()),
      context: (signal) => context(signal)
    })
    expect(outcome.state).toBe('failed')
    expect(outcome.actionOutcome).toBe('changed_but_unverified')
    expect(outcome.summary).toBe('I could not verify that the task was finished.')
  })

  it('stops at the action budget and after repeated identical failures', async () => {
    const started: string[] = []
    const tool: ToolDefinition = {
      name: 'test.note',
      risk: 'R1',
      async execute() {
        started.push('note')
        return {
          status: 'failed',
          summary: 'The field did not change.',
          verification: { method: 'local_state', passed: false }
        }
      }
    }
    const budgetRun = await runFakeAgent({
      goal: 'Too many',
      provider: new FakeAgentProvider([
        { type: 'tool_call', tool: 'test.note', args: { text: 'one' } },
        { type: 'tool_call', tool: 'test.note', args: { text: 'two' } }
      ]),
      session: new AgentSessionController(),
      executor: new AuthorizedToolExecutor(createToolRegistry([tool])),
      context: (signal) => context(signal),
      budget: { ...defaultAgentBudget, maxActions: 1 }
    })
    expect(budgetRun.state).toBe('partial')
    expect(started).toEqual(['note'])

    started.length = 0
    const repeated = await runFakeAgent({
      goal: 'Repeat',
      provider: new FakeAgentProvider([
        { type: 'tool_call', tool: 'test.note', args: { text: 'same' } },
        { type: 'tool_call', tool: 'test.note', args: { text: 'same' } },
        { type: 'tool_call', tool: 'test.note', args: { text: 'same' } }
      ]),
      session: new AgentSessionController(),
      executor: new AuthorizedToolExecutor(createToolRegistry([tool])),
      context: (signal) => context(signal),
      budget: { ...defaultAgentBudget, maxIdenticalFailures: 2 }
    })
    expect(repeated.state).toBe('partial')
    expect(started).toEqual(['note', 'note'])
    expect(repeated.summary).toBe('The same action failed again, so I stopped.')
  })

  it('allows only one active agent run', () => {
    const session = new AgentSessionController()
    const first = session.begin('Open TextEdit')
    expect(first.ok).toBe(true)
    expect(session.begin('Open Notes')).toEqual({
      ok: false,
      summary: 'A task is already running.'
    })
    if (first.ok) {
      session.stop(first.id)
      session.finish(first.id)
    }
    expect(session.begin('').ok).toBe(false)
  })
})
