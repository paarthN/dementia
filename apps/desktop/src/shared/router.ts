import type { RoutedRequest } from './agent'
import { routedRequestSchema } from './agent'
import { cleanControlName } from './controls'
import { parseWebsite, websiteFromPhrase } from './favorites'
import { matchKnownApp, matchKnownBundle, matchVettedSite, isVettedHostname } from './knownTargets'
import { parseReminderRequest } from './reminderTime'
import { browserSearchUrl } from './search'
import type { SystemSettingsSection } from './systemSettings'

export interface RouterFavorite {
  kind: 'application' | 'website'
  title: string
  target: string
}

export interface PointedControl {
  name: string
  role?: string
  appName?: string
}

export interface RouterContext {
  favorites?: RouterFavorite[]
  now?: Date
  timeZone?: string
  pointed?: PointedControl
}

export function routeUtterance(raw: string, context: RouterContext = {}): RoutedRequest {
  const text = raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^please\s+/i, '')
  const lower = text.toLowerCase()

  if (isUnsupported(lower)) {
    return finish({
      intent: 'unsupported',
      mode: 'answer',
      parameters: {},
      missingRequiredFields: [],
      requiresScreenContext: false,
      userFacingClarification:
        "I can't do that for you. I won't transfer money, enter a password, or run a command."
    })
  }

  if (isExplain(lower)) {
    return finish({
      intent: 'explain_screen',
      mode: 'explain',
      parameters: { question: text },
      missingRequiredFields: [],
      requiresScreenContext: true
    })
  }

  const pressed = pressRequest(text, context)
  if (pressed) {
    return pressed
  }

  const pointed = pointRequest(text)
  if (pointed) {
    return pointed
  }

  const reminder = routeReminder(text, lower, context)
  if (reminder) {
    return reminder
  }

  if (isGuide(lower)) {
    const guideId = guideIdFor(lower)
    if (!guideId) {
      return finish({
        intent: 'guide_task',
        mode: 'guide',
        parameters: {},
        missingRequiredFields: ['guide'],
        requiresScreenContext: true,
        userFacingClarification:
          'I can show you how to save in TextEdit, or how to open Mac text-size settings.'
      })
    }
    return finish({
      intent: 'guide_task',
      mode: 'guide',
      parameters: { guideId },
      missingRequiredFields: [],
      requiresScreenContext: true
    })
  }

  const search = searchQuery(text)
  if (search !== null) {
    if (!search) {
      return finish({
        intent: 'search_web',
        mode: 'execute',
        parameters: {},
        missingRequiredFields: ['query'],
        requiresScreenContext: false,
        userFacingClarification: 'What should I search for?'
      })
    }
    return finish({
      intent: 'search_web',
      mode: 'execute',
      parameters: { query: search, url: browserSearchUrl(search) },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  const opened = openTarget(text, context)
  if (opened) {
    return opened
  }

  const companion = companionChange(lower)
  if (companion) {
    return finish({
      intent: 'change_companion_visuals',
      mode: 'execute',
      parameters: companion,
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  const section = systemSection(lower)
  if (section) {
    return finish({
      intent: 'open_system_settings',
      mode: 'execute',
      parameters: { section },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  if (isAmbiguousVisual(lower)) {
    return finish({
      intent: 'change_companion_visuals',
      mode: 'answer',
      parameters: {},
      missingRequiredFields: ['scope'],
      requiresScreenContext: false,
      userFacingClarification: visualQuestion(lower)
    })
  }

  return finish({
    intent: 'general_question',
    mode: 'answer',
    parameters: {},
    missingRequiredFields: [],
    requiresScreenContext: false,
    userFacingClarification:
      'I can open an app, search the web, set a reminder, or make the text in this assistant bigger.'
  })
}

function routeReminder(text: string, lower: string, context: RouterContext): RoutedRequest | null {
  if (/^(?:show|list) my reminders\b/.test(lower) || /^what reminders do i have\b/.test(lower)) {
    return finish({
      intent: 'list_reminders',
      mode: 'execute',
      parameters: { range: lower.includes('this week') ? 'week' : 'all' },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }
  if (/^cancel (?:the )?reminder\b/.test(lower)) {
    const query = lower.replace(/^cancel (?:the )?reminder(?: to)?\s*/, '').trim()
    if (!query) {
      return finish({
        intent: 'cancel_reminder',
        mode: 'execute',
        parameters: {},
        missingRequiredFields: ['reminder'],
        requiresScreenContext: false,
        userFacingClarification: 'Which reminder should I cancel?'
      })
    }
    return finish({
      intent: 'cancel_reminder',
      mode: 'execute',
      parameters: { query },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }
  const parsed = parseReminderRequest(text, context.now ?? new Date(), context.timeZone ?? 'UTC')
  if (!parsed) {
    return null
  }
  if (parsed.status !== 'resolved') {
    return finish({
      intent: 'set_reminder',
      mode: 'answer',
      parameters: {},
      missingRequiredFields: ['when'],
      requiresScreenContext: false,
      userFacingClarification: parsed.question
    })
  }
  return finish({
    intent: 'set_reminder',
    mode: 'execute',
    parameters: {
      title: parsed.title,
      triggerAtUtc: parsed.triggerAtUtc,
      timezone: parsed.timezone,
      certain: parsed.certain,
      localLabel: parsed.localLabel
    },
    missingRequiredFields: [],
    requiresScreenContext: false
  })
}

function finish(request: RoutedRequest): RoutedRequest {
  return routedRequestSchema.parse(request)
}

function isUnsupported(lower: string): boolean {
  return (
    /^(run|execute|sudo)\b/.test(lower) ||
    /transfer money|send money|wire money|buy this|purchase this/.test(lower) ||
    /enter (my )?password|bypass (the )?(security|password|prompt)/.test(lower)
  )
}

function isExplain(lower: string): boolean {
  return (
    /explain (this|my) screen/.test(lower) ||
    /what(?:'s| is) this (?:dialog|pop-up|popup|window|error|message)/.test(lower) ||
    /what does this (?:mean|error|pop-up|popup)/.test(lower)
  )
}

function pressRequest(text: string, context: RouterContext): RoutedRequest | null {
  const lower = text.toLowerCase().replace(/[.?!]+$/g, '')
  const typed = /^type\s+(.+?)\s+into\s+(?:the\s+)?(.+)$/i.exec(text.replace(/[.?!]+$/g, ''))
  if (typed) {
    const value = (typed[1] ?? '').trim().replace(/^["']|["']$/g, '')
    const name = cleanControlName(typed[2] ?? '')
    if (!value || !name) {
      return finish({
        intent: 'press_control',
        mode: 'execute',
        parameters: {},
        missingRequiredFields: ['control'],
        requiresScreenContext: true,
        userFacingClarification: 'What should I type, and where?'
      })
    }
    return pressParams({ name, text: value })
  }
  if (/^(?:do it for me|do this for me|click it|press it|tap it)$/.test(lower)) {
    if (!context.pointed?.name) {
      return finish({
        intent: 'press_control',
        mode: 'execute',
        parameters: {},
        missingRequiredFields: ['control'],
        requiresScreenContext: true,
        userFacingClarification: 'What should I press?'
      })
    }
    return pressParams(context.pointed)
  }
  const click = /^(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?(.+)$/i.exec(
    text.replace(/[.?!]+$/g, '')
  )
  if (!click?.[1]) {
    return null
  }
  const name = cleanControlName(click[1])
  if (!name || /^(?:it|this|that)$/i.test(name)) {
    if (context.pointed?.name) {
      return pressParams(context.pointed)
    }
    return finish({
      intent: 'press_control',
      mode: 'execute',
      parameters: {},
      missingRequiredFields: ['control'],
      requiresScreenContext: true,
      userFacingClarification: 'What should I press?'
    })
  }
  return pressParams({ name })
}

function pressParams(input: {
  name: string
  role?: string
  appName?: string
  text?: string
}): RoutedRequest {
  return finish({
    intent: 'press_control',
    mode: 'execute',
    parameters: {
      name: input.name,
      ...(input.role ? { role: input.role } : {}),
      ...(input.appName ? { appName: input.appName } : {}),
      ...(input.text ? { text: input.text } : {})
    },
    missingRequiredFields: [],
    requiresScreenContext: true
  })
}

function pointRequest(text: string): RoutedRequest | null {
  const lower = text.toLowerCase()
  if (/show me how to save|how do i save|save this|save in textedit/.test(lower)) {
    return null
  }
  if (
    /(accessibility|text size|text-size|display settings)/.test(lower) &&
    /show me|where|guide|highlight/.test(lower)
  ) {
    return null
  }
  const made = /show me how to make (?:this|it|the text)\s+(.+)$/i.exec(text)
  const where = /^where is\s+(.+)$/i.exec(text)
  const show = /^(?:show me|highlight|point(?:\s+at|\s+to)?)\s+(.+)$/i.exec(text)
  const raw = made?.[1] ?? where?.[1] ?? (show && !/^how\b/i.test(show[1] ?? '') ? show[1] : null)
  if (!raw) {
    return null
  }
  const name = cleanControlName(raw)
  if (!name || /^(?:how|where)$/i.test(name)) {
    return null
  }
  return finish({
    intent: 'guide_task',
    mode: 'guide',
    parameters: { name },
    missingRequiredFields: [],
    requiresScreenContext: true
  })
}

function isGuide(lower: string): boolean {
  return /show me (?:how|where)|where (?:do|should) i click|guide me|highlight/.test(lower)
}

function guideIdFor(lower: string): 'textedit.save' | 'accessibility.display' | null {
  if (/save/.test(lower)) {
    return 'textedit.save'
  }
  if (/accessibility|text size|text-size|display settings/.test(lower)) {
    return 'accessibility.display'
  }
  return null
}

function companionChange(lower: string): { key: 'textScale' | 'theme'; value: string } | null {
  const aboutAssistant = /your|assistant|companion|this app/.test(lower)
  const aboutText = /text|letters|letter|writing|type|easier to read/.test(lower)
  const enlarge = /bigger|larger|easier/.test(lower)
  if (aboutAssistant && aboutText && enlarge) {
    return { key: 'textScale', value: 'larger' }
  }
  if (aboutAssistant && /theme|dark/.test(lower) && /dark|darker/.test(lower)) {
    return { key: 'theme', value: 'dark' }
  }
  return null
}

function systemSection(lower: string): SystemSettingsSection | null {
  const asks = /make|turn on|open|improve|change|bigger|larger|brighter/.test(lower)
  if (!asks) {
    return null
  }
  if (/pointer|cursor/.test(lower) && /bigger|larger|size/.test(lower)) {
    return 'pointer'
  }
  if (/contrast/.test(lower)) {
    return 'contrast'
  }
  if (/brighter|brightness/.test(lower)) {
    return 'brightness'
  }
  if (/zoom/.test(lower)) {
    return 'zoom'
  }
  if (/mac|computer/.test(lower) && /text/.test(lower)) {
    return 'text'
  }
  if (/everything/.test(lower) && /bigger|larger/.test(lower)) {
    return 'display'
  }
  if (/(mac|computer|screen)/.test(lower) && /bigger|larger/.test(lower)) {
    return 'display'
  }
  return null
}

function isAmbiguousVisual(lower: string): boolean {
  return /bigger|larger|darker theme|dark theme|dark mode/.test(lower)
}

function visualQuestion(lower: string): string {
  if (/dark/.test(lower)) {
    return 'Do you mean a darker theme in this assistant, or on the Mac?'
  }
  return 'Do you mean the text in this assistant, or everything on the Mac?'
}

function searchQuery(text: string): string | null {
  const match = /^(?:search(?:\s+for)?|look up|google|find)\s*(.*)$/i.exec(text)
  if (!match) {
    return null
  }
  return (match[1] ?? '').trim()
}

function openTarget(text: string, context: RouterContext): RoutedRequest | null {
  const match = /^(?:open|launch|start|go to)\s+(.+)$/i.exec(text)
  if (!match?.[1]) {
    return null
  }
  const phrase = match[1]
    .trim()
    .replace(/[.?!]+$/, '')
    .trim()
  const lower = phrase.toLowerCase()
  if (lower === 'my bank' || lower === 'the bank' || lower === 'my email account') {
    return finish({
      intent: 'open_website',
      mode: 'execute',
      parameters: {},
      missingRequiredFields: ['target'],
      requiresScreenContext: false,
      userFacingClarification: 'Which website should I open? I will not guess a login page.'
    })
  }

  const site = matchVettedSite(phrase)
  if (site) {
    return finish({
      intent: 'open_website',
      mode: 'execute',
      parameters: { url: site.url, displayName: site.displayName, trusted: true },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  const direct = parseWebsite(phrase)
  if (!('error' in direct)) {
    return finish({
      intent: 'open_website',
      mode: 'execute',
      parameters: {
        url: direct.url,
        displayName: direct.domain,
        trusted: isVettedHostname(direct.domain)
      },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(phrase)) {
    return finish({
      intent: 'open_website',
      mode: 'execute',
      parameters: { displayName: phrase },
      missingRequiredFields: [],
      requiresScreenContext: false,
      userFacingClarification: "That website address doesn't look safe or valid."
    })
  }

  const bundle = matchKnownBundle(phrase)
  if (bundle) {
    return finish({
      intent: 'open_app',
      mode: 'execute',
      parameters: { displayName: bundle.displayName, bundleId: bundle.bundleId },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  const bare = websiteFromPhrase(phrase)
  if (bare) {
    return finish({
      intent: 'open_website',
      mode: 'execute',
      parameters: {
        url: bare.url,
        displayName: bare.domain,
        trusted: isVettedHostname(bare.domain)
      },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  const app = matchKnownApp(phrase)
  if (app) {
    return finish({
      intent: 'open_app',
      mode: 'execute',
      parameters: { displayName: app.displayName, bundleId: app.bundleId },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  const favorite = (context.favorites ?? []).find((item) => item.title.toLowerCase() === lower)
  if (favorite?.kind === 'website') {
    const parsed = parseWebsite(favorite.target)
    if (!('error' in parsed)) {
      return finish({
        intent: 'open_website',
        mode: 'execute',
        parameters: { url: parsed.url, displayName: favorite.title, trusted: true },
        missingRequiredFields: [],
        requiresScreenContext: false
      })
    }
  }
  if (favorite?.kind === 'application') {
    return finish({
      intent: 'open_app',
      mode: 'execute',
      parameters: { displayName: favorite.title, bundleId: favorite.target },
      missingRequiredFields: [],
      requiresScreenContext: false
    })
  }

  return finish({
    intent: 'open_app',
    mode: 'execute',
    parameters: { displayName: phrase },
    missingRequiredFields: [],
    requiresScreenContext: false
  })
}
