import { toolResultSchema, type RiskLevel, type ToolResult } from '../../shared/agent'
import { decidePolicy, type PolicyApproval } from '../services/policyEngine'
import type { ToolContext, ToolRegistry } from '../services/toolRegistry'
import {
  sameTargetIdentity,
  targetIdentityFrom,
  type TargetIdentity
} from './security/ActionApproval'
import { scopeCovers, type TaskScope } from './security/TaskScope'

export interface BoundApproval extends PolicyApproval {
  taskId: string
}

export interface AuthorizedCall {
  taskId: string
  tool: string
  input: Record<string, unknown>
  source: 'user' | 'observed'
  now: Date
  screenPermission: boolean
  approval: BoundApproval | null
  signal: AbortSignal
  timeoutMs: number
  deadlineAtMs: number
  taskOwned: boolean
  context: ToolContext
  liveTarget?: TargetIdentity | null
  scope?: TaskScope | null
  onStart?: (tool: string) => void
}

export type AuthorizedReport =
  | { kind: 'denied'; risk: RiskLevel; summary: string }
  | { kind: 'permission'; risk: RiskLevel; summary: string }
  | { kind: 'confirm'; risk: RiskLevel; summary: string }
  | { kind: 'cancelled'; risk: RiskLevel; summary: string }
  | { kind: 'limited'; risk: RiskLevel; summary: string }
  | {
      kind: 'uncertain'
      risk: RiskLevel
      summary: string
      actionOutcome: 'uncertain_after_timeout'
    }
  | { kind: 'failed'; risk: RiskLevel; summary: string }
  | { kind: 'result'; risk: RiskLevel; result: ToolResult }

const stopped = 'I stopped. Nothing else will run for that request.'
const stillRunning = 'An earlier action may still be running, so I will not start another.'
const timedOut =
  'That took too long, and I could not confirm it stopped. I will not start another action.'
const abortedUncertain =
  'I asked it to stop, but I could not confirm the action finished. I will not start another action.'

export class AuthorizedToolExecutor {
  private busy = false
  private unsettled = false

  constructor(private readonly registry: ToolRegistry) {}

  preflight(call: AuthorizedCall): AuthorizedReport | { kind: 'ready'; risk: RiskLevel } {
    if (this.unsettled) {
      return {
        kind: 'uncertain',
        risk: 'R4',
        summary: stillRunning,
        actionOutcome: 'uncertain_after_timeout'
      }
    }
    if (!call.taskOwned) {
      return {
        kind: 'denied',
        risk: 'R4',
        summary: 'That request does not match the active task.'
      }
    }
    if (call.signal.aborted) {
      return { kind: 'cancelled', risk: 'R0', summary: stopped }
    }
    if (call.now.getTime() >= call.deadlineAtMs) {
      return {
        kind: 'limited',
        risk: 'R0',
        summary: 'This task reached its time limit, so I did not start another action.'
      }
    }
    if (this.busy) {
      return { kind: 'denied', risk: 'R1', summary: 'Another action is still running.' }
    }
    if (call.approval && call.approval.taskId !== call.taskId) {
      return {
        kind: 'denied',
        risk: 'R4',
        summary: "That confirmation doesn't match the action."
      }
    }
    if (!call.tool.trim() || !isPlainRecord(call.input)) {
      return { kind: 'denied', risk: 'R4', summary: "I can't do that." }
    }

    const decision = decidePolicy(this.registry, {
      tool: call.tool,
      input: call.input,
      source: call.source,
      now: call.now,
      screenPermission: call.screenPermission,
      approval: call.approval,
      scopeApproved: scopeCovers(call.scope, {
        taskId: call.taskId,
        tool: call.tool,
        input: call.input,
        now: call.now
      })
    })
    if (decision.effect === 'deny') {
      return { kind: 'denied', risk: decision.risk, summary: decision.reason }
    }
    if (decision.effect === 'permission') {
      return { kind: 'permission', risk: decision.risk, summary: decision.reason }
    }
    if (decision.effect === 'confirm') {
      return { kind: 'confirm', risk: decision.risk, summary: decision.reason }
    }
    if (call.approval && uiMutation(call.tool)) {
      if (!call.liveTarget) {
        return {
          kind: 'denied',
          risk: 'R4',
          summary: 'I could not recheck the control, so I did not press it.'
        }
      }
      const approved = approvedTarget(call.approval.payloadJson)
      if (!approved || !sameTargetIdentity(approved, call.liveTarget)) {
        return {
          kind: 'denied',
          risk: 'R4',
          summary: 'The control changed, so I did not press it.'
        }
      }
    }
    return { kind: 'ready', risk: decision.risk }
  }

  async execute(call: AuthorizedCall): Promise<AuthorizedReport> {
    const gate = this.preflight(call)
    if (gate.kind !== 'ready') {
      return gate
    }
    if (call.signal.aborted) {
      return { kind: 'cancelled', risk: gate.risk, summary: stopped }
    }

    this.busy = true
    call.onStart?.(call.tool)
    const toolInput =
      call.source === 'user' && call.tool === 'browser.openUrl'
        ? { ...call.input, confirmed: true }
        : call.input
    const work = this.registry.execute(call.tool, toolInput, call.context)
    const waited = await waitForSettlement(work, call.signal, call.timeoutMs)
    this.busy = false

    if (waited.kind === 'value') {
      const parsed = toolResultSchema.safeParse(waited.value)
      if (!parsed.success) {
        return {
          kind: 'failed',
          risk: gate.risk,
          summary: "I tried, but couldn't confirm it worked."
        }
      }
      return { kind: 'result', risk: gate.risk, result: parsed.data }
    }
    if (waited.kind === 'error') {
      if (!isUnresolvedNativeStop(waited.error)) {
        return { kind: 'failed', risk: gate.risk, summary: "I couldn't finish that." }
      }
      this.unsettled = true
      return uncertain(gate.risk, waited.error)
    }

    this.unsettled = true
    return {
      kind: 'uncertain',
      risk: gate.risk,
      summary: waited.reason === 'aborted' ? abortedUncertain : timedOut,
      actionOutcome: 'uncertain_after_timeout'
    }
  }
}

function uncertain(risk: RiskLevel, error: unknown): AuthorizedReport {
  const aborted = error instanceof Error && /abort|stopped/i.test(error.message)
  return {
    kind: 'uncertain',
    risk,
    summary: aborted ? abortedUncertain : timedOut,
    actionOutcome: 'uncertain_after_timeout'
  }
}

function isUnresolvedNativeStop(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  return (
    code === 'aborted' ||
    error.message === 'That took too long, so I stopped.' ||
    error.message === 'timeout' ||
    code === 'timeout' ||
    code === 'uncertain'
  )
}

const uiMutationTools = new Set([
  'ui.press',
  'desktop.clickElement',
  'desktop.setText',
  'browser.click',
  'browser.fill'
])

function uiMutation(tool: string): boolean {
  return uiMutationTools.has(tool)
}

function approvedTarget(payloadJson: string): ReturnType<typeof targetIdentityFrom> | null {
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return targetIdentityFrom(parsed as Record<string, unknown>)
  } catch {
    return null
  }
}

function isPlainRecord(value: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

type Settlement =
  | { kind: 'value'; value: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'uncertain'; reason: 'timeout' | 'aborted' }

function waitForSettlement(
  work: Promise<unknown>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Settlement> {
  return new Promise((resolve) => {
    let done = false
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: Settlement): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      if (abortTimer) {
        clearTimeout(abortTimer)
      }
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ kind: 'uncertain', reason: 'timeout' }), timeoutMs)
    const onAbort = (): void => {
      abortTimer = setTimeout(() => finish({ kind: 'uncertain', reason: 'aborted' }), 0)
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    work.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error })
    )
  })
}
