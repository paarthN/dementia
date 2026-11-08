import type { DatabaseSync } from 'node:sqlite'
import { formatLocalLabel, resolveZonedLocalTime } from '../../shared/reminderTime'
import type { Reminder, ReminderSource } from '../../shared/reminders'
import { getReminder, insertReminder, listReminders, updateReminder } from '../storage/reminders'

export interface ReminderNotice {
  kind: 'due' | 'missed'
  reminder: Reminder
  summary: string
}

export interface TimerPort {
  set: (delayMs: number, fn: () => void) => unknown
  clear: (handle: unknown) => void
}

export interface ReminderPort {
  create(input: {
    title: string
    triggerAtUtc: string
    timezone: string
    source: ReminderSource
  }): { ok: true; reminder: Reminder; summary: string } | { ok: false; summary: string }
  list(range: 'all' | 'week'): Reminder[]
  cancelQuery(query: string): { ok: boolean; summary: string }
  describe(reminder: Reminder): string
}

export function createReminderScheduler(options: {
  db: DatabaseSync
  now: () => Date
  timer: TimerPort
  notify: (notice: ReminderNotice) => void
}): ReminderPort & {
  start: () => ReminderNotice[]
  arm: (id: string) => void
  cancel: (id: string) => Reminder | null
  snooze: (id: string, minutes?: number) => Reminder | null
  complete: (id: string) => Reminder | null
} {
  const timers = new Map<string, unknown>()

  function clearTimer(id: string): void {
    const handle = timers.get(id)
    if (handle !== undefined) {
      options.timer.clear(handle)
      timers.delete(id)
    }
  }

  function arm(id: string): void {
    clearTimer(id)
    const reminder = getReminder(options.db, id)
    if (!reminder || reminder.status !== 'scheduled') {
      return
    }
    const delay = new Date(reminder.triggerAtUtc).getTime() - options.now().getTime()
    if (delay <= 0) {
      return
    }
    const maxTimerDelayMs = 2_147_483_647
    const slice = Math.min(delay, maxTimerDelayMs)
    const handle = options.timer.set(slice, () => {
      timers.delete(id)
      if (slice < delay) {
        const current = getReminder(options.db, id)
        if (!current || current.status !== 'scheduled') {
          return
        }
        if (new Date(current.triggerAtUtc).getTime() <= options.now().getTime()) {
          fire(id)
          return
        }
        arm(id)
        return
      }
      fire(id)
    })
    timers.set(id, handle)
  }

  function fire(id: string): void {
    const reminder = getReminder(options.db, id)
    if (!reminder || reminder.status !== 'scheduled') {
      return
    }
    const updated = updateReminder(options.db, id, { status: 'fired', now: options.now() })
    if (!updated) {
      return
    }
    options.notify({ kind: 'due', reminder: updated, summary: `Reminder: ${updated.title}` })
  }

  function miss(reminder: Reminder): ReminderNotice | null {
    const updated = updateReminder(options.db, reminder.id, {
      status: 'missed',
      now: options.now()
    })
    if (!updated) {
      return null
    }
    const notice: ReminderNotice = {
      kind: 'missed',
      reminder: updated,
      summary: `Here's a reminder you missed: ${updated.title}.`
    }
    options.notify(notice)
    return notice
  }

  function create(input: {
    title: string
    triggerAtUtc: string
    timezone: string
    source: ReminderSource
  }): { ok: true; reminder: Reminder; summary: string } | { ok: false; summary: string } {
    const title = input.title.trim()
    if (!title) {
      return { ok: false, summary: 'What should I remind you about?' }
    }
    const when = new Date(input.triggerAtUtc)
    if (Number.isNaN(when.getTime()) || when.getTime() <= options.now().getTime()) {
      return { ok: false, summary: 'That time has passed. When should I remind you?' }
    }
    const reminder = insertReminder(options.db, {
      title,
      triggerAtUtc: when.toISOString(),
      timezone: input.timezone,
      source: input.source,
      now: options.now()
    })
    arm(reminder.id)
    const saved = getReminder(options.db, reminder.id)
    const summary = `Your reminder is set for ${formatLocalLabel(when, input.timezone)}.`
    if (!saved || saved.status !== 'scheduled') {
      return { ok: false, summary: "I tried, but couldn't confirm the reminder was saved." }
    }
    return { ok: true, reminder: saved, summary }
  }

  const port: ReminderPort = {
    create,
    list(range) {
      const now = options.now().getTime()
      const week = now + 7 * 24 * 60 * 60 * 1000
      return listReminders(options.db).filter((reminder) => {
        if (reminder.status === 'cancelled' || reminder.status === 'completed') {
          return false
        }
        if (range === 'all') {
          return true
        }
        const trigger = new Date(reminder.triggerAtUtc).getTime()
        return reminder.status === 'missed' || (trigger >= now && trigger <= week)
      })
    },
    cancelQuery(query) {
      const needle = query.trim().toLowerCase()
      const matches = listReminders(options.db).filter(
        (reminder) =>
          reminder.status === 'scheduled' && reminder.title.toLowerCase().includes(needle)
      )
      if (matches.length === 0) {
        return { ok: false, summary: "I couldn't find that reminder." }
      }
      if (matches.length > 1) {
        const names = matches.map((reminder) => describe(reminder)).join('; ')
        return { ok: false, summary: `Which reminder should I cancel? ${names}` }
      }
      const match = matches[0]
      if (!match) {
        return { ok: false, summary: "I couldn't find that reminder." }
      }
      const cancelled = cancel(match.id)
      if (!cancelled || cancelled.status !== 'cancelled') {
        return { ok: false, summary: "I couldn't cancel that reminder." }
      }
      return { ok: true, summary: `I cancelled the reminder to ${cancelled.title}.` }
    },
    describe
  }

  function describe(reminder: Reminder): string {
    return `${reminder.title}, ${formatLocalLabel(new Date(reminder.triggerAtUtc), reminder.timezone)}`
  }

  function cancel(id: string): Reminder | null {
    clearTimer(id)
    const current = getReminder(options.db, id)
    if (!current || current.status !== 'scheduled') {
      return current
    }
    return updateReminder(options.db, id, { status: 'cancelled', now: options.now() })
  }

  function snooze(id: string, minutes = 10): Reminder | null {
    const current = getReminder(options.db, id)
    if (!current || current.status === 'cancelled' || current.status === 'completed') {
      return current
    }
    const triggerAtUtc = new Date(options.now().getTime() + minutes * 60 * 1000).toISOString()
    clearTimer(id)
    const updated = updateReminder(options.db, id, {
      status: 'scheduled',
      triggerAtUtc,
      now: options.now()
    })
    if (updated) {
      arm(updated.id)
    }
    return updated
  }

  function complete(id: string): Reminder | null {
    clearTimer(id)
    const current = getReminder(options.db, id)
    if (!current || current.status === 'cancelled') {
      return current
    }
    return updateReminder(options.db, id, { status: 'completed', now: options.now() })
  }

  return {
    ...port,
    start() {
      const notices: ReminderNotice[] = []
      for (const reminder of listReminders(options.db)) {
        if (reminder.status !== 'scheduled') {
          continue
        }
        if (new Date(reminder.triggerAtUtc).getTime() <= options.now().getTime()) {
          clearTimer(reminder.id)
          const notice = miss(reminder)
          if (notice) {
            notices.push(notice)
          }
          continue
        }
        arm(reminder.id)
      }
      return notices
    },
    arm,
    cancel,
    snooze,
    complete
  }
}

export function createFromLocalParts(
  scheduler: Pick<ReminderPort, 'create'>,
  input: {
    title: string
    year: number
    month: number
    day: number
    hour: number
    minute: number
    timeZone: string
    source: ReminderSource
  }
): { status: 'saved' | 'needs_input' | 'failed'; summary: string } {
  let resolved: ReturnType<typeof resolveZonedLocalTime>
  try {
    resolved = resolveZonedLocalTime(
      {
        year: input.year,
        month: input.month,
        day: input.day,
        hour: input.hour,
        minute: input.minute
      },
      input.timeZone
    )
  } catch {
    return { status: 'failed', summary: "I couldn't understand that time zone." }
  }
  if (resolved.kind === 'ambiguous') {
    return {
      status: 'needs_input',
      summary:
        'That time happens twice when the clocks change. Do you mean before or after the change?'
    }
  }
  if (resolved.kind === 'skipped') {
    return {
      status: 'needs_input',
      summary: "That time doesn't happen when the clocks change. What time should I use?"
    }
  }
  const created = scheduler.create({
    title: input.title,
    triggerAtUtc: resolved.utc.toISOString(),
    timezone: input.timeZone,
    source: input.source
  })
  return created.ok
    ? { status: 'saved', summary: created.summary }
    : { status: 'failed', summary: created.summary }
}
