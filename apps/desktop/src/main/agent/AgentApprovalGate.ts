import type { TargetIdentity, HeldApproval } from './security/ActionApproval'

export type AgentApprovalDecision =
  { approved: true; liveTarget: TargetIdentity | null } | { approved: false }

export class AgentApprovalGate {
  private pending: {
    approval: HeldApproval
    resolve: (decision: AgentApprovalDecision) => void
  } | null = null

  current(): HeldApproval | null {
    return this.pending?.approval ?? null
  }

  wait(approval: HeldApproval, signal: AbortSignal): Promise<AgentApprovalDecision> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ approved: false })
        return
      }
      const finish = (decision: AgentApprovalDecision): void => {
        if (this.pending?.approval.approvalId === approval.approvalId) {
          this.pending = null
        }
        signal.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = (): void => finish({ approved: false })
      this.pending = { approval, resolve: finish }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  confirm(taskId: string, approvalId: string, liveTarget: TargetIdentity | null): boolean {
    const pending = this.pending
    if (
      !pending ||
      pending.approval.taskId !== taskId ||
      pending.approval.approvalId !== approvalId
    ) {
      return false
    }
    pending.resolve({ approved: true, liveTarget })
    return true
  }

  decline(taskId: string): boolean {
    const pending = this.pending
    if (!pending || pending.approval.taskId !== taskId) {
      return false
    }
    pending.resolve({ approved: false })
    return true
  }
}
