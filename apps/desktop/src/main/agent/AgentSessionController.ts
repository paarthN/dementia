import { randomUUID } from 'node:crypto'

export class AgentSessionController {
  private active: { id: string; controller: AbortController; expiresAtMs?: number } | null = null

  begin(
    goal: string,
    expiresAtMs?: number
  ): { ok: true; id: string; signal: AbortSignal } | { ok: false; summary: string } {
    if (!goal.trim()) {
      return { ok: false, summary: 'Type a request before starting a task.' }
    }
    if (this.active) {
      return { ok: false, summary: 'A task is already running.' }
    }
    const controller = new AbortController()
    const id = randomUUID()
    this.active = { id, controller, ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) }
    return { ok: true, id, signal: controller.signal }
  }

  activeId(): string | null {
    return this.active?.id ?? null
  }

  owns(taskId: string, nowMs = Date.now()): boolean {
    if (this.active?.id !== taskId) {
      return false
    }
    if (this.active.expiresAtMs !== undefined && nowMs >= this.active.expiresAtMs) {
      return false
    }
    return true
  }

  stop(taskId: string): void {
    if (this.active?.id !== taskId) {
      return
    }
    this.active.controller.abort()
  }

  finish(taskId: string): void {
    if (this.active?.id === taskId) {
      this.active = null
    }
  }
}
