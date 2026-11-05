import {
  agentTurnResponseSchema,
  safeToolResultSchema,
  type AgentTurn,
  type FakeAgentChoice
} from '../../shared/computerAgent'
import type { UserPreferences } from '../../shared/preferences'
import { prepareModelObservation, redactSecretText } from './AgentPrompt'
import { runAgent, type AgentProvider } from './AgentRunner'

const stopped = { type: 'refusal' as const, text: 'I stopped.' }
const slow = { type: 'refusal' as const, text: 'The assistant took too long.' }
const unreachable = { type: 'refusal' as const, text: "I couldn't reach the assistant service." }
const unusable = { type: 'refusal' as const, text: "I couldn't use that step." }

export function cloudAgentConsent(privacy: UserPreferences['privacy']): boolean {
  return (
    privacy.assistantMode === 'cloud' &&
    Boolean(privacy.cloudConsentAtUtc) &&
    Boolean(privacy.assistantOrigin)
  )
}

export function createAgentProviderClient(options: {
  origin: () => string
  token?: () => string | undefined
  timeoutMs?: number
  fetch?: typeof fetch
}): AgentProvider {
  const timeoutMs = options.timeoutMs ?? 20_000
  const fetchImpl = options.fetch ?? fetch
  return {
    async next(turn, taskSignal) {
      if (taskSignal.aborted) {
        return stopped
      }
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([taskSignal, timeout])
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        const token = options.token?.()
        if (token) {
          headers.authorization = `Bearer ${token}`
        }
        const response = await fetchImpl(`${options.origin().replace(/\/$/, '')}/v1/agent/turn`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody(turn)),
          signal
        })
        if (taskSignal.aborted) {
          return stopped
        }
        const payload: unknown = await response.json()
        if (taskSignal.aborted) {
          return stopped
        }
        if (!response.ok) {
          return refusalFor(payload)
        }
        const parsed = agentTurnResponseSchema.safeParse(payload)
        if (!parsed.success) {
          return unusable
        }
        if (parsed.data.type === 'tool_call') {
          return {
            type: 'tool_call',
            tool: parsed.data.tool,
            args: parsed.data.args,
            responseId: parsed.data.responseId,
            callId: parsed.data.callId
          }
        }
        if (parsed.data.type === 'final') {
          return { type: 'final', text: parsed.data.text }
        }
        return { type: 'refusal', text: parsed.data.text }
      } catch {
        if (taskSignal.aborted) {
          return stopped
        }
        return timeout.aborted ? slow : unreachable
      }
    }
  }
}

export async function runConsentedAgent(
  options: Omit<Parameters<typeof runAgent>[0], 'provider'> & {
    consented: boolean
    remote: AgentProvider
  }
): Promise<Awaited<ReturnType<typeof runAgent>>> {
  if (!options.consented) {
    return {
      taskId: null,
      state: 'awaiting_permission',
      summary: 'Cloud assistant is off until you allow it in Settings.',
      progress: [],
      actionOutcome: 'needs_permission'
    }
  }
  return runAgent({ ...options, provider: options.remote })
}

function requestBody(turn: AgentTurn): Record<string, unknown> {
  const observation = prepareModelObservation(turn.observation, turn.screenShare)
  const body: Record<string, unknown> = {
    taskId: turn.taskId,
    goal: redactSecretText(turn.goal).slice(0, 2_000),
    context: {
      stepNumber: turn.stepNumber,
      summary: redactSecretText(turn.summary).slice(0, 500),
      screenShare: turn.screenShare,
      observation
    }
  }
  if (turn.continuation && turn.lastToolResult) {
    const result = safeToolResultSchema.safeParse({
      ...turn.lastToolResult,
      summary: redactSecretText(turn.lastToolResult.summary).slice(0, 500)
    })
    if (result.success) {
      body.continuation = turn.continuation
      body.lastToolResult = result.data
    }
  }
  return body
}

function refusalFor(payload: unknown): FakeAgentChoice {
  const error =
    payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? '')
      : ''
  if (error === 'forbidden_tool' || error === 'multiple_tools') {
    return { type: 'refusal', text: "I can't do that." }
  }
  if (error === 'cancelled') {
    return stopped
  }
  if (error === 'timeout') {
    return slow
  }
  if (error === 'invalid_json' || error === 'rejected') {
    return unusable
  }
  return unreachable
}
