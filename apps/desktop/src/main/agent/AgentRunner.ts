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
  taskScopeTool,
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
import {
  evaluateGoalCriteria,
  keepGoingMessage,
  maxGoalKeepGoing,
  parseGoalCriteria,
  unfinishedGoalMessage,
  type GoalCriterion
} from './GoalCriteria'
import { consumeHeldApproval, createHeldApproval } from './security/ActionApproval'
import {
  consumeScopeGrant,
  createTaskScope,
  scopeRequestFor,
  scopeableTool,
  taskScopeKey,
  taskScopeTtlMs,
  type TaskScope
} from './security/TaskScope'
import { browserRoles, type BrowserTargetQuery } from './ports/BrowserAutomationPort'
import { resolveTargetQuery } from './ports/browserTargeting'

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
  let keepGoingCount = 0
  // One grant per surface the task actually touches, not one grant per task. A task
  // that opens Agent Browser and then switches to Notes needs its own card for each —
  // otherwise the second app silently reverts to a card per click. All entries live and
  // die with this run, so Stop and stop-sharing end them with no extra teardown.
  const taskScopes = new Map<string, TaskScope>()
  const resolveScope = (tool: string, input: Record<string, unknown>): TaskScope | null => {
    const request = scopeRequestFor(tool, input)
    return request ? (taskScopes.get(taskScopeKey(request)) ?? null) : null
  }
  const doneTools = new Set<string>()
  const toolResults: SafeToolResult[] = []
  let goalCriteria: GoalCriterion[] | null = null
  const problems: string[] = []
  let continuation: AgentTurn['continuation']
  let lastToolResult: SafeToolResult | undefined
  let lastObservation: SafeObservation | null = null
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

  type ToolStep =
    | { kind: 'passed'; summary: string }
    | { kind: 'failed_step' }
    | { kind: 'halt'; result: AgentRunResult }

  const runOneTool = async (
    tool: string,
    rawArgs: Record<string, unknown>,
    meta?: { snapshotId?: string; responseId?: string; callId?: string }
  ): Promise<ToolStep> => {
    const args = await enrichBrowserMutationArgs(
      tool,
      rawArgs,
      options,
      begun.signal,
      lastObservation
    )
    const choice = {
      type: 'tool_call' as const,
      tool,
      args,
      ...(meta?.responseId ? { responseId: meta.responseId } : {}),
      ...(meta?.callId ? { callId: meta.callId } : {})
    }
    // snapshotId and targetId change on every observation, so including them made this
    // key unique every turn and the identical-failure limit never fired. Key on what the
    // model actually meant: the tool plus the target description.
    const key = `${tool}:${canonicalJson(repeatKeyArgs(args))}`
    const priorFailures = failures.get(key) ?? 0
    if (priorFailures >= budget.maxIdenticalFailures) {
      move('limit')
      note('The same action failed again, so I stopped.')
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'failed')
      }
    }
    if (overActionBudget(budget, actions)) {
      move('limit')
      note('I reached the limit for this task, so I stopped.')
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'no_change')
      }
    }

    let call = authorizedCall(
      begun.id,
      begun.signal,
      choice,
      options,
      now,
      resolveScope(tool, args)
    )
    let preview = options.executor.preflight(call)
    let armed = false

    // One card per surface the task uses instead of one per click. Only ordinary
    // clicking and typing on a surface the task doesn't already have a grant for can be
    // asked this way; every refusal in classifyControlLabel and every R3 payload
    // approval still applies per action underneath.
    const scopeRequest =
      preview.kind === 'confirm' && scopeableTool(tool) && !resolveScope(tool, args)
        ? scopeRequestFor(tool, args)
        : null
    if (scopeRequest && options.waitForApproval) {
      // The model has no reason to send an app name, so take it from what we just saw.
      const where = scopeRequest.appName || lastObservation?.appName || 'that app'
      const grant = createHeldApproval({
        taskId: begun.id,
        stepId: randomUUID(),
        tool: taskScopeTool,
        args: { appName: where, surface: scopeRequest.surface },
        now: now(),
        ttlMs: taskScopeTtlMs
      })
      if (!move('need_confirmation')) {
        return { kind: 'halt', result: result(begun.id, state, summary, progress, 'failed') }
      }
      viewApproval = {
        approvalId: grant.approvalId,
        what: approvalWhat(taskScopeTool, { appName: where }).slice(0, 240),
        confirmLabel: confirmLabelFor(taskScopeTool, { appName: where })
      }
      viewPermission = null
      note(`I need your go-ahead to work in ${where}.`, 'Waiting for you.')
      const decision = await options.waitForApproval(grant, begun.signal)
      viewApproval = null
      const gate = await session.waitIfPaused(begun.id, begun.signal)
      if (gate === 'stopped' || begun.signal.aborted) {
        move('stop')
        note('I stopped. Nothing else will run for that request.')
        return { kind: 'halt', result: result(begun.id, state, summary, progress, 'cancelled') }
      }
      if (!decision.approved) {
        move('fail')
        note('I did not get a matching confirmation.')
        return { kind: 'halt', result: result(begun.id, state, summary, progress, 'failed') }
      }
      const consumed = consumeScopeGrant(grant, { approvalId: grant.approvalId, now: now() })
      if (!consumed.ok) {
        move('fail')
        note(consumed.reason)
        return { kind: 'halt', result: result(begun.id, state, summary, progress, 'failed') }
      }
      if (!move('approved')) {
        return { kind: 'halt', result: result(begun.id, state, summary, progress, 'failed') }
      }
      const granted = createTaskScope({
        taskId: begun.id,
        request: { ...scopeRequest, appName: where },
        now: now()
      })
      taskScopes.set(taskScopeKey(granted), granted)
      call = { ...call, scope: granted }
      preview = options.executor.preflight(call)
      if (preview.kind !== 'ready') {
        move('fail')
        note('summary' in preview ? preview.summary : "I couldn't do that.")
        return { kind: 'halt', result: result(begun.id, state, summary, progress, 'failed') }
      }
      armed = true
    }

    if (!armed && preview.kind === 'confirm') {
      if (!options.waitForApproval) {
        move('need_confirmation')
        note(preview.summary)
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'needs_approval')
        }
      }
      const held = createHeldApproval({
        taskId: begun.id,
        stepId: randomUUID(),
        tool,
        args,
        now: now(),
        ttlMs: 10 * 60 * 1000
      })
      if (!move('need_confirmation')) {
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'failed')
        }
      }
      viewApproval = {
        approvalId: held.approvalId,
        what: approvalWhat(tool, args).slice(0, 240),
        confirmLabel: confirmLabelFor(tool, args)
      }
      viewPermission = null
      note(preview.summary, 'Waiting for you.')
      const decision = await options.waitForApproval(held, begun.signal)
      viewApproval = null
      if (begun.signal.aborted) {
        move('stop')
        note('I stopped. Nothing else will run for that request.')
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'cancelled')
        }
      }
      const gate = await session.waitIfPaused(begun.id, begun.signal)
      if (gate === 'stopped' || begun.signal.aborted) {
        move('stop')
        note('I stopped. Nothing else will run for that request.')
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'cancelled')
        }
      }
      if (!decision.approved) {
        move('fail')
        note('I did not get a matching confirmation.')
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'failed')
        }
      }
      const consumed = consumeHeldApproval(held, {
        approvalId: held.approvalId,
        now: now(),
        liveTarget: decision.liveTarget
      })
      if (!consumed.ok) {
        move('fail')
        note(consumed.reason)
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'failed')
        }
      }
      if (!move('approved')) {
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'failed')
        }
      }
      call = {
        ...call,
        approval: {
          taskId: begun.id,
          tool,
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
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'needs_permission')
      }
    }
    if (!armed && preview.kind === 'cancelled') {
      move('stop')
      note(preview.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'cancelled')
      }
    }
    if (!armed && preview.kind === 'limited') {
      move('limit')
      note(preview.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'no_change')
      }
    }
    if (!armed && preview.kind === 'uncertain') {
      move('uncertain')
      note(preview.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'uncertain_after_timeout')
      }
    }
    if (!armed && (preview.kind === 'denied' || preview.kind === 'failed')) {
      move('fail')
      note(preview.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'failed')
      }
    }

    const nextContinuation =
      choice.responseId && choice.callId
        ? { responseId: choice.responseId, callId: choice.callId }
        : undefined
    if (!armed) {
      const enter = state === 'observing' ? 'force_action' : 'begin_execution'
      if (!move(enter)) {
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'failed')
        }
      }
    }
    viewApproval = null
    viewPermission = null
    viewStep = Math.min(20, actions + 1)
    note('Running one allowed action.', describeToolAction(tool, args))
    const report = await options.executor.execute(call)
    actions += 1
    if (report.kind === 'uncertain') {
      move('uncertain')
      note(report.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'uncertain_after_timeout')
      }
    }
    if (report.kind === 'cancelled') {
      move('known_stop')
      note(report.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'cancelled')
      }
    }
    if (report.kind !== 'result') {
      move('fail')
      note('summary' in report ? report.summary : "I couldn't finish that.")
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'failed')
      }
    }
    if (!move('executed')) {
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'failed')
      }
    }
    note('Checking whether that action worked.')
    if (report.result.status === 'cancelled') {
      move('known_stop')
      note(report.result.summary)
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'cancelled')
      }
    }
    const passed =
      report.result.status === 'succeeded' && report.result.verification?.passed === true
    const recorded = boundResult(tool, report.result.status, report.result.summary, passed)
    if (recorded) {
      lastToolResult = recorded
      if (nextContinuation) {
        continuation = nextContinuation
      }
    }
    if (!passed) {
      failures.set(key, priorFailures + 1)
      if (!move('step_failed')) {
        return {
          kind: 'halt',
          result: result(begun.id, state, summary, progress, 'failed')
        }
      }
      problems.push(report.result.summary)
      note(report.result.summary)
      return { kind: 'failed_step' }
    }
    // Writing the plan is not doing the task. Counting it as verified work made
    // "at least one action verified" true before anything had happened.
    if (tool !== 'task.setGoalChecks') {
      verified = true
    }
    doneTools.add(tool)
    if (recorded) {
      toolResults.push(recorded)
    }
    if (tool === 'task.setGoalChecks') {
      goalCriteria = parseGoalCriteria(args)
    }
    viewVerified = true
    viewCompleted = completedToolAction(tool, args)
    viewApproval = null
    if (!move('verified_continue')) {
      return {
        kind: 'halt',
        result: result(begun.id, state, summary, progress, 'failed')
      }
    }
    note(report.result.summary, 'Checking the screen again.')
    return { kind: 'passed', summary: report.result.summary }
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
      let observation: SafeObservation | null = null
      let observationError = ''
      try {
        observation = await observed(options, now, begun.signal, screenShare)
      } catch (error) {
        observationError = error instanceof Error ? error.message.trim().slice(0, 500) : ''
      }
      if (!observation) {
        move('fail')
        note(observationError || 'I could not read a usable observation.')
        return result(begun.id, state, summary, progress, 'failed')
      }
      lastObservation = observation
      if (!move('observed')) {
        return result(begun.id, state, summary, progress, 'failed')
      }
      note('Choosing the next step.')
      turns += 1
      let choice: FakeAgentChoice
      try {
        const checkStatus = goalCriteria
          ? evaluateGoalCriteria(goalCriteria, { doneTools, toolResults, observation })
          : null
        choice = await options.provider.next(
          {
            taskId: begun.id,
            goal: options.goal,
            stepNumber: turns,
            summary,
            observation,
            screenShare,
            ...(continuation && lastToolResult ? { continuation, lastToolResult } : {}),
            ...(checkStatus
              ? {
                  goalChecks: [
                    ...checkStatus.satisfied.map((label) => ({ label, done: true as const })),
                    ...checkStatus.missing.map((label) => ({ label, done: false as const }))
                  ]
                }
              : {})
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
        const goalReport = evaluateGoalCriteria(goalCriteria, {
          doneTools,
          toolResults,
          observation
        })
        if (!goalReport.complete) {
          if (keepGoingCount < maxGoalKeepGoing) {
            keepGoingCount += 1
            if (!move('keep_going')) {
              return result(begun.id, state, summary, progress, 'failed')
            }
            note(keepGoingMessage(goalReport.missing))
            continue
          }
          // Checks a person's words can describe but local evidence cannot confirm used
          // to end the run as "failed" even when real work landed. Report it as what it
          // is: partly done, with the part we could not confirm named.
          move(verified ? 'limit' : 'fail')
          note(unfinishedGoalMessage(goalReport.missing))
          return result(begun.id, state, summary, progress, 'changed_but_unverified')
        }
        if (!verified) {
          move('fail')
          note(explainUnverifiedFinish(problems))
          return result(begun.id, state, summary, progress, 'changed_but_unverified')
        }
        move('verified_done')
        note(choice.text)
        return result(begun.id, state, summary, progress, 'success_verified')
      }

      const stepped = await runOneTool(choice.tool, choice.args, {
        snapshotId: observation.snapshotId,
        responseId: choice.responseId,
        callId: choice.callId
      })
      if (stepped.kind === 'halt') {
        return stepped.result
      }
      if (stepped.kind === 'failed_step') {
        continue
      }
    }

    return result(begun.id, state, summary, progress, 'failed')
  } finally {
    session.finish(begun.id)
  }
}

/** Reads only the query fields the resolver uses. Model arguments stay untrusted. */
function modelQuery(raw: Record<string, unknown> | null): BrowserTargetQuery | null {
  const role = typeof raw?.role === 'string' ? raw.role.trim() : ''
  const allowed = browserRoles.find((item) => item === role)
  if (!allowed) {
    return null
  }
  const rawWithin =
    raw?.within && typeof raw.within === 'object' && !Array.isArray(raw.within)
      ? (raw.within as Record<string, unknown>)
      : null
  const withinRole = typeof rawWithin?.role === 'string' ? rawWithin.role.trim() : ''
  return {
    role: allowed,
    ...(typeof raw?.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw?.nameIncludes === 'string' ? { nameIncludes: raw.nameIncludes } : {}),
    ...(withinRole
      ? {
          within: {
            role: withinRole,
            ...(typeof rawWithin?.name === 'string' ? { name: rawWithin.name } : {}),
            ...(typeof rawWithin?.nameIncludes === 'string'
              ? { nameIncludes: rawWithin.nameIncludes }
              : {}),
            ...(typeof rawWithin?.itemOrdinal === 'number'
              ? { itemOrdinal: rawWithin.itemOrdinal }
              : {})
          }
        }
      : {})
  }
}

/** Strips the per-observation identifiers so a repeated attempt looks repeated. */
export function repeatKeyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const stable: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(args)) {
    if (name === 'snapshotId' || name === 'targetId' || name === 'observationId') {
      continue
    }
    stable[name] = value
  }
  return stable
}

async function observed(
  options: AgentRunOptions,
  now: () => Date,
  signal: AbortSignal,
  screenShare: boolean
): Promise<SafeObservation | null> {
  const value = options.observe
    ? await options.observe(signal)
    : {
        snapshotId: 'fixture-snapshot',
        appName: 'TextEdit',
        capturedAtUtc: now().toISOString()
      }
  return prepareModelObservation(value, screenShare)
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

export function explainUnverifiedFinish(problems: string[]): string {
  const reasons = [
    ...new Set(problems.map((line) => line.trim()).filter((line) => line.length > 0))
  ]
  if (reasons.length === 0) {
    return 'I could not verify that the task was finished.'
  }
  return `I could not verify that the task was finished. ${reasons.slice(-3).join(' ')}`.slice(
    0,
    500
  )
}

export { maxGoalKeepGoing } from './GoalCriteria'

export function shouldKeepGoing(
  keepGoingCount: number,
  maxKeepGoing: number = maxGoalKeepGoing
): boolean {
  return keepGoingCount < maxKeepGoing
}

export const runFakeAgent = runAgent

async function enrichBrowserMutationArgs(
  tool: string,
  args: Record<string, unknown>,
  options: AgentRunOptions,
  signal: AbortSignal,
  hinted: SafeObservation | null
): Promise<Record<string, unknown>> {
  if (tool !== 'browser.click' && tool !== 'browser.fill') {
    return args
  }
  const query =
    args.query && typeof args.query === 'object' && !Array.isArray(args.query)
      ? (args.query as Record<string, unknown>)
      : null
  let name = typeof args.name === 'string' ? args.name.trim() : ''
  let role = typeof args.role === 'string' ? args.role.trim() : ''
  let ancestors = Array.isArray(args.ancestors) ? args.ancestors : null
  if (!name) {
    name = typeof query?.name === 'string' ? query.name.trim() : ''
  }
  if (!role) {
    role = typeof query?.role === 'string' ? query.role.trim() : ''
  }
  // Prefer the observation the model just saw. A fresh observe() renumbers target ids
  // and makes the model's targetId miss, which breaks approval identity.
  let targetId = typeof args.targetId === 'string' ? args.targetId : ''
  if (!name || !role || !ancestors) {
    const observation = hinted ?? (options.observe ? await options.observe(signal) : null)
    const pool = observation?.targets ?? []
    let resolved = pool.find((item) => item.id === targetId)
    // A query-only click (role + within) has no targetId to look up. Without this the
    // approval is stored with an empty name, so the live recheck matches every control
    // of that role, finds more than one, and refuses the press.
    const narrowed = modelQuery(query)
    if (!resolved && narrowed) {
      const byQuery = resolveTargetQuery(pool, narrowed)
      if (byQuery.ok) {
        resolved = byQuery.target
      }
    }
    if (resolved) {
      name = name || resolved.name
      role = role || resolved.role
      targetId = targetId || resolved.id
      if (!ancestors && Array.isArray(resolved.ancestors)) {
        ancestors = resolved.ancestors
      }
    }
  }
  if (!name && !role) {
    return args
  }
  return {
    ...args,
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
    ...(targetId ? { targetId } : {}),
    ...(ancestors ? { ancestors } : {}),
    appName:
      typeof args.appName === 'string' && args.appName.trim() ? args.appName : 'Agent Browser'
  }
}

function authorizedCall(
  taskId: string,
  signal: AbortSignal,
  choice: Extract<FakeAgentChoice, { type: 'tool_call' }>,
  options: AgentRunOptions,
  now: () => Date,
  scope: TaskScope | null = null
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
    context,
    scope
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
