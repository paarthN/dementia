import { canonicalJson } from '../../shared/agent'
import {
  agentProgressSchema,
  safeObservationSchema,
  type ActionOutcome,
  type AgentProgress,
  type AgentRunResult,
  type ComputerAgentEvent,
  type ComputerAgentState,
  type FakeAgentChoice,
  type SafeObservation
} from '../../shared/computerAgent'
import type { ToolContext } from '../services/toolRegistry'
import {
  defaultAgentBudget,
  overActionBudget,
  overDeadline,
  overTurnBudget,
  type AgentBudget
} from './AgentBudget'
import { AgentSessionController } from './AgentSessionController'
import { transitionAgentState } from './AgentStateMachine'
import { AuthorizedToolExecutor, type AuthorizedCall } from './AuthorizedToolExecutor'

export class FakeAgentProvider {
  private index = 0

  constructor(private readonly script: readonly FakeAgentChoice[]) {}

  issued(): number {
    return this.index
  }

  async next(signal: AbortSignal): Promise<FakeAgentChoice> {
    if (signal.aborted) {
      return { type: 'refusal', text: 'I stopped.' }
    }
    const choice = this.script[this.index]
    this.index += 1
    return choice ?? { type: 'final', text: 'I have no further step.' }
  }
}

export interface AgentRunOptions {
  goal: string
  provider: FakeAgentProvider
  executor: AuthorizedToolExecutor
  session: AgentSessionController
  context: (signal: AbortSignal) => ToolContext
  now?: () => Date
  budget?: AgentBudget
  observe?: () => SafeObservation
}

export async function runFakeAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const now = options.now ?? (() => new Date())
  const budget = options.budget ?? defaultAgentBudget
  const session = options.session
  const begun = session.begin(options.goal)
  if (!begun.ok) {
    return result(null, 'failed', begun.summary, [], 'failed')
  }

  let state: ComputerAgentState = 'idle'
  let summary = 'Checking the current screen.'
  const progress: AgentProgress[] = []
  const failures = new Map<string, number>()
  let actions = 0
  let turns = 0
  let verified = false
  const startedAt = now().getTime()
  const note = (text: string): void => {
    summary = text
    const entry = { state, summary: text }
    agentProgressSchema.parse(entry)
    progress.push(entry)
  }
  const move = (event: ComputerAgentEvent): boolean => {
    const next = transitionAgentState(state, event)
    if (!next.ok) {
      state = 'failed'
      note(next.reason)
      return false
    }
    state = next.state
    return true
  }

  try {
    if (!move('start')) {
      return result(begun.id, state, summary, progress, 'failed')
    }
    note('Checking the current screen.')

    while (!isDone(state)) {
      if (begun.signal.aborted) {
        move('stop')
        note('I stopped. Nothing else will run for that request.')
        return result(begun.id, state, summary, progress, 'cancelled')
      }
      if (
        overDeadline(budget, startedAt, now().getTime()) ||
        overTurnBudget(budget, turns) ||
        overActionBudget(budget, actions)
      ) {
        move('limit')
        note('I reached the limit for this task, so I stopped.')
        return result(begun.id, state, summary, progress, 'no_change')
      }

      const observation = observed(options, now)
      if (!observation) {
        move('fail')
        note('I could not read a usable observation.')
        return result(begun.id, state, summary, progress, 'failed')
      }
      if (!move('observed')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      note('Choosing the next step.')
      turns += 1
      const choice = await options.provider.next(begun.signal)
      if (begun.signal.aborted) {
        move('stop')
        note('I stopped. Nothing else will run for that request.')
        return result(begun.id, state, summary, progress, 'cancelled')
      }
      if (choice.type === 'refusal') {
        move('fail')
        note(choice.text)
        return result(begun.id, state, summary, progress, 'failed')
      }
      if (choice.type === 'final') {
        if (!verified) {
          move('fail')
          note('I could not verify that the task was finished.')
          return result(begun.id, state, summary, progress, 'changed_but_unverified')
        }
        move('verified_done')
        note(choice.text)
        return result(begun.id, state, summary, progress, 'success_verified')
      }

      const key = `${choice.tool}:${canonicalJson(choice.args)}:${observation.snapshotId}`
      const priorFailures = failures.get(key) ?? 0
      if (priorFailures >= budget.maxIdenticalFailures) {
        move('limit')
        note('The same action failed again, so I stopped.')
        return result(begun.id, state, summary, progress, 'failed')
      }

      const call = authorizedCall(begun.id, begun.signal, choice, options, now)
      const preview = options.executor.preflight(call)
      if (preview.kind === 'confirm') {
        move('need_confirmation')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'needs_approval')
      }
      if (preview.kind === 'permission') {
        move('need_permission')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'needs_permission')
      }
      if (preview.kind === 'cancelled') {
        move('stop')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'cancelled')
      }
      if (preview.kind === 'limited') {
        move('limit')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'no_change')
      }
      if (preview.kind === 'uncertain') {
        move('uncertain')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'uncertain_after_timeout')
      }
      if (preview.kind === 'denied' || preview.kind === 'failed') {
        move('fail')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'failed')
      }

      if (!move('begin_execution')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      note('Running one allowed action.')
      const report = await options.executor.execute(call)
      actions += 1
      if (report.kind === 'uncertain') {
        move('uncertain')
        note(report.summary)
        return result(begun.id, state, summary, progress, 'uncertain_after_timeout')
      }
      if (report.kind === 'cancelled') {
        move('known_stop')
        note(report.summary)
        return result(begun.id, state, summary, progress, 'cancelled')
      }
      if (report.kind !== 'result') {
        move('fail')
        note('summary' in report ? report.summary : "I couldn't finish that.")
        return result(begun.id, state, summary, progress, 'failed')
      }
      if (!move('executed')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      note('Checking whether that action worked.')
      if (report.result.status === 'cancelled') {
        move('known_stop')
        note(report.result.summary)
        return result(begun.id, state, summary, progress, 'cancelled')
      }
      const passed =
        report.result.status === 'succeeded' && report.result.verification?.passed === true
      if (!passed) {
        failures.set(key, priorFailures + 1)
        if (!move('step_failed')) {
          return result(begun.id, state, summary, progress, 'failed')
        }
        note(report.result.summary)
        continue
      }
      verified = true
      if (!move('verified_continue')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      note(report.result.summary)
    }

    return result(begun.id, state, summary, progress, 'failed')
  } finally {
    session.finish(begun.id)
  }
}

function observed(options: AgentRunOptions, now: () => Date): SafeObservation | null {
  const value = options.observe
    ? options.observe()
    : {
        snapshotId: 'fixture-snapshot',
        appName: 'TextEdit',
        capturedAtUtc: now().toISOString()
      }
  const parsed = safeObservationSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function authorizedCall(
  taskId: string,
  signal: AbortSignal,
  choice: Extract<FakeAgentChoice, { type: 'tool_call' }>,
  options: AgentRunOptions,
  now: () => Date
): AuthorizedCall {
  const budget = options.budget ?? defaultAgentBudget
  const context = options.context(signal)
  return {
    taskId,
    tool: choice.tool,
    input: choice.args,
    source: 'user',
    now: now(),
    screenPermission: context.screenPermission,
    approval: null,
    signal,
    timeoutMs: 15_000,
    deadlineAtMs: now().getTime() + budget.deadlineMs,
    taskOwned: options.session.owns(taskId),
    context
  }
}

function isDone(state: ComputerAgentState): boolean {
  return (
    state === 'completed' ||
    state === 'partial' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'uncertain' ||
    state === 'interrupted'
  )
}

function result(
  taskId: string | null,
  state: ComputerAgentState,
  summary: string,
  progress: AgentProgress[],
  actionOutcome: ActionOutcome
): AgentRunResult {
  return { taskId, state, summary, progress, actionOutcome }
}
