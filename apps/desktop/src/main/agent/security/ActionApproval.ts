import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../../../shared/agent'
import { normalizeControlName } from '../../../shared/controls'

export interface TargetIdentity {
  name: string
  role: string
  appName: string
  windowId: string
  observationId: string
}

export interface HeldApproval {
  approvalId: string
  taskId: string
  stepId: string
  tool: string
  payloadJson: string
  target: TargetIdentity
  observationId: string
  expiresAtUtc: string
  used: boolean
}

export function targetIdentityFrom(input: Record<string, unknown>): TargetIdentity {
  return {
    name: text(input.name),
    role: text(input.role),
    appName: text(input.appName),
    windowId: text(input.windowId),
    observationId: text(input.observationId) || text(input.snapshotId)
  }
}

export function sameTargetIdentity(approved: TargetIdentity, live: TargetIdentity): boolean {
  if (!approved.name || !live.name) {
    return false
  }
  if (normalizeControlName(approved.name) !== normalizeControlName(live.name)) {
    return false
  }
  if (approved.role && approved.role !== live.role) {
    return false
  }
  if (
    approved.appName &&
    normalizeControlName(approved.appName) !== normalizeControlName(live.appName)
  ) {
    return false
  }
  if (approved.windowId && approved.windowId !== live.windowId) {
    return false
  }
  return true
}

export function createHeldApproval(input: {
  taskId: string
  stepId: string
  tool: string
  args: Record<string, unknown>
  now: Date
  ttlMs: number
}): HeldApproval {
  const target = targetIdentityFrom(input.args)
  return {
    approvalId: randomUUID(),
    taskId: input.taskId,
    stepId: input.stepId,
    tool: input.tool,
    payloadJson: canonicalJson(input.args),
    target,
    observationId: target.observationId,
    expiresAtUtc: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    used: false
  }
}

export function consumeHeldApproval(
  approval: HeldApproval,
  attempt: { approvalId: string; now: Date; liveTarget: TargetIdentity | null }
): { ok: true } | { ok: false; reason: string } {
  if (approval.used || attempt.approvalId !== approval.approvalId) {
    return { ok: false, reason: "That confirmation doesn't match the action." }
  }
  if (Date.parse(approval.expiresAtUtc) <= attempt.now.getTime()) {
    approval.used = true
    return {
      ok: false,
      reason: 'That confirmation expired. Ask me again if you still want it.'
    }
  }
  approval.used = true
  if (!attempt.liveTarget || !sameTargetIdentity(approval.target, attempt.liveTarget)) {
    return { ok: false, reason: 'The control changed, so I did not press it.' }
  }
  return { ok: true }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
