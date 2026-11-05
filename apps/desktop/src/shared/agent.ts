import { z } from 'zod'

export const assistantIntents = [
  'open_app',
  'open_website',
  'search_web',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'change_companion_visuals',
  'open_system_settings',
  'explain_screen',
  'guide_task',
  'general_question',
  'unsupported'
] as const

export const assistantModes = ['execute', 'guide', 'explain', 'answer'] as const

export const riskLevels = ['R0', 'R1', 'R2', 'R3', 'R4'] as const

export const toolStatuses = [
  'succeeded',
  'failed',
  'unsupported',
  'requires_confirmation',
  'requires_permission',
  'cancelled'
] as const

export const verificationMethods = [
  'os',
  'accessibility',
  'local_state',
  'provider_api',
  'none'
] as const

export const taskStates = [
  'created',
  'planning',
  'awaiting_permission',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'completed',
  'failed',
  'cancelled'
] as const

export const responseStates = [
  'answer',
  'plan',
  'needs_input',
  'needs_permission',
  'needs_confirmation',
  'running',
  'success',
  'partial',
  'failure',
  'cancelled'
] as const

export const stepStatuses = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped'
] as const

export const routedRequestSchema = z
  .object({
    intent: z.enum(assistantIntents),
    mode: z.enum(assistantModes),
    parameters: z.record(z.string(), z.unknown()),
    missingRequiredFields: z.array(z.string()),
    requiresScreenContext: z.boolean(),
    userFacingClarification: z.string().optional()
  })
  .strict()

export const plannedToolCallSchema = z
  .object({
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown())
  })
  .strict()

export const plannedStepSchema = z
  .object({
    id: z.string().min(1),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    risk: z.enum(riskLevels),
    status: z.enum(stepStatuses)
  })
  .strict()

export const toolResultSchema = z
  .object({
    status: z.enum(toolStatuses),
    summary: z.string().min(1),
    data: z.unknown().optional(),
    errorCode: z.string().optional(),
    recovery: z
      .array(
        z
          .object({
            label: z.string().min(1),
            actionKey: z.string().min(1)
          })
          .strict()
      )
      .optional(),
    verification: z
      .object({
        method: z.enum(verificationMethods),
        passed: z.boolean(),
        details: z.string().optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine((result) => result.status !== 'succeeded' || result.verification?.passed === true, {
    message: 'A succeeded tool result needs a passing verification'
  })

export const assistantTaskSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string(),
    mode: z.enum(['execute', 'guide', 'explain']),
    state: z.enum(taskStates),
    steps: z.array(plannedStepSchema),
    currentStepIndex: z.number().int().min(0),
    createdAtUtc: z.string().min(1),
    updatedAtUtc: z.string().min(1),
    cancellationRequested: z.boolean(),
    safeSummary: z.string().optional()
  })
  .strict()

export type AssistantIntent = (typeof assistantIntents)[number]
export type AssistantMode = (typeof assistantModes)[number]
export type RiskLevel = (typeof riskLevels)[number]
export type ToolStatus = (typeof toolStatuses)[number]
export type TaskState = (typeof taskStates)[number]
export type ResponseState = (typeof responseStates)[number]
export type RoutedRequest = z.infer<typeof routedRequestSchema>
export type PlannedToolCall = z.infer<typeof plannedToolCallSchema>
export type PlannedStep = z.infer<typeof plannedStepSchema>
export type ToolResult = z.infer<typeof toolResultSchema>
export type AssistantTask = z.infer<typeof assistantTaskSchema>

export interface PendingApproval {
  taskId: string
  approvalId: string
  summary: string
  confirmLabel: string
  expiresAtUtc: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  kind: 'text' | 'error' | 'status' | 'success'
  createdAtUtc: string
  recovery?: { label: string; actionKey: string }[]
}

export interface ActiveTaskView {
  id: string
  state: TaskState
  summary: string | null
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    )
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]))
  }
  return value
}
