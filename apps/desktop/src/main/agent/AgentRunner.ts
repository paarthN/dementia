import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../../shared/agent'
import {
  agentProgressSchema,
  safeToolResultSchema,
  type ActionOutcome,
  type AgentProgress,
  type AgentRunResult,
  type AgentTurn,
  type ComputerAgentEvent,
  type ComputerAgentState,
  type FakeAgentChoice,
  type SafeObservation,
  type SafeToolResult
} from '../../shared/computerAgent'
import { prepareModelObservation, redactSecretText } from './AgentPrompt'
import {
  approvalWhat,
  completedToolAction,
  confirmLabelFor,
  describeToolAction,
  agentStatusSchema,
  type AgentStatus
} from '../../shared/agentStatus'
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
import { consumeHeldApproval, createHeldApproval } from './security/ActionApproval'

export interface AgentProvider {
  next(turn: AgentTurn, signal: AbortSignal): Promise<FakeAgentChoice>
}

export class FakeAgentProvider implements AgentProvider {
  private index = 0

  constructor(private readonly script: readonly FakeAgentChoice[]) {}

  issued(): number {
    return this.index
  }

  async next(_turn: AgentTurn, signal: AbortSignal): Promise<FakeAgentChoice> {
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
  provider: AgentProvider
  executor: AuthorizedToolExecutor
  session: AgentSessionController
  context: (signal: AbortSignal) => ToolContext
  now?: () => Date
  budget?: AgentBudget
  sessionTtlMs?: number
  screenShare?: () => boolean
  observe?: (signal: AbortSignal) => SafeObservation | null | Promise<SafeObservation | null>
  waitForApproval?: (
    approval: ReturnType<typeof createHeldApproval>,
    signal: AbortSignal
  ) => Promise<
    | { approved: true; liveTarget: ReturnType<typeof createHeldApproval>['target'] | null }
    | { approved: false }
  >
  onStatus?: (status: AgentStatus) => void
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const now = options.now ?? (() => new Date())
  const budget = options.budget ?? defaultAgentBudget
  const session = options.session
  const startedAt = now().getTime()
  const begun = session.begin(options.goal, startedAt + (options.sessionTtlMs ?? budget.deadlineMs))
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
  let continuation: AgentTurn['continuation']
  let lastToolResult: SafeToolResult | undefined
  let viewStep = 0
  let viewVerified = false
  let viewCompleted: string | null = null
  let viewApproval: AgentStatus['approval'] = null
  let viewPermission: string | null = null
  let viewCurrent = 'Checking the current screen.'
  const goalText =
    redactSecretText(options.goal).replace(/\s+/g, ' ').trim().slice(0, 240) || 'this request'
  const emit = (): void => {
    if (!options.onStatus) {
      return
    }
    const parsed = agentStatusSchema.safeParse({
      taskId: begun.id,
      goal: goalText,
      state,
      current:
        redactSecretText(viewCurrent).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Working.',
      completed: viewVerified ? viewCompleted : null,
      step: viewStep,
      verified: viewVerified,
      approval: viewApproval,
      permissionReason: viewPermission,
      observing: state === 'observing' && (options.screenShare?.() ?? false)
    })
    if (parsed.success) {
      options.onStatus(parsed.data)
    }
  }
  const note = (text: string, shown = text): void => {
    summary = text
    const entry = { state, summary: text }
    agentProgressSchema.parse(entry)
    progress.push(entry)
    viewCurrent = shown
    emit()
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
      const clock = now().getTime()
      if (!session.owns(begun.id, clock)) {
        move('limit')
        note('This request expired, so I stopped.')
        return result(begun.id, state, summary, progress, 'no_change')
      }
      if (
        overDeadline(budget, startedAt, clock) ||
        overTurnBudget(budget, turns) ||
        overActionBudget(budget, actions)
      ) {
        move('limit')
        note('I reached the limit for this task, so I stopped.')
        return result(begun.id, state, summary, progress, 'no_change')
      }
      if (session.isPaused(begun.id)) {
        if (!move('pause')) {
          return result(begun.id, state, summary, progress, 'failed')
        }
        const gate = await session.waitIfPaused(begun.id, begun.signal)
        if (gate === 'stopped' || begun.signal.aborted) {
          move('stop')
          note('I stopped. Nothing else will run for that request.')
          return result(begun.id, state, summary, progress, 'cancelled')
        }
        if (!move('resume')) {
          return result(begun.id, state, summary, progress, 'failed')
        }
      }

      const screenShare = options.screenShare?.() ?? false
      const observation = await observed(options, now, begun.signal, screenShare)
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
      let choice: FakeAgentChoice
      try {
        choice = await options.provider.next(
          {
            taskId: begun.id,
            goal: options.goal,
            stepNumber: turns,
            summary,
            observation,
            screenShare,
            ...(continuation && lastToolResult ? { continuation, lastToolResult } : {})
          },
          begun.signal
        )
      } catch {
        if (begun.signal.aborted) {
          move('stop')
          note('I stopped. Nothing else will run for that request.')
          return result(begun.id, state, summary, progress, 'cancelled')
        }
        move('fail')
        note("I couldn't reach the assistant service.")
        return result(begun.id, state, summary, progress, 'failed')
      }
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

      let call = authorizedCall(begun.id, begun.signal, choice, options, now)
      const preview = options.executor.preflight(call)
      let armed = false
      if (preview.kind === 'confirm') {
        if (!options.waitForApproval) {
          move('need_confirmation')
          note(preview.summary)
          return result(begun.id, state, summary, progress, 'needs_approval')
        }
        const held = createHeldApproval({
          taskId: begun.id,
          stepId: randomUUID(),
          tool: choice.tool,
          args: choice.args,
          now: now(),
          ttlMs: 10 * 60 * 1000
        })
        if (!move('need_confirmation')) {
          return result(begun.id, state, summary, progress, 'failed')
        }
        viewApproval = {
          approvalId: held.approvalId,
          what: approvalWhat(choice.tool, choice.args).slice(0, 240),
          confirmLabel: confirmLabelFor(choice.tool, choice.args)
        }
        viewPermission = null
        note(preview.summary, 'Waiting for you.')
        const decision = await options.waitForApproval(held, begun.signal)
        viewApproval = null
        if (begun.signal.aborted) {
          move('stop')
          note('I stopped. Nothing else will run for that request.')
          return result(begun.id, state, summary, progress, 'cancelled')
        }
        const gate = await session.waitIfPaused(begun.id, begun.signal)
        if (gate === 'stopped' || begun.signal.aborted) {
          move('stop')
          note('I stopped. Nothing else will run for that request.')
          return result(begun.id, state, summary, progress, 'cancelled')
        }
        if (!decision.approved) {
          move('fail')
          note('I did not get a matching confirmation.')
          return result(begun.id, state, summary, progress, 'failed')
        }
        const consumed = consumeHeldApproval(held, {
          approvalId: held.approvalId,
          now: now(),
          liveTarget: decision.liveTarget
        })
        if (!consumed.ok) {
          move('fail')
          note(consumed.reason)
          return result(begun.id, state, summary, progress, 'failed')
        }
        if (!move('approved')) {
          return result(begun.id, state, summary, progress, 'failed')
        }
        call = {
          ...call,
          approval: {
            taskId: begun.id,
            tool: choice.tool,
            payloadJson: held.payloadJson,
            expiresAtUtc: held.expiresAtUtc
          },
          liveTarget: decision.liveTarget
        }
        armed = true
      }
      if (!armed && preview.kind === 'permission') {
        move('need_permission')
        viewApproval = null
        viewPermission =
          'Companion needs screen access to look at the other app. You can allow it, or do this yourself.'
        note(preview.summary, 'Waiting for you.')
        return result(begun.id, state, summary, progress, 'needs_permission')
      }
      if (!armed && preview.kind === 'cancelled') {
        move('stop')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'cancelled')
      }
      if (!armed && preview.kind === 'limited') {
        move('limit')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'no_change')
      }
      if (!armed && preview.kind === 'uncertain') {
        move('uncertain')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'uncertain_after_timeout')
      }
      if (!armed && (preview.kind === 'denied' || preview.kind === 'failed')) {
        move('fail')
        note(preview.summary)
        return result(begun.id, state, summary, progress, 'failed')
      }

      const nextContinuation =
        choice.responseId && choice.callId
          ? { responseId: choice.responseId, callId: choice.callId }
          : undefined
      if (!armed && !move('begin_execution')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      viewApproval = null
      viewPermission = null
      viewStep = Math.min(20, actions + 1)
      note('Running one allowed action.', describeToolAction(choice.tool, choice.args))
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
      const recorded = boundResult(choice.tool, report.result.status, report.result.summary, passed)
      if (nextContinuation && recorded) {
        continuation = nextContinuation
        lastToolResult = recorded
      }
      if (!passed) {
        failures.set(key, priorFailures + 1)
        if (!move('step_failed')) {
          return result(begun.id, state, summary, progress, 'failed')
        }
        note(report.result.summary, 'I could not confirm that step.')
        continue
      }
      verified = true
      viewVerified = true
      viewCompleted = completedToolAction(choice.tool, choice.args)
      viewApproval = null
      if (!move('verified_continue')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      note(report.result.summary, 'Checking the screen again.')
    }

    return result(begun.id, state, summary, progress, 'failed')
  } finally {
    session.finish(begun.id)
  }
}

async function observed(
  options: AgentRunOptions,
  now: () => Date,
  signal: AbortSignal,
  screenShare: boolean
): Promise<SafeObservation | null> {
  try {
    const value = options.observe
      ? await options.observe(signal)
      : {
          snapshotId: 'fixture-snapshot',
          appName: 'TextEdit',
          capturedAtUtc: now().toISOString()
        }
    return prepareModelObservation(value, screenShare)
  } catch {
    return null
  }
}

function boundResult(
  tool: string,
  status: string,
  summary: string,
  verified: boolean
): SafeToolResult | null {
  const parsed = safeToolResultSchema.safeParse({
    tool,
    status: status.slice(0, 40),
    summary: redactSecretText(summary).trim().slice(0, 500) || 'The action finished.',
    verified
  })
  return parsed.success ? parsed.data : null
}

export const runFakeAgent = runAgent

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
    taskOwned: options.session.owns(taskId, now().getTime()),
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
