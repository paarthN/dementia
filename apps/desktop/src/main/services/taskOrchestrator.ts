import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  assistantTaskSchema,
  canonicalJson,
  toolResultSchema,
  type AssistantTask,
  type PendingApproval,
  type PlannedStep,
  type ResponseState,
  type RoutedRequest,
  type ToolResult
} from '../../shared/agent'
import { routeUtterance, type RouterFavorite } from '../../shared/router'
import { listFavorites, recordActivity } from '../storage/database'
import type { CommandRunner } from './launcher'
import { decidePolicy, type PolicyApproval } from './policyEngine'
import type { ReminderPort } from './reminderScheduler'
import { AssistantPlanRejected } from '../providers/assistant'
import {
  createToolRegistry,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry
} from './toolRegistry'

const stepCap = 8
const approvalTtlMs = 10 * 60 * 1000

const manuals: Record<string, string> = {
  guide_app:
    "I can't highlight the screen yet. Open the app from the Dock, or from Finder in Applications.",
  guide_browser:
    "I can't highlight the screen yet. Open Safari, click the address bar, and type what you want to find.",
  guide_settings: "I can't highlight the screen yet. Choose the Apple menu, then System Settings."
}

export interface TaskOutcome {
  task: AssistantTask | null
  responseState: ResponseState
  summary: string
  approval?: PendingApproval
  recovery?: ToolResult['recovery']
}

interface PlannedCall {
  tool: string
  input: Record<string, unknown>
}

interface StoredApproval extends PolicyApproval {
  approvalId: string
  taskId: string
  input: Record<string, unknown>
  confirmLabel: string
  summary: string
}

export interface OrchestratorOptions {
  db: DatabaseSync
  run: CommandRunner
  now?: () => Date
  timeZone?: string
  timeoutMs?: number
  screenPermission?: boolean | (() => boolean)
  extraTools?: ToolDefinition[]
  onTool?: (name: string) => void
  reminders?: ReminderPort
  screen?: ToolContext['screen']
  interpret?: (text: string) => Promise<RoutedRequest>
}

export class TaskOrchestrator {
  private readonly registry: ToolRegistry
  private readonly tasks = new Map<string, AssistantTask>()
  private readonly approvals = new Map<string, StoredApproval>()
  private readonly cancelled = new Set<string>()
  private activeTaskId: string | null = null
  private readonly now: () => Date
  private readonly timeZone: string
  private readonly timeoutMs: number

  constructor(private readonly options: OrchestratorOptions) {
    this.registry = createToolRegistry(options.extraTools ?? [])
    this.now = options.now ?? (() => new Date())
    this.timeZone = options.timeZone ?? 'UTC'
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  private screenAllowed(): boolean {
    const value = this.options.screenPermission
    return typeof value === 'function' ? value() : (value ?? false)
  }

  async submit(
    text: string,
    options: { mode?: 'execute' | 'guide' | 'explain'; source?: 'user' | 'observed' } = {}
  ): Promise<TaskOutcome> {
    const source = options.source ?? 'user'
    if (source !== 'user') {
      return this.outcome(null, 'failure', "I won't act on instructions from the page.")
    }
    if (!text.trim()) {
      return this.outcome(null, 'needs_input', 'Type a request, such as "Open TextEdit."')
    }

    let routed: RoutedRequest
    try {
      routed = this.options.interpret
        ? await this.options.interpret(text)
        : routeUtterance(text, {
            favorites: this.favorites(),
            now: this.now(),
            timeZone: this.timeZone
          })
    } catch (error) {
      const rejected = error instanceof AssistantPlanRejected
      return this.outcome(
        null,
        'failure',
        rejected
          ? "I can't run commands or use an unknown action."
          : "I couldn't reach the assistant service. Try again."
      )
    }
    if (options.mode === 'guide' && routed.mode === 'execute') {
      return this.finish(
        this.createTask(text, 'guide'),
        'answer',
        "I can't highlight the screen yet. Choose Do it for me, then ask again."
      )
    }
    if (routed.missingRequiredFields.length > 0) {
      return this.finish(
        this.createTask(text, 'execute'),
        'needs_input',
        routed.userFacingClarification ?? 'I need one more detail before I can do that.'
      )
    }

    const call = plan(routed)
    if (!call) {
      const state = answerIntent(routed.intent) ? 'answer' : 'failure'
      return this.finish(
        this.createTask(text, taskMode(routed)),
        state,
        routed.userFacingClarification ?? this.helpText()
      )
    }

    const task = this.createTask(text, 'execute')
    return this.runCalls(task, [call], null)
  }

  async confirm(taskId: string, approvalId: string): Promise<TaskOutcome> {
    const task = this.tasks.get(taskId)
    const stored = this.approvals.get(taskId)
    if (
      !task ||
      !stored ||
      stored.approvalId !== approvalId ||
      task.state !== 'awaiting_confirmation'
    ) {
      return this.outcome(task ?? null, 'failure', "That confirmation doesn't match the action.")
    }
    if (new Date(stored.expiresAtUtc).getTime() <= this.now().getTime()) {
      this.approvals.delete(taskId)
      return this.finish(
        task,
        'failure',
        'That confirmation expired. Ask me again if you still want it.'
      )
    }
    this.approvals.delete(taskId)
    return this.runCalls(task, [{ tool: stored.tool, input: stored.input }], stored)
  }

  cancel(taskId: string): TaskOutcome {
    const task = this.tasks.get(taskId)
    this.cancelled.add(taskId)
    this.approvals.delete(taskId)
    if (!task) {
      return this.outcome(null, 'cancelled', 'I stopped. Nothing else will run for that request.')
    }
    task.cancellationRequested = true
    if (task.state !== 'completed' && task.state !== 'failed') {
      task.state = 'cancelled'
      task.updatedAtUtc = this.now().toISOString()
    }
    const summary =
      task.state === 'completed'
        ? 'That request already finished. I will not start another step.'
        : 'I stopped. Nothing else will run for that request.'
    this.log(task, 'cancelled', summary)
    return this.outcome(task, 'cancelled', summary)
  }

  currentTaskId(): string | null {
    return this.activeTaskId
  }

  recover(actionKey: string): TaskOutcome {
    const summary = manuals[actionKey]
    if (!summary) {
      return this.outcome(null, 'failure', "I can't do that.")
    }
    return this.outcome(null, 'answer', summary)
  }

  async runPlanned(
    goal: string,
    calls: PlannedCall[],
    source: 'user' | 'observed' = 'user'
  ): Promise<TaskOutcome> {
    if (source !== 'user') {
      return this.outcome(null, 'failure', "I won't act on instructions from the page.")
    }
    const task = this.createTask(goal, 'execute')
    return this.runCalls(task, calls, null)
  }

  private async runCalls(
    task: AssistantTask,
    calls: PlannedCall[],
    approval: StoredApproval | null
  ): Promise<TaskOutcome> {
    if (calls.length > stepCap) {
      return this.finish(task, 'failure', 'That request has too many steps, so I stopped.')
    }

    task.state = 'planning'
    this.activeTaskId = task.id
    let finished = 0
    let lastSummary = ''
    let recovery: ToolResult['recovery']

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]
      if (!call) {
        continue
      }
      if (this.cancelled.has(task.id) || task.cancellationRequested) {
        task.state = 'cancelled'
        return this.finish(task, 'cancelled', 'I stopped. Nothing else will run for that request.')
      }

      const decision = decidePolicy(this.registry, {
        tool: call.tool,
        input: call.input,
        source: 'user',
        now: this.now(),
        screenPermission: this.screenAllowed(),
        approval
      })
      const step: PlannedStep = {
        id: randomUUID(),
        tool: call.tool,
        input: call.input,
        risk: decision.risk,
        status: 'pending'
      }
      task.steps.push(step)
      task.currentStepIndex = index

      if (decision.effect === 'deny') {
        step.status = 'failed'
        return this.finish(task, 'failure', decision.reason)
      }
      if (decision.effect === 'permission') {
        step.status = 'skipped'
        task.state = 'awaiting_permission'
        return this.finish(task, 'needs_permission', decision.reason)
      }
      if (decision.effect === 'confirm') {
        step.status = 'pending'
        return this.askConfirmation(task, call, decision.reason)
      }

      step.status = 'running'
      task.state = 'executing'
      this.options.onTool?.(call.tool)
      const executeInput =
        approval && call.tool === 'browser.openUrl'
          ? { ...call.input, confirmed: true }
          : call.input
      let raw: unknown
      try {
        raw = await runWithTimeout(
          this.registry.execute(call.tool, executeInput, this.context(task.id)),
          this.timeoutMs
        )
      } catch (error) {
        step.status = 'failed'
        const timedOut = error instanceof Error && error.message === 'timeout'
        return this.finish(
          task,
          'failure',
          timedOut ? 'That took too long, so I stopped.' : "I couldn't finish that."
        )
      }

      const parsed = toolResultSchema.safeParse(raw)
      if (!parsed.success) {
        step.status = 'failed'
        return this.finish(task, 'failure', "I tried, but couldn't confirm it worked.")
      }
      lastSummary = parsed.data.summary
      recovery = parsed.data.recovery
      if (parsed.data.status === 'cancelled') {
        step.status = 'cancelled'
        task.state = 'cancelled'
        return this.finish(task, 'cancelled', parsed.data.summary, recovery)
      }
      if (parsed.data.status !== 'succeeded' || parsed.data.verification?.passed !== true) {
        step.status = 'failed'
        const responseState = finished > 0 ? 'partial' : 'failure'
        return this.finish(task, responseState, parsed.data.summary, recovery)
      }
      step.status = 'succeeded'
      finished += 1
      task.state = 'verifying'
    }

    task.state = 'completed'
    return this.finish(task, 'success', lastSummary, recovery)
  }

  private askConfirmation(task: AssistantTask, call: PlannedCall, reason: string): TaskOutcome {
    const expires = new Date(this.now().getTime() + approvalTtlMs)
    const stored: StoredApproval = {
      approvalId: randomUUID(),
      taskId: task.id,
      tool: call.tool,
      input: call.input,
      payloadJson: canonicalJson(call.input),
      expiresAtUtc: expires.toISOString(),
      confirmLabel: confirmLabel(call.tool),
      summary: reason
    }
    this.approvals.set(task.id, stored)
    task.state = 'awaiting_confirmation'
    task.safeSummary = reason
    task.updatedAtUtc = this.now().toISOString()
    this.log(task, 'needs_confirmation', reason)
    return {
      task,
      responseState: 'needs_confirmation',
      summary: reason,
      approval: {
        taskId: task.id,
        approvalId: stored.approvalId,
        summary: reason,
        confirmLabel: stored.confirmLabel,
        expiresAtUtc: stored.expiresAtUtc
      }
    }
  }

  private finish(
    task: AssistantTask,
    responseState: ResponseState,
    summary: string,
    recovery?: ToolResult['recovery']
  ): TaskOutcome {
    if (responseState === 'success') {
      task.state = 'completed'
    } else if (responseState === 'cancelled') {
      task.state = 'cancelled'
    } else if (responseState === 'needs_input') {
      task.state = 'failed'
    } else if (responseState === 'needs_permission') {
      task.state = 'awaiting_permission'
    } else if (responseState === 'answer') {
      task.state = 'completed'
    } else if (task.state !== 'awaiting_confirmation') {
      task.state = responseState === 'partial' ? 'failed' : 'failed'
    }
    task.safeSummary = summary
    task.updatedAtUtc = this.now().toISOString()
    assistantTaskSchema.parse(task)
    this.log(task, responseState, summary)
    return this.outcome(task, responseState, summary, recovery)
  }

  private outcome(
    task: AssistantTask | null,
    responseState: ResponseState,
    summary: string,
    recovery?: ToolResult['recovery']
  ): TaskOutcome {
    return { task, responseState, summary, recovery }
  }

  private createTask(goal: string, mode: AssistantTask['mode']): AssistantTask {
    const timestamp = this.now().toISOString()
    const task: AssistantTask = {
      id: randomUUID(),
      goal,
      mode,
      state: 'created',
      steps: [],
      currentStepIndex: 0,
      createdAtUtc: timestamp,
      updatedAtUtc: timestamp,
      cancellationRequested: false
    }
    this.tasks.set(task.id, task)
    return task
  }

  private context(taskId: string): ToolContext {
    const controller = new AbortController()
    if (this.cancelled.has(taskId)) {
      controller.abort()
    }
    return {
      db: this.options.db,
      run: async (command, args) => {
        if (this.cancelled.has(taskId)) {
          return 1
        }
        return this.options.run(command, args)
      },
      now: this.now,
      timeZone: this.timeZone,
      screenPermission: this.screenAllowed(),
      allowedBundleIds: () =>
        listFavorites(this.options.db)
          .filter((favorite) => favorite.kind === 'application')
          .map((favorite) => favorite.target),
      signal: controller.signal,
      reminders: this.options.reminders,
      screen: this.options.screen
    }
  }

  private favorites(): RouterFavorite[] {
    return listFavorites(this.options.db).map((favorite) => ({
      kind: favorite.kind,
      title: favorite.title,
      target: favorite.target
    }))
  }

  private helpText(): string {
    if (this.registry.has('reminders.create')) {
      return 'I can open an app, search the web, set a reminder, or make the text in this assistant bigger.'
    }
    return 'I can open an app, search the web, or make the text in this assistant bigger.'
  }

  private log(task: AssistantTask, result: string, summary: string): void {
    const operation = task.steps[task.currentStepIndex]?.tool ?? task.mode
    recordActivity(this.options.db, {
      taskId: task.id,
      operation,
      result,
      safeSummary: summary
    })
  }
}

function plan(routed: RoutedRequest): PlannedCall | null {
  switch (routed.intent) {
    case 'open_app':
      return { tool: 'apps.open', input: routed.parameters }
    case 'open_website':
      return typeof routed.parameters.url === 'string'
        ? { tool: 'browser.openUrl', input: routed.parameters }
        : null
    case 'search_web':
      return typeof routed.parameters.query === 'string'
        ? { tool: 'browser.search', input: { query: routed.parameters.query } }
        : null
    case 'change_companion_visuals':
      return typeof routed.parameters.key === 'string'
        ? { tool: 'settings.changeCompanion', input: routed.parameters }
        : null
    case 'open_system_settings':
      return typeof routed.parameters.section === 'string'
        ? { tool: 'settings.openSystemPage', input: routed.parameters }
        : null
    case 'set_reminder':
      return typeof routed.parameters.triggerAtUtc === 'string'
        ? { tool: 'reminders.create', input: routed.parameters }
        : null
    case 'list_reminders':
      return { tool: 'reminders.list', input: routed.parameters }
    case 'cancel_reminder':
      return typeof routed.parameters.query === 'string'
        ? { tool: 'reminders.cancel', input: routed.parameters }
        : null
    case 'explain_screen':
      return { tool: 'screen.inspect', input: routed.parameters }
    case 'guide_task':
      return typeof routed.parameters.guideId === 'string'
        ? { tool: 'guidance.start', input: { guideId: routed.parameters.guideId } }
        : null
    default:
      return null
  }
}

function answerIntent(intent: RoutedRequest['intent']): boolean {
  return intent === 'general_question' || intent === 'guide_task'
}

function taskMode(routed: RoutedRequest): AssistantTask['mode'] {
  if (routed.mode === 'guide') {
    return 'guide'
  }
  if (routed.mode === 'explain') {
    return 'explain'
  }
  return 'execute'
}

function confirmLabel(tool: string): string {
  if (tool === 'browser.openUrl') {
    return 'Open website'
  }
  if (tool === 'mail.send') {
    return 'Send email'
  }
  if (tool === 'reminders.create') {
    return 'Set reminder'
  }
  if (tool === 'reminders.cancel') {
    return 'Cancel reminder'
  }
  return 'Continue'
}

function runWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}
