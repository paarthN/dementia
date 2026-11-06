import { randomUUID } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import type { BrowserContext, Locator, Page, Route } from 'playwright'
import { redactSecretText } from '../AgentPrompt'
import { desktopKeyChords } from './DesktopAutomationPort'
import {
  browserRoles,
  browserSnapshotTtlMs,
  browserTextLimit,
  type BrowserAutomationPort,
  type BrowserElementInput,
  type BrowserObservation,
  type BrowserTab,
  type BrowserOutcome,
  type BrowserStatus,
  type BrowserTarget
} from './BrowserAutomationPort'
import { classifyNavigation, isSensitiveBrowserField, type ClassifyOptions } from './browserSafety'

const imageByteLimit = 1_500_000
const navigationTimeoutMs = 15_000
const refusedLaunchKeys = [
  'channel',
  'cdpUrl',
  'cdpEndpoint',
  'userDataDir',
  'profile',
  'executablePath'
]

const keyNames: Record<(typeof desktopKeyChords)[number], string> = {
  tab: 'Tab',
  'shift+tab': 'Shift+Tab',
  escape: 'Escape',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End'
}

const bannerScript = `(() => {
  const mark = document.createElement('div')
  mark.dataset.companionAgent = 'browser'
  mark.textContent = 'Agent Browser'
  mark.setAttribute('role', 'note')
  mark.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483646;background:#12395c;color:#ffffff;font:600 14px sans-serif;padding:6px 10px;pointer-events:none;'
  const mount = () => document.documentElement.append(mark)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()`

export interface PlaywrightAdapterOptions {
  profileDir: string
  headed?: boolean
  now?: () => number
  lookup?: ClassifyOptions['lookup']
  fixtureOrigins?: readonly string[]
  snapshotTtlMs?: number
}

export function agentBrowserLaunchOptions(headed: boolean): {
  headless: boolean
  acceptDownloads: boolean
  handleSIGINT: boolean
  handleSIGTERM: boolean
  handleSIGHUP: boolean
  viewport: { width: number; height: number }
  args: string[]
} {
  return {
    headless: !headed,
    acceptDownloads: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    viewport: { width: 1100, height: 720 },
    args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check']
  }
}

export function createPlaywrightAdapter(options: PlaywrightAdapterOptions): BrowserAutomationPort {
  const now = options.now ?? (() => Date.now())
  const ttl = options.snapshotTtlMs ?? browserSnapshotTtlMs
  const headed = options.headed !== false
  let context: BrowserContext | null = null
  let page: Page | null = null
  let executablePath = ''
  let lastBlock = ''
  const snapshots = new Map<string, { at: number; targets: BrowserTarget[] }>()

  const navigationOptions = {
    lookup: options.lookup,
    fixtureOrigins: options.fixtureOrigins
  }

  function cancelled(): BrowserOutcome {
    return { status: 'cancelled', summary: 'I stopped. Nothing else will run for that request.' }
  }

  function notOpen(): BrowserOutcome {
    return {
      status: 'failed',
      summary: 'Agent Browser is not open.',
      errorCode: 'not_open'
    }
  }

  async function closeContext(): Promise<void> {
    const current = context
    context = null
    page = null
    snapshots.clear()
    if (!current) {
      return
    }
    await Promise.race([current.close(), new Promise((resolve) => setTimeout(resolve, 5_000))])
  }

  async function stopIfAborted(signal?: AbortSignal): Promise<BrowserOutcome | null> {
    if (!signal?.aborted) {
      return null
    }
    await closeContext()
    return cancelled()
  }

  async function withSignal<T>(
    signal: AbortSignal | undefined,
    work: Promise<T>
  ): Promise<T | BrowserOutcome> {
    const stopped = await stopIfAborted(signal)
    if (stopped) {
      return stopped
    }
    if (!signal) {
      return work
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        void closeContext().finally(() => resolve(cancelled()))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      work.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(signal.aborted ? cancelled() : value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) {
            resolve(cancelled())
            return
          }
          reject(error)
        }
      )
    })
  }

  function requirePage(signal?: AbortSignal): Page | BrowserOutcome {
    if (signal?.aborted) {
      return cancelled()
    }
    if (!page || !context) {
      return notOpen()
    }
    return page
  }

  async function currentObservation(
    includeImage: boolean,
    consent: boolean
  ): Promise<BrowserOutcome> {
    const current = page
    if (!current) {
      return notOpen()
    }
    const url = current.url()
    const decision = await classifyNavigation(url, navigationOptions)
    if (!decision.ok && url !== 'about:blank') {
      return {
        status: 'failed',
        summary: decision.reason,
        errorCode: 'blocked_url'
      }
    }
    const read = await readTargets(current)
    const body = await current
      .locator('body')
      .innerText()
      .catch(() => '')
    const marked = (await current.locator('[data-companion-agent="browser"]').count()) > 0
    const observation: BrowserObservation = {
      snapshotId: randomUUID(),
      capturedAtUtc: new Date(now()).toISOString(),
      url: url.slice(0, 300),
      title: (await current.title()).slice(0, 200),
      targets: read.targets,
      untrustedText: redactSecretText(body).trim().slice(0, 2_000),
      truncated: read.truncated,
      agentMarked: marked,
      imageIncluded: false
    }
    if (includeImage && consent) {
      const bytes = await current.screenshot({ type: 'png', timeout: 5_000 })
      if (bytes.byteLength > 0 && bytes.byteLength <= imageByteLimit) {
        observation.imageIncluded = true
        observation.image = { mime: 'image/png', bytes: new Uint8Array(bytes) }
      }
    }
    snapshots.set(observation.snapshotId, { at: now(), targets: observation.targets })
    return {
      status: 'success_verified',
      summary: observation.title
        ? `I am looking at ${observation.title}.`
        : 'I am looking at Agent Browser.',
      observation
    }
  }

  async function resolveTarget(
    input: BrowserElementInput,
    signal?: AbortSignal
  ): Promise<{ page: Page; target: BrowserTarget } | BrowserOutcome> {
    const current = requirePage(signal)
    if (!('goto' in current)) {
      return current
    }
    const stored = snapshots.get(input.snapshotId)
    if (!stored || now() - stored.at > ttl) {
      return {
        status: 'failed',
        summary: 'That screen reading expired. I need to look again.',
        errorCode: 'stale_snapshot'
      }
    }
    const target = stored.targets.find((item) => item.id === input.targetId)
    if (!target) {
      return {
        status: 'ambiguous_target',
        summary: "I couldn't find that one control.",
        errorCode: 'missing_target'
      }
    }
    if (target.sensitive || isSensitiveBrowserField({ name: target.name, role: target.role })) {
      return {
        status: 'blocked_sensitive',
        summary: "I can't type into or press a password or security code.",
        errorCode: 'sensitive'
      }
    }
    const matches = current.getByRole(target.role, { name: target.name, exact: true })
    const count = await matches.count()
    if (count !== 1) {
      return {
        status: 'ambiguous_target',
        summary:
          count === 0
            ? 'That control is no longer on the page.'
            : 'More than one control has that name, so I did not press one.',
        errorCode: count === 0 ? 'missing_target' : 'ambiguous'
      }
    }
    const locator = matches.first()
    const live = await readControl(locator)
    if (
      isSensitiveBrowserField({
        name: `${target.name} ${live.fieldName}`,
        role: target.role,
        inputType: live.inputType,
        autocomplete: live.autocomplete
      })
    ) {
      return {
        status: 'blocked_sensitive',
        summary: "I can't type into or press a password or security code.",
        errorCode: 'sensitive'
      }
    }
    if (!live.enabled) {
      return {
        status: 'failed',
        summary: 'That control is not available.',
        errorCode: 'disabled'
      }
    }
    return { page: current, target }
  }

  return {
    isOpen() {
      return context !== null && page !== null
    },

    async launch(input, call) {
      const stopped = await stopIfAborted(call?.signal)
      if (stopped) {
        return stopped
      }
      if (refusedLaunchKeys.some((key) => key in input)) {
        return {
          status: 'failed',
          summary: "I only open Companion's own Agent Browser.",
          errorCode: 'external_browser'
        }
      }
      if (context && page) {
        return {
          status: 'success_verified',
          summary: 'Agent Browser is already open.',
          executablePath
        }
      }
      await mkdir(options.profileDir, { recursive: true, mode: 0o700 })
      await chmod(options.profileDir, 0o700)
      let playwright: typeof import('playwright')
      try {
        playwright = await import('playwright')
      } catch {
        return {
          status: 'unsupported',
          summary: "Agent Browser isn't available on this computer.",
          errorCode: 'unavailable'
        }
      }
      executablePath = playwright.chromium.executablePath()
      let launched: BrowserContext
      try {
        launched = await playwright.chromium.launchPersistentContext(
          options.profileDir,
          agentBrowserLaunchOptions(headed)
        )
      } catch {
        return {
          status: 'failed',
          summary: "I couldn't open Agent Browser.",
          errorCode: 'launch_failed'
        }
      }
      if (call?.signal?.aborted) {
        await launched.close().catch(() => undefined)
        return cancelled()
      }
      context = launched
      await context.route('**/*', async (route) => {
        try {
          await allowRoute(route, navigationOptions, (reason) => {
            lastBlock = reason
          })
        } catch {
          lastBlock = 'That address is not allowed.'
          await route.abort('blockedbyclient').catch(() => undefined)
        }
      })
      await context.addInitScript(bannerScript)
      const arm = (next: Page): void => {
        next.on('download', (download) => {
          void download.cancel().catch(() => undefined)
        })
        next.on('filechooser', () => {
          void next.keyboard.press('Escape').catch(() => undefined)
        })
        next.on('requestfailed', (request) => {
          if (next === page) {
            return
          }
          if (request.resourceType() === 'document' && request.frame() === next.mainFrame()) {
            void next.close().catch(() => undefined)
          }
        })
        next.on('framenavigated', (frame) => {
          if (next === page || frame !== next.mainFrame()) {
            return
          }
          void classifyNavigation(frame.url(), navigationOptions).then((decision) => {
            if (!decision.ok) {
              void next.close().catch(() => undefined)
            }
          })
        })
      }
      context.on('page', arm)
      page = context.pages()[0] ?? (await context.newPage())
      arm(page)
      page.setDefaultNavigationTimeout(navigationTimeoutMs)
      page.setDefaultTimeout(navigationTimeoutMs)
      await page.setContent(
        '<!doctype html><title>Agent Browser</title><body><p data-companion-agent="browser">Agent Browser. This is Companion\'s browser, not Safari or Chrome.</p></body>',
        { waitUntil: 'domcontentloaded' }
      )
      return {
        status: 'success_verified',
        summary: 'I opened Agent Browser. This is not Safari or Chrome.',
        executablePath
      }
    },

    async open(input, call) {
      const current = requirePage(call?.signal)
      if (!('goto' in current)) {
        return current
      }
      lastBlock = ''
      const decision = await classifyNavigation(input.url, navigationOptions)
      if (!decision.ok) {
        return { status: 'failed', summary: decision.reason, errorCode: 'blocked_url' }
      }
      try {
        const navigated = await withSignal(
          call?.signal,
          current.goto(input.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
        )
        if (isOutcome(navigated)) {
          return navigated
        }
      } catch (error) {
        if (call?.signal?.aborted) {
          return cancelled()
        }
        const detail = error instanceof Error ? error.message : ''
        const blocked = Boolean(lastBlock) || /blocked|ERR_ABORTED|ERR_BLOCKED/i.test(detail)
        return {
          status: 'failed',
          summary: lastBlock || "I couldn't open that page.",
          errorCode: blocked ? 'blocked_url' : 'navigation_failed'
        }
      }
      const landed = page?.url() ?? ''
      const after = await classifyNavigation(landed, navigationOptions)
      if (!after.ok) {
        await page?.goto('about:blank').catch(() => undefined)
        return { status: 'failed', summary: after.reason, errorCode: 'blocked_url' }
      }
      return currentObservation(false, false)
    },

    async observe(input, call) {
      const current = requirePage(call?.signal)
      if (!('goto' in current)) {
        return current
      }
      return currentObservation(input.includeImage === true, input.consent === true)
    },

    async click(input, call) {
      const resolved = await resolveTarget(input, call?.signal)
      if (!('target' in resolved)) {
        return resolved
      }
      const beforeUrl = resolved.page.url()
      const beforeText = await pageText(resolved.page)
      const matches = resolved.page.getByRole(resolved.target.role, {
        name: resolved.target.name,
        exact: true
      })
      try {
        const pressed = await withSignal(call?.signal, matches.click({ timeout: 5_000 }))
        if (isOutcome(pressed)) {
          return pressed
        }
      } catch {
        if (call?.signal?.aborted) {
          return cancelled()
        }
        return {
          status: 'failed',
          summary: lastBlock || "I couldn't press that control.",
          errorCode: lastBlock ? 'blocked_url' : 'click_failed'
        }
      }
      const afterUrl = resolved.page.url()
      const afterText = await pageText(resolved.page)
      if (beforeUrl === afterUrl && beforeText === afterText) {
        return {
          status: 'changed_but_unverified',
          summary: 'I pressed it, but the page did not show a change.'
        }
      }
      return { status: 'success_verified', summary: `I pressed ${resolved.target.name}.` }
    },

    async fill(input, call) {
      if (input.text.length > browserTextLimit) {
        return {
          status: 'failed',
          summary: 'That text is too long.',
          errorCode: 'text_too_long'
        }
      }
      const resolved = await resolveTarget(input, call?.signal)
      if (!('target' in resolved)) {
        return resolved
      }
      const matches = resolved.page.getByRole(resolved.target.role, {
        name: resolved.target.name,
        exact: true
      })
      try {
        const typed = await withSignal(call?.signal, matches.fill(input.text, { timeout: 5_000 }))
        if (isOutcome(typed)) {
          return typed
        }
        const value = await matches.inputValue()
        if (value !== input.text) {
          return {
            status: 'changed_but_unverified',
            summary: 'I typed, but the field does not show that text.'
          }
        }
      } catch {
        if (call?.signal?.aborted) {
          return cancelled()
        }
        return {
          status: 'failed',
          summary: "I couldn't type into that field.",
          errorCode: 'fill_failed'
        }
      }
      return {
        status: 'success_verified',
        summary: `I typed into ${resolved.target.name}. I did not submit the form.`
      }
    },

    async press(input, call) {
      const current = requirePage(call?.signal)
      if (!('keyboard' in current)) {
        return current
      }
      const chord = desktopKeyChords.find((item) => item === input.chord)
      if (!chord) {
        return {
          status: 'failed',
          summary: 'That key is not allowed.',
          errorCode: 'key_rejected'
        }
      }
      await current.keyboard.press(keyNames[chord])
      return { status: 'changed_but_unverified', summary: `I pressed ${chord}.` }
    },

    async scroll(input, call) {
      const current = requirePage(call?.signal)
      if (!('mouse' in current)) {
        return current
      }
      if (input.direction !== 'up' && input.direction !== 'down') {
        return {
          status: 'failed',
          summary: 'I can scroll up or down.',
          errorCode: 'bad_scroll'
        }
      }
      if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 5) {
        return {
          status: 'failed',
          summary: 'I can scroll only a short distance.',
          errorCode: 'bad_scroll'
        }
      }
      const before = await scrollTop(current)
      const size = current.viewportSize()
      await current.mouse.move((size?.width ?? 400) / 2, (size?.height ?? 400) / 2)
      const delta = (input.direction === 'up' ? -120 : 120) * input.amount
      await current.mouse.wheel(0, delta)
      let after = before
      for (let attempt = 0; attempt < 5 && after === before; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        after = await scrollTop(current)
      }
      if (after === before) {
        return { status: 'no_change', summary: 'The page did not scroll.' }
      }
      return { status: 'success_verified', summary: 'I scrolled the page.' }
    },

    async back(call) {
      const current = requirePage(call?.signal)
      if (!('goBack' in current)) {
        return current
      }
      const before = current.url()
      try {
        const moved = await withSignal(
          call?.signal,
          current.goBack({ waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs })
        )
        if (isOutcome(moved)) {
          return moved
        }
      } catch {
        if (call?.signal?.aborted) {
          return cancelled()
        }
        return {
          status: 'failed',
          summary: lastBlock || "I couldn't go back.",
          errorCode: lastBlock ? 'blocked_url' : 'navigation_failed'
        }
      }
      if (current.url() === before) {
        return { status: 'no_change', summary: 'There is no previous page.' }
      }
      return currentObservation(false, false)
    },

    async listTabs(call) {
      const stopped = await stopIfAborted(call?.signal)
      if (stopped) {
        return stopped
      }
      if (!context) {
        return notOpen()
      }
      const tabs: BrowserTab[] = []
      for (const [index, tab] of context.pages().entries()) {
        tabs.push({
          index,
          url: tab.url().slice(0, 300),
          title: (await tab.title()).slice(0, 200)
        })
      }
      return {
        status: 'success_verified',
        summary:
          tabs.length === 1
            ? 'Agent Browser has one tab.'
            : `Agent Browser has ${tabs.length} tabs.`,
        tabs
      }
    },

    async selectTab(input, call) {
      const stopped = await stopIfAborted(call?.signal)
      if (stopped) {
        return stopped
      }
      if (!context) {
        return notOpen()
      }
      const tabs = context.pages()
      if (!Number.isInteger(input.index) || input.index < 0 || input.index >= tabs.length) {
        return {
          status: 'failed',
          summary: 'That tab is not in Agent Browser.',
          errorCode: 'external_tab'
        }
      }
      page = tabs[input.index] ?? null
      await page?.bringToFront()
      return {
        status: 'success_verified',
        summary: `I switched to tab ${input.index + 1}.`,
        tabs: [
          {
            index: input.index,
            url: page?.url().slice(0, 300) ?? '',
            title: (await page?.title())?.slice(0, 200) ?? ''
          }
        ]
      }
    },

    async close() {
      await closeContext()
      return { status: 'success_verified', summary: 'I closed Agent Browser.' }
    }
  }
}

async function allowRoute(
  route: Route,
  navigationOptions: ClassifyOptions,
  block: (reason: string) => void
): Promise<void> {
  const decision = await classifyNavigation(route.request().url(), navigationOptions)
  if (!decision.ok) {
    block(decision.reason)
    await route.abort('blockedbyclient')
    return
  }
  if (route.request().resourceType() !== 'document') {
    await route.continue()
    return
  }
  let current = route.request().url()
  let response = await route.fetch({ maxRedirects: 0 })
  for (let hop = 0; hop < 5; hop += 1) {
    const status = response.status()
    const location = response.headers()['location']
    if (!location || status < 300 || status >= 400) {
      await route.fulfill({ response })
      return
    }
    current = new URL(location, current).href
    const redirect = await classifyNavigation(current, navigationOptions)
    if (!redirect.ok) {
      block(redirect.reason)
      await route.abort('blockedbyclient')
      return
    }
    response = await route.fetch({ url: current, maxRedirects: 0 })
  }
  block('That address is not allowed.')
  await route.abort('blockedbyclient')
}

function isOutcome(value: unknown): value is BrowserOutcome {
  if (!value || typeof value !== 'object') {
    return false
  }
  const status = (value as { status?: unknown }).status
  const known: readonly BrowserStatus[] = [
    'success_verified',
    'changed_but_unverified',
    'no_change',
    'ambiguous_target',
    'blocked_sensitive',
    'failed',
    'cancelled',
    'unsupported'
  ]
  return typeof status === 'string' && known.includes(status as BrowserStatus)
}

async function readTargets(
  current: Page
): Promise<{ targets: BrowserTarget[]; truncated: boolean }> {
  const targets: BrowserTarget[] = []
  let truncated = false
  for (const role of browserRoles) {
    const group = current.getByRole(role)
    const count = await group.count()
    for (let index = 0; index < count; index += 1) {
      if (targets.length >= 40) {
        truncated = true
        break
      }
      const locator = group.nth(index)
      if (!(await locator.isVisible().catch(() => false))) {
        continue
      }
      const live = await readControl(locator)
      if (!live.name) {
        continue
      }
      targets.push({
        id: `t${targets.length + 1}`,
        role,
        name: live.name.slice(0, 120),
        enabled: live.enabled,
        sensitive: isSensitiveBrowserField({
          name: `${live.name} ${live.fieldName}`,
          role,
          inputType: live.inputType,
          autocomplete: live.autocomplete
        })
      })
    }
    if (truncated) {
      break
    }
  }
  return { targets, truncated }
}

async function readControl(locator: Locator): Promise<{
  name: string
  enabled: boolean
  inputType: string
  autocomplete: string
  fieldName: string
}> {
  const enabled = await locator.isEnabled().catch(() => false)
  const facts = await locator.evaluate((element) => {
    const node = element as HTMLElement
    const id = node.getAttribute('id')
    let label = node.getAttribute('aria-label') ?? ''
    if (!label && id) {
      const owner = node.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
      label = owner?.textContent ?? ''
    }
    if (!label) {
      label = node.innerText || node.textContent || ''
    }
    return {
      name: label.replace(/\s+/g, ' ').trim(),
      inputType: node.getAttribute('type') ?? '',
      autocomplete: node.getAttribute('autocomplete') ?? '',
      fieldName: node.getAttribute('name') ?? ''
    }
  })
  return { ...facts, name: facts.name || facts.fieldName, enabled }
}

async function pageText(current: Page): Promise<string> {
  return current
    .locator('body')
    .innerText()
    .catch(() => '')
}

async function scrollTop(current: Page): Promise<number> {
  return current.evaluate(() => document.scrollingElement?.scrollTop ?? window.scrollY ?? 0)
}
