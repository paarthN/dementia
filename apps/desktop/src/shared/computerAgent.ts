import { z } from 'zod'

export const computerAgentStates = [
  'idle',
  'observing',
  'planning',
  'awaiting_permission',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'paused',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'uncertain',
  'interrupted'
] as const

export const computerAgentEvents = [
  'start',
  'observed',
  'begin_execution',
  'need_permission',
  'need_confirmation',
  'approved',
  'executed',
  'verified_continue',
  'verified_done',
  'pause',
  'resume',
  'stop',
  'fail',
  'uncertain',
  'interrupt',
  'limit',
  'known_stop',
  'step_failed'
] as const

export const actionOutcomes = [
  'success_verified',
  'changed_but_unverified',
  'no_change',
  'ambiguous_target',
  'needs_permission',
  'needs_approval',
  'blocked_sensitive',
  'failed',
  'cancelled',
  'uncertain_after_timeout'
] as const

export const computerAgentStateSchema = z.enum(computerAgentStates)
export const computerAgentEventSchema = z.enum(computerAgentEvents)
export const actionOutcomeSchema = z.enum(actionOutcomes)

export const safeObservationSchema = z
  .object({
    snapshotId: z.string().min(1),
    appName: z.string().min(1),
    capturedAtUtc: z.string().min(1)
  })
  .strict()

export const agentProgressSchema = z
  .object({
    state: computerAgentStateSchema,
    summary: z.string().min(1)
  })
  .strict()

export const fakeAgentChoiceSchema = z.union([
  z
    .object({
      type: z.literal('tool_call'),
      tool: z.string().min(1),
      args: z.record(z.string(), z.unknown())
    })
    .strict(),
  z
    .object({
      type: z.literal('final'),
      text: z.string().min(1)
    })
    .strict(),
  z
    .object({
      type: z.literal('refusal'),
      text: z.string().min(1)
    })
    .strict()
])

export type ComputerAgentState = (typeof computerAgentStates)[number]
export type ComputerAgentEvent = (typeof computerAgentEvents)[number]
export type ActionOutcome = (typeof actionOutcomes)[number]
export type SafeObservation = z.infer<typeof safeObservationSchema>
export type AgentProgress = z.infer<typeof agentProgressSchema>
export type FakeAgentChoice = z.infer<typeof fakeAgentChoiceSchema>

export interface AgentRunResult {
  taskId: string | null
  state: ComputerAgentState
  summary: string
  progress: AgentProgress[]
  actionOutcome: ActionOutcome
}
