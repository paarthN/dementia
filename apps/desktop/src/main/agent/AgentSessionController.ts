import { randomUUID } from 'node:crypto'

export class AgentSessionController {
  private active: { id: string; controller: AbortController; expiresAtMs?: number } | null = null
  private paused = false
  private readonly waiters = new Set<() => void>()

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
    this.paused = false
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

  pause(taskId: string): void {
    if (this.active?.id !== taskId) {
      return
    }
    this.paused = true
  }

  resume(taskId: string): void {
    if (this.active?.id !== taskId) {
      return
    }
    this.paused = false
    this.wake()
  }

  isPaused(taskId: string): boolean {
    return this.active?.id === taskId && this.paused
  }

  async waitIfPaused(taskId: string, signal: AbortSignal): Promise<'run' | 'stopped'> {
    while (this.isPaused(taskId) && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.waiters.delete(done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        this.waiters.add(done)
        if (!this.isPaused(taskId) || signal.aborted) {
          done()
          return
        }
        signal.addEventListener('abort', done, { once: true })
      })
    }
    return signal.aborted ? 'stopped' : 'run'
  }

  stop(taskId: string): void {
    if (this.active?.id !== taskId) {
      return
    }
    this.paused = false
    this.active.controller.abort()
    this.wake()
  }

  finish(taskId: string): void {
    if (this.active?.id === taskId) {
      this.paused = false
      this.wake()
      this.active = null
    }
  }

  private wake(): void {
    for (const waiter of this.waiters) {
      waiter()
    }
    this.waiters.clear()
  }
}
