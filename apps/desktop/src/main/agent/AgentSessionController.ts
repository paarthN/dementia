import { randomUUID } from 'node:crypto'

export class AgentSessionController {
  private active: { id: string; controller: AbortController } | null = null

  begin(
    goal: string
  ): { ok: true; id: string; signal: AbortSignal } | { ok: false; summary: string } {
    if (!goal.trim()) {
      return { ok: false, summary: 'Type a request before starting a task.' }
    }
    if (this.active) {
      return { ok: false, summary: 'A task is already running.' }
    }
    const controller = new AbortController()
    const id = randomUUID()
    this.active = { id, controller }
    return { ok: true, id, signal: controller.signal }
  }

  owns(taskId: string): boolean {
    return this.active?.id === taskId
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
