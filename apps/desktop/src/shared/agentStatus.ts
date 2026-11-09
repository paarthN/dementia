import { z } from 'zod'
import { computerAgentStateSchema, type ComputerAgentState } from './computerAgent'

const bareConfirmation = /^(ok|okay|yes)$/i
const picturePayload = /data:image|base64,/i

const approvalCardSchema = z
  .object({
    approvalId: z.string().min(1).max(80),
    what: z.string().min(1).max(240),
    confirmLabel: z
      .string()
      .min(2)
      .max(40)
      .refine((label) => !bareConfirmation.test(label))
  })
  .strict()

export const agentStatusSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    goal: z.string().min(1).max(240),
    state: computerAgentStateSchema,
    current: z.string().min(1).max(200),
    completed: z.string().max(200).nullable(),
    step: z.number().int().min(0).max(20),
    verified: z.boolean(),
    approval: approvalCardSchema.nullable(),
    permissionReason: z.string().max(240).nullable(),
    observing: z.boolean()
  })
  .strict()

export type AgentStatus = z.infer<typeof agentStatusSchema>

const terminalStates = new Set<ComputerAgentState>([
  'idle',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'uncertain',
  'interrupted'
])

export function agentBusy(status: AgentStatus | null): boolean {
  if (!status) {
    return false
  }
  return !terminalStates.has(status.state)
}

export function acceptAgentStatusEvent(payload: unknown): AgentStatus | null | undefined {
  if (payload == null) {
    return null
  }
  const text = JSON.stringify(payload)
  if (picturePayload.test(text)) {
    return undefined
  }
  const parsed = agentStatusSchema.safeParse(payload)
  return parsed.success ? parsed.data : undefined
}

export function confirmationFromSpeech(text: string): null {
  return text ? null : null
}

export function chatSubmitEffect(input: {
  agentBusy: boolean
  approvalVisible: boolean
}): 'send' | 'hold-approval' | 'hold-busy' {
  if (input.approvalVisible) {
    return 'hold-approval'
  }
  if (input.agentBusy) {
    return 'hold-busy'
  }
  return 'send'
}

export function describeToolAction(tool: string, args: Record<string, unknown>): string {
  if (tool === 'task.setGoalChecks') {
    return 'Writing the checks for this request.'
  }
  if (tool === 'apps.open') {
    return `Opening ${field(args.displayName, 'the app')}.`
  }
  if (tool === 'browser.open' || tool === 'browser.openUrl') {
    return 'Opening the page.'
  }
  if (tool === 'desktop.clickPoint') {
    return 'Clicking one spot in the window.'
  }
  if (typing(tool, args)) {
    return `Typing into ${field(args.name, 'the field')}.`
  }
  if (field(args.name, '')) {
    return `Pressing ${field(args.name, 'the control')}.`
  }
  return 'Working on the next step.'
}

export function completedToolAction(tool: string, args: Record<string, unknown>): string {
  const current = describeToolAction(tool, args)
  if (current.startsWith('Opening ')) {
    return current.replace('Opening ', 'Opened ')
  }
  if (current.startsWith('Typing into ')) {
    return current.replace('Typing into ', 'Typed into ')
  }
  if (current.startsWith('Pressing ')) {
    return current.replace('Pressing ', 'Pressed ')
  }
  if (current.startsWith('Clicking ')) {
    return current.replace('Clicking ', 'Clicked ')
  }
  return 'Finished that step.'
}

export const taskScopeTool = 'task.scope'

export function confirmLabelFor(tool: string, args: Record<string, unknown>): string {
  const name = field(args.name, '')
  if (tool === taskScopeTool) {
    return clip(`Allow in ${field(args.appName, 'this app')}`)
  }
  if (tool === 'desktop.clickPoint') {
    return 'Click that spot'
  }
  if (typing(tool, args) && name) {
    return clip(`Type into ${name}`)
  }
  if (name) {
    return clip(name.toLowerCase() === 'ok' ? 'Press OK' : `Press ${name}`)
  }
  if (tool === 'apps.open') {
    return clip(`Open ${field(args.displayName, 'the app')}`)
  }
  return 'Continue'
}

export function approvalWhat(tool: string, args: Record<string, unknown>): string {
  const name = field(args.name, 'that control')
  if (tool === taskScopeTool) {
    const where = field(args.appName, 'this app')
    return `Let me click and type in ${where} to finish this. I will still ask before anything that sends, buys, deletes, uploads, or pays, and I will not type a password.`.slice(
      0,
      240
    )
  }
  const app = field(args.appName, '')
  const where = app ? `${name} in ${app}` : name
  if (tool === 'desktop.clickPoint') {
    return 'Click one spot in the window.'
  }
  if (typing(tool, args)) {
    return `Type into ${where}.`
  }
  if (field(args.name, '')) {
    return `Press ${where}.`
  }
  if (tool === 'apps.open') {
    return `Open ${field(args.displayName, 'the app')}.`
  }
  return 'This action needs your approval.'
}

function typing(tool: string, args: Record<string, unknown>): boolean {
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  return (
    text.length > 0 &&
    (tool === 'desktop.setText' || tool === 'browser.fill' || tool === 'ui.press')
  )
}

function field(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const cleaned = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 40)
  return cleaned || fallback
}

function clip(value: string): string {
  return value.slice(0, 40)
}
