import type { DatabaseSync } from 'node:sqlite'
import type { RiskLevel, ToolResult } from '../../shared/agent'
import { isBundleId, parseWebsite } from '../../shared/favorites'
import { appLaunchName, isKnownBundle, isVettedHostname } from '../../shared/knownTargets'
import { nextTextScale, type UserPreferences } from '../../shared/preferences'
import { browserSearchUrl } from '../../shared/search'
import { systemSettingsSections, type SystemSettingsSection } from '../../shared/systemSettings'
import { loadPreferences, savePreferences } from '../storage/database'
import {
  launchAppByName,
  launchBundle,
  launchSystemSettings,
  launchWebsite,
  type CommandRunner
} from './launcher'
import type { ReminderPort } from './reminderScheduler'
import type { BrowserAutomationPort } from '../agent/ports/BrowserAutomationPort'
import type { DesktopAutomationPort } from '../agent/ports/DesktopAutomationPort'
import { browserToolDefinitions } from '../agent/tools/browserTools'
import { desktopToolDefinitions } from '../agent/tools/desktopTools'

export const blockedToolNames = [
  'executeShell',
  'runShell',
  'clickCoordinates',
  'readAnyFile',
  'sendAnyHttpRequest',
  'shell',
  'exec',
  'page.evaluate',
  'browser.evaluate'
] as const

const settingsCopy: Record<SystemSettingsSection, string> = {
  text: 'I opened Mac text-size settings so you can change the size across the Mac. I did not change the setting.',
  display: 'I opened Displays in System Settings. I did not change the size on your Mac.',
  zoom: 'I opened Zoom settings. I did not turn Zoom on.',
  pointer: 'I opened pointer settings. I did not change the pointer size.',
  contrast: 'I opened contrast settings. I did not change them.',
  brightness: 'I opened Displays so you can adjust brightness. I did not change it.'
}

export interface ToolContext {
  db: DatabaseSync
  run: CommandRunner
  now: () => Date
  timeZone: string
  screenPermission: boolean
  allowedBundleIds: () => string[]
  signal: AbortSignal
  reminders?: ReminderPort
  screen?: {
    inspect: () => Promise<ToolResult>
    captureOnce: (explicitConsent: boolean) => Promise<ToolResult>
    startGuide: (guideId: string) => Promise<ToolResult>
    point?: (name: string, role?: string) => Promise<ToolResult>
    describeControl?: (input: { name: string; role?: string }) => Promise<{
      matchCount: number
      summary: string
      name?: string
      role?: string
      appName?: string
      blocked?: boolean
    }>
    press?: (input: {
      name: string
      role?: string
      text?: string
      signal?: AbortSignal
    }) => Promise<ToolResult>
  }
  desktop?: DesktopAutomationPort
  browser?: BrowserAutomationPort
}

export interface ToolDefinition {
  name: string
  risk: RiskLevel
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolRegistry {
  isBlocked: (name: string) => boolean
  riskOf: (name: string) => RiskLevel | null
  has: (name: string) => boolean
  execute: (
    name: string,
    input: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolResult>
}

export function createToolRegistry(extra: ToolDefinition[] = []): ToolRegistry {
  const tools = new Map<string, ToolDefinition>()
  for (const tool of [...builtinTools(), ...extra]) {
    if (isBlockedName(tool.name) || tools.has(tool.name)) {
      continue
    }
    tools.set(tool.name, tool)
  }

  return {
    isBlocked: isBlockedName,
    riskOf(name) {
      return tools.get(name)?.risk ?? null
    },
    has(name) {
      return tools.has(name)
    },
    async execute(name, input, context) {
      const tool = tools.get(name)
      if (!tool || isBlockedName(name)) {
        return {
          status: 'failed',
          summary: "I can't do that.",
          errorCode: 'unknown_tool',
          verification: { method: 'none', passed: false }
        }
      }
      return tool.execute(input, context)
    }
  }
}

function isBlockedName(name: string): boolean {
  return (blockedToolNames as readonly string[]).includes(name)
}

function builtinTools(): ToolDefinition[] {
  return [...coreTools(), ...desktopToolDefinitions(), ...browserToolDefinitions()]
}

function coreTools(): ToolDefinition[] {
  return [
    {
      name: 'apps.listAvailable',
      risk: 'R0',
      async execute() {
        return {
          status: 'succeeded',
          summary: 'These are the apps I can open by name.',
          verification: { method: 'local_state', passed: true }
        }
      }
    },
    {
      name: 'apps.open',
      risk: 'R1',
      execute: openApp
    },
    {
      name: 'browser.search',
      risk: 'R1',
      execute: searchWeb
    },
    {
      name: 'browser.openUrl',
      risk: 'R1',
      execute: openUrl
    },
    {
      name: 'settings.changeCompanion',
      risk: 'R1',
      execute: changeCompanion
    },
    {
      name: 'settings.openSystemPage',
      risk: 'R1',
      execute: openSystemPage
    },
    {
      name: 'reminders.create',
      risk: 'R1',
      execute: createReminder
    },
    {
      name: 'reminders.list',
      risk: 'R0',
      execute: listReminderTool
    },
    {
      name: 'reminders.cancel',
      risk: 'R1',
      execute: cancelReminder
    },
    {
      name: 'screen.inspect',
      risk: 'R0',
      async execute(_input, context) {
        if (!context.screen) {
          return {
            status: 'unsupported',
            summary: "Screen explanation isn't available yet.",
            errorCode: 'unavailable',
            verification: { method: 'none', passed: false }
          }
        }
        return context.screen.inspect()
      }
    },
    {
      name: 'screen.captureOnce',
      risk: 'R2',
      async execute(input, context) {
        if (!context.screen) {
          return {
            status: 'unsupported',
            summary: "Screen capture isn't available yet.",
            errorCode: 'unavailable',
            verification: { method: 'none', passed: false }
          }
        }
        return context.screen.captureOnce(input.consent === true)
      }
    },
    {
      name: 'guidance.start',
      risk: 'R0',
      async execute(input, context) {
        if (!context.screen) {
          return {
            status: 'unsupported',
            summary: "I can't highlight the screen yet.",
            errorCode: 'unavailable',
            verification: { method: 'none', passed: false }
          }
        }
        const guideId = typeof input.guideId === 'string' ? input.guideId : ''
        return context.screen.startGuide(guideId)
      }
    },
    {
      name: 'guidance.point',
      risk: 'R0',
      async execute(input, context) {
        if (!context.screen?.point) {
          return {
            status: 'unsupported',
            summary: "I can't highlight the screen yet.",
            errorCode: 'unavailable',
            verification: { method: 'none', passed: false }
          }
        }
        const name = typeof input.name === 'string' ? input.name : ''
        const role = typeof input.role === 'string' ? input.role : undefined
        return context.screen.point(name, role)
      }
    },
    {
      name: 'ui.press',
      risk: 'R2',
      async execute(input, context) {
        if (!context.screen?.press) {
          return {
            status: 'unsupported',
            summary: "I can't press controls yet.",
            errorCode: 'unavailable',
            verification: { method: 'none', passed: false }
          }
        }
        const name = typeof input.name === 'string' ? input.name : ''
        const role = typeof input.role === 'string' ? input.role : undefined
        const text = typeof input.text === 'string' ? input.text : undefined
        return context.screen.press({
          name,
          signal: context.signal,
          ...(role ? { role } : {}),
          ...(text ? { text } : {})
        })
      }
    },
    {
      name: 'tasks.cancel',
      risk: 'R0',
      async execute() {
        return {
          status: 'cancelled',
          summary: 'I stopped. Nothing else will run for that request.',
          verification: { method: 'local_state', passed: true }
        }
      }
    },
    {
      name: 'mail.send',
      risk: 'R3',
      async execute() {
        return {
          status: 'unsupported',
          summary: "Sending email isn't available in this version.",
          errorCode: 'unavailable',
          verification: { method: 'none', passed: false }
        }
      }
    },
    {
      name: 'payments.transfer',
      risk: 'R4',
      async execute() {
        return {
          status: 'unsupported',
          summary: "I can't transfer money.",
          errorCode: 'disallowed',
          verification: { method: 'none', passed: false }
        }
      }
    }
  ]
}

function missedApp(displayName: string): ToolResult {
  return {
    status: 'failed',
    summary: `I couldn't find ${displayName} on this computer.`,
    errorCode: 'app_not_found',
    recovery: [{ label: 'Show me how', actionKey: 'guide_app' }],
    verification: { method: 'os', passed: false }
  }
}

async function openApp(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const provided = typeof input.displayName === 'string' ? input.displayName : ''
  const displayName = provided.trim() || 'That app'
  const bundleId = typeof input.bundleId === 'string' ? input.bundleId : ''
  const allowed = new Set(context.allowedBundleIds())
  if (bundleId && isBundleId(bundleId) && (isKnownBundle(bundleId) || allowed.has(bundleId))) {
    const opened = await launchBundle(bundleId, context.run)
    if (opened.status !== 'succeeded') {
      return missedApp(displayName)
    }
    return {
      status: 'succeeded',
      summary: `${displayName} is open.`,
      verification: { method: 'os', passed: true, details: bundleId }
    }
  }

  const appName = appLaunchName(provided)
  if (!appName) {
    return missedApp(displayName)
  }
  const opened = await launchAppByName(appName, context.run)
  if (opened.status !== 'succeeded') {
    return missedApp(appName)
  }
  return {
    status: 'succeeded',
    summary: `${appName} is open.`,
    verification: { method: 'os', passed: true, details: appName }
  }
}

async function searchWeb(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) {
    return {
      status: 'failed',
      summary: 'What should I search for?',
      errorCode: 'missing_query',
      verification: { method: 'none', passed: false }
    }
  }
  const url = browserSearchUrl(query)
  const opened = await launchWebsite(url, context.run)
  if (opened.status !== 'succeeded') {
    return {
      status: 'failed',
      summary: "I couldn't open the browser. You can open Safari and type the search yourself.",
      errorCode: 'browser_failed',
      recovery: [{ label: 'Show me how', actionKey: 'guide_browser' }],
      verification: { method: 'os', passed: false }
    }
  }
  return {
    status: 'succeeded',
    summary: `I opened your browser and searched for ${query}.`,
    data: { url },
    verification: { method: 'os', passed: true, details: url }
  }
}

async function openUrl(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const raw = typeof input.url === 'string' ? input.url : ''
  const parsed = parseWebsite(raw)
  if ('error' in parsed) {
    return {
      status: 'failed',
      summary: "That website address doesn't look safe or valid.",
      errorCode: 'invalid_url',
      verification: { method: 'none', passed: false }
    }
  }
  if (!isVettedHostname(parsed.domain) && input.trusted !== true && input.confirmed !== true) {
    return {
      status: 'failed',
      summary: 'That website needs a confirmation before I open it.',
      errorCode: 'needs_confirmation',
      verification: { method: 'none', passed: false }
    }
  }
  const opened = await launchWebsite(parsed.url, context.run)
  if (opened.status !== 'succeeded') {
    return {
      status: 'failed',
      summary: "I couldn't open the browser.",
      errorCode: 'browser_failed',
      recovery: [{ label: 'Show me how', actionKey: 'guide_browser' }],
      verification: { method: 'os', passed: false }
    }
  }
  const name = typeof input.displayName === 'string' ? input.displayName : parsed.domain
  return {
    status: 'succeeded',
    summary: `I opened ${name} in your browser.`,
    verification: { method: 'os', passed: true, details: parsed.url }
  }
}

async function changeCompanion(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const current = loadPreferences(context.db)
  if (input.key === 'textScale' && input.value === 'larger') {
    const next = nextTextScale(current.appearance.textScale)
    if (next === current.appearance.textScale) {
      return {
        status: 'succeeded',
        summary: 'The text in this assistant is already as large as it goes.',
        verification: { method: 'local_state', passed: true, details: next }
      }
    }
    savePreferences(context.db, {
      ...current,
      appearance: { ...current.appearance, textScale: next }
    })
    return readBackText(context.db, next)
  }
  if (input.key === 'theme' && input.value === 'dark') {
    savePreferences(context.db, {
      ...current,
      appearance: { ...current.appearance, theme: 'dark' }
    })
    const theme = loadPreferences(context.db).appearance.theme
    const passed = theme === 'dark'
    return {
      status: passed ? 'succeeded' : 'failed',
      summary: passed
        ? 'I made this assistant use a darker theme. Your Mac is unchanged.'
        : "I tried, but couldn't confirm the theme changed.",
      verification: { method: 'local_state', passed, details: theme }
    }
  }
  return {
    status: 'failed',
    summary: 'I can change the text size or theme in this assistant.',
    errorCode: 'invalid_setting',
    verification: { method: 'local_state', passed: false }
  }
}

function readBackText(
  db: DatabaseSync,
  expected: UserPreferences['appearance']['textScale']
): ToolResult {
  const actual = loadPreferences(db).appearance.textScale
  const passed = actual === expected
  return {
    status: passed ? 'succeeded' : 'failed',
    summary: passed
      ? 'I made the text in this assistant larger.'
      : "I tried, but couldn't confirm the text size changed.",
    verification: { method: 'local_state', passed, details: actual }
  }
}

async function openSystemPage(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const section = input.section
  if (!isSettingsSection(section)) {
    return {
      status: 'failed',
      summary: "I don't know which System Settings page you mean.",
      errorCode: 'invalid_section',
      verification: { method: 'os', passed: false }
    }
  }
  const opened = await launchSystemSettings(section, context.run)
  if (opened.status !== 'succeeded') {
    return {
      status: 'failed',
      summary: "I couldn't open System Settings.",
      errorCode: 'settings_failed',
      recovery: [{ label: 'Show me how', actionKey: 'guide_settings' }],
      verification: { method: 'os', passed: false }
    }
  }
  return {
    status: 'succeeded',
    summary: settingsCopy[section],
    verification: { method: 'os', passed: true, details: section }
  }
}

async function createReminder(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  if (!context.reminders) {
    return {
      status: 'unsupported',
      summary: "Reminders aren't available yet.",
      errorCode: 'unavailable',
      verification: { method: 'none', passed: false }
    }
  }
  const created = context.reminders.create({
    title: typeof input.title === 'string' ? input.title : '',
    triggerAtUtc: typeof input.triggerAtUtc === 'string' ? input.triggerAtUtc : '',
    timezone: typeof input.timezone === 'string' ? input.timezone : context.timeZone,
    source: 'assistant'
  })
  if (!created.ok) {
    return {
      status: 'failed',
      summary: created.summary,
      verification: { method: 'local_state', passed: false }
    }
  }
  return {
    status: 'succeeded',
    summary: created.summary,
    verification: { method: 'local_state', passed: true, details: created.reminder.id }
  }
}

async function listReminderTool(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  if (!context.reminders) {
    return {
      status: 'unsupported',
      summary: "Reminders aren't available yet.",
      errorCode: 'unavailable',
      verification: { method: 'none', passed: false }
    }
  }
  const items = context.reminders.list(input.range === 'week' ? 'week' : 'all')
  const summary =
    items.length === 0
      ? "You don't have any reminders."
      : `You have ${items.length} reminder${items.length === 1 ? '' : 's'}. ${items
          .map((reminder) => context.reminders?.describe(reminder))
          .join('. ')}.`
  return {
    status: 'succeeded',
    summary,
    verification: { method: 'local_state', passed: true }
  }
}

async function cancelReminder(
  input: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  if (!context.reminders) {
    return {
      status: 'unsupported',
      summary: "Reminders aren't available yet.",
      errorCode: 'unavailable',
      verification: { method: 'none', passed: false }
    }
  }
  const result = context.reminders.cancelQuery(typeof input.query === 'string' ? input.query : '')
  return {
    status: result.ok ? 'succeeded' : 'failed',
    summary: result.summary,
    verification: { method: 'local_state', passed: result.ok }
  }
}

function isSettingsSection(value: unknown): value is SystemSettingsSection {
  return typeof value === 'string' && (systemSettingsSections as readonly string[]).includes(value)
}
