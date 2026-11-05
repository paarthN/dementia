export const reminderStatuses = ['scheduled', 'fired', 'completed', 'cancelled', 'missed'] as const
export type ReminderStatus = (typeof reminderStatuses)[number]
export type ReminderSource = 'user' | 'assistant'

export interface Reminder {
  id: string
  title: string
  notes?: string
  triggerAtUtc: string
  timezone: string
  status: ReminderStatus
  createdAtUtc: string
  updatedAtUtc: string
  source: ReminderSource
}

export interface DueReminder {
  reminderId: string
  kind: 'due' | 'missed'
  summary: string
}

export interface ReminderCommandResult {
  status: 'saved' | 'failed' | 'needs_input'
  summary: string
}

export function reminderNotificationCopy(
  kind: 'due' | 'missed',
  title: string,
  enabled: boolean
): { title: string; body: string } | null {
  if (!enabled) {
    return null
  }
  return {
    title: kind === 'missed' ? 'You missed a reminder' : 'Reminder',
    body: title
  }
}
