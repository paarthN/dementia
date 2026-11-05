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

export const maxModelImageChars = 180_000

export const modelTargetSchema = z
  .object({
    id: z.string().min(1).max(80),
    role: z.string().min(1).max(80),
    name: z.string().max(120),
    enabled: z.boolean()
  })
  .strict()

export const safeObservationSchema = z
  .object({
    snapshotId: z.string().min(1).max(80),
    appName: z.string().min(1).max(120),
    capturedAtUtc: z.string().min(1).max(40),
    windowTitle: z.string().max(200).optional(),
    untrustedText: z.string().max(2_000).optional(),
    targets: z.array(modelTargetSchema).max(40).optional(),
    imageBase64: z.string().max(maxModelImageChars).optional()
  })
  .strict()

export const safeToolResultSchema = z
  .object({
    tool: z.string().min(1).max(80),
    status: z.string().min(1).max(40),
    summary: z.string().min(1).max(500),
    verified: z.boolean()
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
      args: z.record(z.string(), z.unknown()),
      responseId: z.string().min(1).max(128).optional(),
      callId: z.string().min(1).max(64).optional()
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
export type SafeToolResult = z.infer<typeof safeToolResultSchema>
export type AgentProgress = z.infer<typeof agentProgressSchema>
export type FakeAgentChoice = z.infer<typeof fakeAgentChoiceSchema>

export const agentTurnResponseSchema = z.union([
  z
    .object({
      type: z.literal('tool_call'),
      responseId: z.string().min(1).max(128),
      callId: z.string().min(1).max(64),
      tool: z.string().min(1).max(80),
      args: z.record(z.string(), z.unknown())
    })
    .strict(),
  z
    .object({
      type: z.literal('final'),
      text: z.string().min(1).max(2_000),
      completion: z.enum(['claimed', 'unable', 'needs_input'])
    })
    .strict(),
  z
    .object({
      type: z.literal('refusal'),
      text: z.string().min(1).max(500)
    })
    .strict()
])

export interface AgentTurn {
  taskId: string
  goal: string
  stepNumber: number
  summary: string
  observation: SafeObservation
  screenShare: boolean
  continuation?: { responseId: string; callId: string }
  lastToolResult?: SafeToolResult
}

export interface AgentRunResult {
  taskId: string | null
  state: ComputerAgentState
  summary: string
  progress: AgentProgress[]
  actionOutcome: ActionOutcome
}
