import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Reminder, ReminderSource, ReminderStatus } from '../../shared/reminders'

interface ReminderRow {
  id: string
  title: string
  notes: string | null
  trigger_at_utc: string
  timezone: string
  status: Reminder['status']
  created_at_utc: string
  updated_at_utc: string
  source: Reminder['source']
}

export function insertReminder(
  db: DatabaseSync,
  input: {
    title: string
    notes?: string
    triggerAtUtc: string
    timezone: string
    source: ReminderSource
    now: Date
  }
): Reminder {
  const id = randomUUID()
  const timestamp = input.now.toISOString()
  db.prepare(
    `INSERT INTO reminders
      (id, title, notes, trigger_at_utc, timezone, status, created_at_utc, updated_at_utc, source)
     VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`
  ).run(
    id,
    input.title,
    input.notes ?? null,
    input.triggerAtUtc,
    input.timezone,
    timestamp,
    timestamp,
    input.source
  )
  const saved = getReminder(db, id)
  if (!saved) {
    throw new Error('Reminder insert failed')
  }
  return saved
}

export function listReminders(db: DatabaseSync): Reminder[] {
  const rows = db
    .prepare(
      `SELECT id, title, notes, trigger_at_utc, timezone, status, created_at_utc, updated_at_utc, source
       FROM reminders
       ORDER BY trigger_at_utc ASC`
    )
    .all() as unknown as ReminderRow[]
  return rows.map(toReminder)
}

export function getReminder(db: DatabaseSync, id: string): Reminder | null {
  const row = db
    .prepare(
      `SELECT id, title, notes, trigger_at_utc, timezone, status, created_at_utc, updated_at_utc, source
       FROM reminders WHERE id = ?`
    )
    .get(id) as ReminderRow | undefined
  return row ? toReminder(row) : null
}

export function updateReminder(
  db: DatabaseSync,
  id: string,
  patch: { status?: ReminderStatus; triggerAtUtc?: string; now: Date }
): Reminder | null {
  const current = getReminder(db, id)
  if (!current) {
    return null
  }
  db.prepare(
    `UPDATE reminders
     SET status = ?, trigger_at_utc = ?, updated_at_utc = ?
     WHERE id = ?`
  ).run(
    patch.status ?? current.status,
    patch.triggerAtUtc ?? current.triggerAtUtc,
    patch.now.toISOString(),
    id
  )
  return getReminder(db, id)
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes ?? undefined,
    triggerAtUtc: row.trigger_at_utc,
    timezone: row.timezone,
    status: row.status,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    source: row.source
  }
}
