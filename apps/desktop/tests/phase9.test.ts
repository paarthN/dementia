import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { writeCrashNote } from '../src/main/services/crashNote'
import { createReminderScheduler, type TimerPort } from '../src/main/services/reminderScheduler'
import { openDatabase } from '../src/main/storage/database'
import { HelpPanel } from '../src/renderer/panel/HelpPanel'
import { OnboardingNotice } from '../src/renderer/panel/OnboardingNotice'
import { SettingsPanel } from '../src/renderer/panel/SettingsPanel'
import { sectionNav } from '../src/renderer/panel/sectionNav'
import { releaseBlockers } from '../src/shared/releaseGate'
import { onboardingCan, onboardingCannot, removalSteps } from '../src/shared/onboarding'
import { defaultPreferences, readPreferences, textScalePixels } from '../src/shared/preferences'
import type { SessionSnapshot } from '../src/shared/session'
import { unitToScreen } from '../src/shared/mascotPlacement'

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-phase9-')), 'test.sqlite'))
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

function session(): SessionSnapshot {
  return {
    preferences: defaultPreferences,
    favorites: [],
    reminders: [],
    dueReminders: [],
    messages: [],
    activeTask: null,
    pendingApproval: null,
    shortcutWarning: null,
    notice: null,
    panelView: 'settings',
    screen: { access: 'off', captureActive: false, helper: 'unavailable' },
    inspectionView: null,
    guide: null
  }
}

function contrast(foreground: string, background: string): number {
  const channel = (hex: string, index: number): number => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = (hex: string): number => {
    const color = hex.toLowerCase()
    return 0.2126 * channel(color, 1) + 0.7152 * channel(color, 3) + 0.0722 * channel(color, 5)
  }
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function cssVariable(css: string, block: string, name: string): string {
  const region = css.match(new RegExp(`${block}\\s*\\{([^}]+)\\}`))
  const value = region?.[1]?.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!value?.[1]) {
    throw new Error(`Missing ${name} in ${block}`)
  }
  return value[1]
}

describe('phase 9 accessibility', () => {
  it('T-ACC-01 keeps typing available when the microphone is off', () => {
    expect(defaultPreferences.voice.enabled).toBe(false)
    expect(onboardingCan.some((line) => /microphone is optional/i.test(line))).toBe(true)
    const help = renderToStaticMarkup(createElement(HelpPanel))
    expect(help).toContain('microphone is optional')
  })

  it('T-ACC-02 keeps primary navigation on named buttons', () => {
    expect(sectionNav.map((item) => item.label)).toEqual(['Chat', 'Home', 'Settings', 'Help'])
    const panel = readFileSync(resolve(__dirname, '../src/renderer/panel/PanelApp.tsx'), 'utf8')
    expect(panel).toContain('aria-label="Sections"')
    expect(panel).toContain('aria-current={view === item.view')
    const css = readFileSync(resolve(__dirname, '../src/renderer/panel/panel.css'), 'utf8')
    expect(css).toContain(':focus-visible')
  })

  it('T-ACC-03 names what Companion can and cannot do', () => {
    const help = renderToStaticMarkup(createElement(HelpPanel))
    const notice = renderToStaticMarkup(
      createElement(OnboardingNotice, { onDismiss: () => undefined })
    )
    expect(help).toContain('What Companion can do')
    expect(help).toContain('What Companion will not do')
    expect(notice).toContain('aria-label="What Companion can do"')
    expect(notice).toContain('Got it')
    for (const line of onboardingCannot) {
      expect(help).toContain(line)
    }
    expect(help).toContain('cannot place a phone call')
    expect(help).not.toContain('Mail is connected')
  })

  it('T-ACC-04 keeps large text and a 200% work area on screen', () => {
    expect(textScalePixels['extra-large']).toBe(22)
    expect(defaultPreferences.appearance.contentScale).toBe(1)
    const css = readFileSync(resolve(__dirname, '../src/renderer/panel/panel.css'), 'utf8')
    expect(css).toMatch(/\.nav button \{[^}]*min-height: 44px/)
    expect(css).toMatch(/\.primary,\s*\.quiet,\s*\.tile,\s*\.listen \{[^}]*min-height: 44px/)
    expect(css).toMatch(/\.form input,\s*\.form select,[^}]*min-height: 44px/)
    expect(css).not.toMatch(/min-height: 3[246]px/)
    expect(css).toMatch(/\.workspace-body \{[^}]*overflow: auto/)
    const area = { id: 'scaled', x: 0, y: 25, width: 1512, height: 900 }
    const size = { width: 220, height: 316 }
    const far = unitToScreen(area, 1, 1, size)
    expect(far.x).toBeLessThanOrEqual(area.x + area.width - size.width)
    expect(far.y).toBeLessThanOrEqual(area.y + area.height - size.height)

    const ink = cssVariable(css, ':root', '--ink')
    const canvas = cssVariable(css, ':root', '--canvas')
    const secondary = cssVariable(css, ':root', '--secondary')
    const sheet = cssVariable(css, ':root', '--sheet')
    expect(contrast(ink, canvas)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(secondary, sheet)).toBeGreaterThanOrEqual(4.5)
    const contrastInk = cssVariable(css, ":root\\[data-theme='high-contrast'\\]", '--ink')
    const contrastCanvas = cssVariable(css, ":root\\[data-theme='high-contrast'\\]", '--canvas')
    expect(contrast(contrastInk, contrastCanvas)).toBeGreaterThanOrEqual(7)
  })
})

describe('phase 9 recovery and packaging', () => {
  it('keeps an older preferences file and leaves crash notes off', () => {
    const stored = {
      version: 1,
      appearance: { ...defaultPreferences.appearance, textScale: 'large' as const },
      accessibility: defaultPreferences.accessibility,
      voice: defaultPreferences.voice,
      privacy: {
        saveChatHistory: false,
        allowDiagnosticTelemetry: false,
        cloudScreenAnalysisEnabled: false,
        assistantMode: 'demo',
        cloudConsentAtUtc: null,
        assistantOrigin: null
      },
      startup: defaultPreferences.startup,
      mascot: defaultPreferences.mascot
    }
    const read = readPreferences(stored)
    expect(read.onboarding.seenLimits).toBe(false)
    expect(read.privacy.allowDiagnosticTelemetry).toBe(false)
    expect(read.appearance.textScale).toBe('large')
  })

  it('writes a redacted crash note only after consent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'companion-crash-'))
    const secret = 'sk-testkey123'
    const input = {
      name: 'Error',
      message: `failed for user@example.com at /Users/paarth/notes with ${secret} password: hunter2`,
      atUtc: '2026-11-06T00:00:00.000Z'
    }
    expect(writeCrashNote(directory, false, input)).toBeNull()
    expect(() => statSync(join(directory, 'crash-note.txt'))).toThrow()

    const written = writeCrashNote(directory, true, input)
    expect(written).toBe(join(directory, 'crash-note.txt'))
    const note = readFileSync(written ?? '', 'utf8')
    expect(note).toContain('Error')
    expect(note).toContain('[redacted]')
    expect(note).not.toContain(secret)
    expect(note).not.toContain('hunter2')
    expect(note).not.toContain('user@example.com')
    expect(note).not.toContain('paarth')
    expect(statSync(written ?? '').mode & 0o077).toBe(0)
  })

  it('marks a reminder missed after sleep and does not fire the old timer', () => {
    const db = database()
    let now = new Date('2026-11-06T12:00:00.000Z')
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
      triggerAtUtc: '2026-11-06T12:01:00.000Z',
      timezone: 'UTC',
      source: 'user'
    })
    expect(created.ok).toBe(true)
    const armed = timer.pending[0]
    expect(armed?.cleared).toBe(false)
    now = new Date('2026-11-06T12:10:00.000Z')
    const missed = scheduler.start()
    expect(missed.map((notice) => notice.kind)).toEqual(['missed'])
    expect(armed?.cleared).toBe(true)
    armed?.fn()
    expect(notices).toEqual(['missed'])
  })

  it('splits a reminder timer that would overflow setTimeout', () => {
    const db = database()
    let now = new Date('2026-11-06T12:00:00.000Z')
    const timer = fakeTimer()
    const notices: string[] = []
    const scheduler = createReminderScheduler({
      db,
      now: () => now,
      timer,
      notify: (notice) => notices.push(notice.kind)
    })
    const created = scheduler.create({
      title: 'Later',
      triggerAtUtc: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      timezone: 'UTC',
      source: 'user'
    })
    expect(created.ok).toBe(true)
    const span = 30 * 24 * 60 * 60 * 1000
    const step = 2_147_483_647
    expect(timer.pending[0]?.delay).toBe(step)
    now = new Date(now.getTime() + step + 1_000)
    timer.pending[0]?.fn()
    expect(notices).toEqual([])
    expect(timer.pending[1]?.delay).toBe(span - step - 1_000)
  })

  it('states removal steps and blocks a public release without signing', () => {
    expect(removalSteps.join(' ')).toContain('Launch at login')
    expect(removalSteps.join(' ')).toContain('Application Support/Companion')
    const help = renderToStaticMarkup(createElement(HelpPanel))
    expect(help).toContain('Removing Companion')
    expect(
      releaseBlockers({ developerId: false, notarized: false, gatekeeperAccepted: false })
    ).toEqual([
      'No Developer ID certificate.',
      'Notarization has not been run.',
      'Gatekeeper has not accepted this build.'
    ])
    expect(
      releaseBlockers({ developerId: true, notarized: true, gatekeeperAccepted: true })
    ).toEqual([])
    const builder = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8')
    expect(builder).toContain('notarize: false')
    expect(builder).toContain('identity: null')
    const settings = renderToStaticMarkup(
      createElement(SettingsPanel, { session: session(), onNotice: () => undefined })
    )
    expect(settings).toContain('Save a redacted crash note on this Mac')
    expect(settings).toContain('not sent anywhere')
    expect(settings).toMatch(/<input type="checkbox"\/>\s*Save a redacted crash note on this Mac/)
  })
})
