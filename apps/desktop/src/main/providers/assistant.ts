import { acceptModelPlan } from '../../shared/assistant'
import type { RoutedRequest } from '../../shared/agent'

export class AssistantPlanRejected extends Error {
  constructor() {
    super('rejected')
    this.name = 'AssistantPlanRejected'
  }
}

export class AssistantUnavailable extends Error {
  constructor() {
    super('unavailable')
    this.name = 'AssistantUnavailable'
  }
}

export interface AssistantProvider {
  interpret(text: string): Promise<RoutedRequest>
}

interface RemoteOptions {
  origin: () => string
  token?: () => string | undefined
  timeoutMs?: number
  now?: () => number
  fetch?: typeof fetch
  maxPerMinute?: number
}

export function createRemoteAssistant(options: RemoteOptions): AssistantProvider {
  const timeoutMs = options.timeoutMs ?? 12_000
  const maxPerMinute = options.maxPerMinute ?? 30
  const stamps: number[] = []
  const fetchImpl = options.fetch ?? fetch

  return {
    async interpret(text) {
      const now = options.now?.() ?? Date.now()
      while (stamps.length > 0 && stamps[0] <= now - 60_000) {
        stamps.shift()
      }
      if (stamps.length >= maxPerMinute) {
        throw new AssistantUnavailable()
      }
      stamps.push(now)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        const token = options.token?.()
        if (token) {
          headers.authorization = `Bearer ${token}`
        }
        const response = await fetchImpl(`${options.origin()}/v1/interpret`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ text }),
          signal: controller.signal
        })
        const payload: unknown = await response.json()
        if (!response.ok) {
          const error = payload as { error?: string }
          if (error.error === 'rejected') {
            throw new AssistantPlanRejected()
          }
          throw new AssistantUnavailable()
        }
        const request = (payload as { request?: unknown }).request
        const plan = acceptModelPlan(request)
        if (!plan) {
          throw new AssistantPlanRejected()
        }
        return plan
      } catch (error) {
        if (error instanceof AssistantPlanRejected || error instanceof AssistantUnavailable) {
          throw error
        }
        throw new AssistantUnavailable()
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
