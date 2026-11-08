import type { ActiveTaskView, ChatMessage, PendingApproval, TaskState } from './agent'

const liveStates = new Set<TaskState>([
  'created',
  'planning',
  'awaiting_permission',
  'awaiting_confirmation',
  'executing',
  'verifying'
])

export interface AgentProgressInput {
  messages: Array<Pick<ChatMessage, 'role' | 'text' | 'kind'>>
  activeTask: ActiveTaskView | null
  pendingApproval: PendingApproval | null
}

export interface AgentProgressView {
  status: string
  goal: string | null
  now: string | null
  finished: string | null
  blocksComposer: boolean
  stopTaskId: string | null
  approval: {
    taskId: string
    approvalId: string
    what: string
    change: string
    confirmLabel: string
    editText: string | null
  } | null
  permission: {
    taskId: string
    reason: string
    goal: string | null
  } | null
}

const screenReason =
  "I can't see the screen without permission. You can describe the message, or turn on screen access for this request."

export function agentProgressView(input: AgentProgressInput): AgentProgressView | null {
  const task = input.activeTask
  const approval = input.pendingApproval
  const live = task !== null && liveStates.has(task.state)
  if (!live && !approval) {
    return null
  }

  const goal = lastUserText(input.messages)
  const waitingForApproval = approval !== null && task?.state !== 'awaiting_permission'
  const waitingForPermission = task?.state === 'awaiting_permission' && approval === null
  const status = waitingForApproval
    ? 'Waiting for you'
    : waitingForPermission
      ? 'Waiting for screen access'
      : stateLabel(task?.state ?? 'executing')
  const now = currentAction(task, waitingForApproval, waitingForPermission)
  const finished = latestVerified(input.messages, now)

  return {
    status,
    goal,
    now,
    finished,
    blocksComposer: waitingForApproval || waitingForPermission,
    stopTaskId: task && !waitingForApproval && !waitingForPermission && live ? task.id : null,
    approval: waitingForApproval
      ? {
          taskId: approval.taskId,
          approvalId: approval.approvalId,
          what: approval.summary,
          change: changeLine(approval.confirmLabel),
          confirmLabel: approval.confirmLabel,
          editText: goal
        }
      : null,
    permission: waitingForPermission
      ? {
          taskId: task.id,
          reason: task.summary?.trim() || screenReason,
          goal
        }
      : null
  }
}

/** Spoken words stay in the message box. They are not an approval. */
export function draftFromSpeech(currentDraft: string, transcript: string): string {
  return [currentDraft.trim(), transcript.trim()].filter(Boolean).join(' ').trim()
}

function lastUserText(messages: AgentProgressInput['messages']): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.text.trim()) {
      return message.text.trim()
    }
  }
  return null
}

function latestVerified(
  messages: AgentProgressInput['messages'],
  now: string | null
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') {
      continue
    }
    if (message.kind !== 'success') {
      return null
    }
    const text = message.text.trim()
    if (!text || text === now) {
      return null
    }
    return text
  }
  return null
}

function currentAction(
  task: ActiveTaskView | null,
  waitingForApproval: boolean,
  waitingForPermission: boolean
): string | null {
  if (waitingForApproval || waitingForPermission || !task?.summary?.trim()) {
    return null
  }
  const summary = task.summary.trim()
  if (summary === stateLabel(task.state)) {
    return null
  }
  return summary
}

function stateLabel(state: TaskState): string {
  switch (state) {
    case 'created':
      return 'Getting ready'
    case 'planning':
      return 'Deciding the next step'
    case 'awaiting_permission':
      return 'Waiting for screen access'
    case 'awaiting_confirmation':
      return 'Waiting for you'
    case 'executing':
      return 'Working on it'
    case 'verifying':
      return 'Checking what happened'
    default:
      return 'Working on it'
  }
}

function changeLine(confirmLabel: string): string {
  switch (confirmLabel) {
    case 'Open website':
      return 'This will open a website in your browser.'
    case 'Send email':
      return 'This will send an email.'
    case 'Set reminder':
      return 'This will save a reminder on this computer.'
    case 'Cancel reminder':
      return 'This will cancel that reminder.'
    case 'Press it':
      return 'This will press one control in the other app.'
    default:
      return 'This will go ahead with the action described above.'
  }
}
