import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createReminderScheduler, type TimerPort } from '../src/main/services/reminderScheduler'
import { TaskOrchestrator } from '../src/main/services/taskOrchestrator'
import { openDatabase, savePreferences } from '../src/main/storage/database'
import { listReminders } from '../src/main/storage/reminders'
import { defaultPreferences, resetAppearance } from '../src/shared/preferences'
import { parseReminderRequest, resolveZonedLocalTime } from '../src/shared/reminderTime'
import { reminderNotificationCopy } from '../src/shared/reminders'

const zone = 'America/Los_Angeles'

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-rem-')), 'test.sqlite'))
}

function fakeTimer(): TimerPort & {
  pending: Array<{ delay: number; fn: () => void; cleared: boolean }>
} {
  const pending: Array<{ delay: number; fn: () => void; cleared: boolean }> = []
  return {
    pending,
    set(delay, fn) {
      const entry = { delay, fn, cleared: false }
      pending.push(entry)
      return entry
    },
    clear(handle) {
      const entry = handle as { cleared: boolean }
      entry.cleared = true
    }
  }
}

describe('reminder clock', () => {
  it('T-REM-05 resolves a daylight saving time or asks', () => {
    const summer = resolveZonedLocalTime(
      { year: 2026, month: 6, day: 15, hour: 15, minute: 0 },
      zone
    )
    expect(summer).toMatchObject({ kind: 'exact' })
    if (summer.kind === 'exact') {
      expect(summer.utc.toISOString()).toBe('2026-06-15T22:00:00.000Z')
    }

    expect(
      resolveZonedLocalTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, zone).kind
    ).toBe('ambiguous')
    expect(
      resolveZonedLocalTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, zone).kind
    ).toBe('skipped')

    const overlap = parseReminderRequest(
      'Remind me Sunday at 1:30 AM to check the clocks',
      new Date('2026-10-30T18:00:00.000Z'),
      zone
    )
    expect(overlap).toMatchObject({ status: 'ambiguous' })
    if (overlap && overlap.status === 'ambiguous') {
      expect(overlap.question.toLowerCase()).toContain('twice')
    }

    const skipped = parseReminderRequest(
      'Remind me Sunday at 2:30 AM to check the clocks',
      new Date('2026-03-06T18:00:00.000Z'),
      zone
    )
    expect(skipped).toMatchObject({ status: 'ambiguous' })
    if (skipped && skipped.status === 'ambiguous') {
      expect(skipped.question.toLowerCase()).toContain("doesn't happen")
    }

    const clear = parseReminderRequest(
      'Remind me tomorrow at 3 PM to water the plants',
      new Date('2026-06-14T18:00:00.000Z'),
      zone
    )
    expect(clear).toMatchObject({
      status: 'resolved',
      title: 'water the plants',
      triggerAtUtc: '2026-06-15T22:00:00.000Z',
      certain: true
    })

    expect(
      parseReminderRequest(
        'Remind me to take my umbrella at 7 tomorrow morning',
        new Date('2026-11-04T20:00:00.000Z'),
        zone
      )
    ).toMatchObject({
      status: 'resolved',
      title: 'take my umbrella',
      triggerAtUtc: '2026-11-05T15:00:00.000Z',
      certain: true
    })

    const now = new Date('2026-06-14T18:00:00.000Z')
    expect(parseReminderRequest('Remind me to buy 2 apples at 5pm', now, zone)).toMatchObject({
      status: 'resolved',
      title: 'buy 2 apples',
      triggerAtUtc: '2026-06-15T00:00:00.000Z',
      certain: true
    })
    expect(
      parseReminderRequest('Remind me to call room 12 at 3pm tomorrow', now, zone)
    ).toMatchObject({
      status: 'resolved',
      title: 'call room 12',
      triggerAtUtc: '2026-06-15T22:00:00.000Z',
      certain: true
    })
    expect(
      parseReminderRequest('Remind me at five to buy 2 apples tomorrow', now, zone)
    ).toMatchObject({
      status: 'resolved',
      title: 'buy 2 apples',
      triggerAtUtc: '2026-06-16T00:00:00.000Z',
      certain: false
    })
    expect(
      parseReminderRequest('Remind me tomorrow at noon to take a walk', now, zone)
    ).toMatchObject({
      status: 'resolved',
      title: 'take a walk',
      triggerAtUtc: '2026-06-15T19:00:00.000Z',
      certain: true
    })
  })
})

describe('T-REM scheduler', () => {
  it('T-REM-01 fires a two-minute reminder without sleeping', () => {
    const db = database()
    const now = new Date('2026-06-15T15:00:00.000Z')
    const timer = fakeTimer()
    const notices: string[] = []
    const scheduler = createReminderScheduler({
      db,
      now: () => now,
      timer,
      notify: (notice) => notices.push(notice.kind)
    })
    const created = scheduler.create({
      title: 'Stretch',
      triggerAtUtc: new Date(now.getTime() + 120_000).toISOString(),
      timezone: zone,
      source: 'user'
    })
    expect(created.ok).toBe(true)
    expect(timer.pending[0]?.delay).toBe(120_000)
    timer.pending[0]?.fn()
    expect(notices).toEqual(['due'])
    expect(listReminders(db)[0]?.status).toBe('fired')
  })

  it('T-REM-02 still fires after a restart before it is due', () => {
    const db = database()
    const now = new Date('2026-06-15T15:00:00.000Z')
    const first = fakeTimer()
    createReminderScheduler({
      db,
      now: () => now,
      timer: first,
      notify: () => undefined
    }).create({
      title: 'Stretch',
      triggerAtUtc: new Date(now.getTime() + 120_000).toISOString(),
      timezone: zone,
      source: 'user'
    })
    const second = fakeTimer()
    const notices: string[] = []
    const restarted = createReminderScheduler({
      db,
      now: () => now,
      timer: second,
      notify: (notice) => notices.push(notice.kind)
    })
    restarted.start()
    expect(second.pending[0]?.delay).toBe(120_000)
    second.pending[0]?.fn()
    expect(notices).toEqual(['due'])
    expect(listReminders(db)[0]?.status).toBe('fired')
  })

  it('T-REM-03 does not fire after cancel', () => {
    const db = database()
    const now = new Date('2026-06-15T15:00:00.000Z')
    const timer = fakeTimer()
    const notices: string[] = []
    const scheduler = createReminderScheduler({
      db,
      now: () => now,
      timer,
      notify: (notice) => notices.push(notice.summary)
    })
    const created = scheduler.create({
      title: 'Stretch',
      triggerAtUtc: new Date(now.getTime() + 120_000).toISOString(),
      timezone: zone,
      source: 'user'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    scheduler.cancel(created.reminder.id)
    timer.pending[0]?.fn()
    expect(notices).toEqual([])
    expect(listReminders(db)[0]?.status).toBe('cancelled')
  })

  it('T-REM-04 reports a reminder missed while the app was closed', () => {
    const db = database()
    const now = new Date('2026-06-15T15:00:00.000Z')
    const timer = fakeTimer()
    const notices: Array<{ kind: string; summary: string }> = []
    const scheduler = createReminderScheduler({
      db,
      now: () => new Date('2026-06-15T14:00:00.000Z'),
      timer,
      notify: () => undefined
    })
    const created = scheduler.create({
      title: 'Stretch',
      triggerAtUtc: '2026-06-15T14:30:00.000Z',
      timezone: zone,
      source: 'user'
    })
    expect(created.ok).toBe(true)
    const restarted = createReminderScheduler({
      db,
      now: () => now,
      timer: fakeTimer(),
      notify: (notice) => notices.push({ kind: notice.kind, summary: notice.summary })
    })
    restarted.start()
    expect(notices).toEqual([{ kind: 'missed', summary: "Here's a reminder you missed: Stretch." }])
    expect(listReminders(db)[0]?.status).toBe('missed')
    expect(notices.some((notice) => notice.kind === 'due')).toBe(false)
  })

  it('snoozes the same reminder instead of copying it', () => {
    const db = database()
    const now = new Date('2026-06-15T15:00:00.000Z')
    const timer = fakeTimer()
    const scheduler = createReminderScheduler({
      db,
      now: () => now,
      timer,
      notify: () => undefined
    })
    const created = scheduler.create({
      title: 'Stretch',
      triggerAtUtc: new Date(now.getTime() + 120_000).toISOString(),
      timezone: zone,
      source: 'user'
    })
    if (!created.ok) {
      throw new Error('create failed')
    }
    timer.pending[0]?.fn()
    const snoozed = scheduler.snooze(created.reminder.id, 10)
    expect(listReminders(db)).toHaveLength(1)
    expect(snoozed?.status).toBe('scheduled')
    expect(snoozed?.triggerAtUtc).toBe(new Date(now.getTime() + 10 * 60 * 1000).toISOString())
  })

  it('keeps reminders when appearance is reset', () => {
    const db = database()
    const now = new Date('2026-06-15T15:00:00.000Z')
    createReminderScheduler({
      db,
      now: () => now,
      timer: fakeTimer(),
      notify: () => undefined
    }).create({
      title: 'Stretch',
      triggerAtUtc: new Date(now.getTime() + 120_000).toISOString(),
      timezone: zone,
      source: 'user'
    })
    savePreferences(
      db,
      resetAppearance({
        ...defaultPreferences,
        appearance: { ...defaultPreferences.appearance, textScale: 'extra-large' }
      })
    )
    expect(listReminders(db)).toHaveLength(1)
    expect(reminderNotificationCopy('missed', 'Stretch', false)).toBeNull()
    expect(reminderNotificationCopy('due', 'Stretch', true)).toEqual({
      title: 'Reminder',
      body: 'Stretch'
    })
  })
})

describe('reminders from chat', () => {
  const now = new Date('2026-11-04T20:00:00.000Z')

  function setup(): { db: DatabaseSync; orchestrator: TaskOrchestrator } {
    const db = database()
    const scheduler = createReminderScheduler({
      db,
      now: () => now,
      timer: fakeTimer(),
      notify: () => undefined
    })
    return {
      db,
      orchestrator: new TaskOrchestrator({
        db,
        run: async () => 0,
        now: () => now,
        timeZone: zone,
        reminders: scheduler
      })
    }
  }

  it('sets a certain reminder and lists it', async () => {
    const { db, orchestrator } = setup()
    const created = await orchestrator.submit('Remind me Friday at 3 PM to call the pharmacy')
    expect(created.responseState).toBe('success')
    expect(created.summary).toContain('Friday')
    expect(created.summary.toLowerCase()).toContain('3')
    expect(listReminders(db)[0]).toMatchObject({
      title: 'call the pharmacy',
      triggerAtUtc: '2026-11-06T23:00:00.000Z',
      status: 'scheduled'
    })
    const listed = await orchestrator.submit('Show my reminders')
    expect(listed.summary).toContain('call the pharmacy')
  })

  it('saves an uncertain reminder without asking first', async () => {
    const { db, orchestrator } = setup()
    const saved = await orchestrator.submit('Remind me to call Jim tomorrow at four')
    expect(saved.responseState).toBe('success')
    expect(saved.summary).toContain('4')
    expect(listReminders(db)[0]?.triggerAtUtc).toBe('2026-11-06T00:00:00.000Z')
  })

  it('asks for the missing detail and does not schedule the past', async () => {
    const { db, orchestrator } = setup()
    const vague = await orchestrator.submit('Set a reminder')
    expect(vague.responseState).toBe('needs_input')
    expect(listReminders(db)).toHaveLength(0)
    const past = await orchestrator.submit('Remind me today at 9 AM to stretch')
    expect(past.responseState).toBe('needs_input')
    expect(past.summary).toContain('passed')
    expect(listReminders(db)).toHaveLength(0)
  })

  it('cancels one named reminder and asks when several match', async () => {
    const { db, orchestrator } = setup()
    await orchestrator.submit('Remind me Friday at 3 PM to call the pharmacy')
    await orchestrator.submit('Remind me Saturday at 4 PM to call Jim')
    const ambiguous = await orchestrator.submit('Cancel the reminder to call')
    expect(ambiguous.responseState).toBe('failure')
    expect(ambiguous.summary).toContain('Which reminder')
    expect(listReminders(db).every((reminder) => reminder.status === 'scheduled')).toBe(true)
    const cancelled = await orchestrator.submit('Cancel the reminder to call the pharmacy')
    expect(cancelled.responseState).toBe('success')
    expect(cancelled.summary).toContain('call the pharmacy')
    expect(
      listReminders(db).find((reminder) => reminder.title === 'call the pharmacy')?.status
    ).toBe('cancelled')
    expect(listReminders(db).find((reminder) => reminder.title === 'call jim')?.status).toBe(
      'scheduled'
    )
  })
})
