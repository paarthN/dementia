import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, Locator, Page, Route } from 'playwright'
import { isDevOnlyRuntimePath } from '../../packaging/bundledRuntime'
import { redactSecretText } from '../AgentPrompt'
import { desktopKeyChords } from './DesktopAutomationPort'
import {
  browserRoles,
  browserSnapshotTtlMs,
  browserScopedTargetCap,
  browserTargetSoftCap,
  browserTextLimit,
  type BrowserAutomationPort,
  type BrowserElementInput,
  type BrowserObservation,
  type BrowserObserveInput,
  type BrowserTab,
  type BrowserOutcome,
  type BrowserStatus,
  type BrowserTarget,
  type BrowserWithin
} from './BrowserAutomationPort'
import { classifyNavigation, isSensitiveBrowserField, type ClassifyOptions } from './browserSafety'
import {
  actionExpectationMet,
  assignObservationIds,
  meaningfulPageChange,
  preferTargets,
  preferUniqueTarget,
  resolveTargetQuery,
  targetIdentityKey,
  targetsMatchingIdentity
} from './browserTargeting'

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
  browserExecutable?: string | null
  readPageText?: (signal?: AbortSignal) => Promise<string>
}

function browserProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  return env
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

export function agentBrowserProfileBusy(message: string): boolean {
  return /processsingleton|already in use|profile is in use|existing browser session/i.test(message)
}

export function singletonLockPid(target: string): number | null {
  const match = /-(\d+)$/.exec(target.trim())
  if (!match) {
    return null
  }
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function commandOwnsAgentBrowser(command: string, profileDir: string): boolean {
  return command.includes(profileDir) && /Google Chrome for Testing|Chromium/i.test(command)
}

/**
 * True when the frontmost app is Companion's own browser. Used to decide which surface
 * to observe: an allowlist of ordinary Mac apps cannot be complete, but the one browser
 * Companion launches itself is knowable.
 */
export function isAgentBrowserApp(appName: string): boolean {
  return /^(chromium|google chrome for testing)$/i.test(appName.trim())
}

export async function releaseLockedAgentBrowser(
  profileDir: string,
  deps?: {
    lockTarget?: (dir: string) => Promise<string>
    commandOf?: (pid: number) => Promise<string>
    kill?: (pid: number, signal: NodeJS.Signals) => void
    alive?: (pid: number) => boolean
    wait?: (ms: number) => Promise<void>
  }
): Promise<boolean> {
  const lockTarget = deps?.lockTarget ?? ((dir: string) => readlink(join(dir, 'SingletonLock')))
  const commandOf = deps?.commandOf ?? processCommand
  const kill = deps?.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const alive =
    deps?.alive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  const wait = deps?.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let target: string
  try {
    target = await lockTarget(profileDir)
  } catch {
    return false
  }
  const pid = singletonLockPid(target)
  if (!pid) {
    return false
  }
  const command = await commandOf(pid)
  if (!commandOwnsAgentBrowser(command, profileDir)) {
    return false
  }
  try {
    kill(pid, 'SIGTERM')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code !== 'ESRCH') {
      return false
    }
  }
  for (let attempt = 0; attempt < 20 && alive(pid); attempt += 1) {
    await wait(100)
  }
  if (alive(pid)) {
    try {
      kill(pid, 'SIGKILL')
    } catch {
      return !alive(pid)
    }
  }
  return true
}

function processCommand(pid: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-p', String(pid), '-o', 'command='], { shell: false })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(output))
  })
}

export function firstSentences(text: string, count = 2): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) {
    return ''
  }
  const parts = cleaned.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [cleaned]
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, count)
    .join(' ')
    .slice(0, 500)
}

export function pageObservationSummary(title: string, text: string): string {
  const lead = title ? `I am looking at ${title}.` : 'I am looking at Agent Browser.'
  const sentences = firstSentences(text)
  const excerpt = (sentences || text).replace(/\s+/g, ' ').trim().slice(0, 500)
  return excerpt ? `${lead} First sentences: ${excerpt}` : lead
}

export async function pageTextWithOcr(
  body: string,
  url: string,
  readPageText: ((signal?: AbortSignal) => Promise<string>) | undefined,
  signal?: AbortSignal
): Promise<string> {
  const trimmed = body.trim()
  const thin = trimmed.length < 400
  const maps = /\/maps(?:\/|$|\?)/i.test(url)
  if ((!thin && !maps) || !readPageText || signal?.aborted) {
    return body
  }
  const extra = (await readPageText(signal).catch(() => '')).trim()
  if (!extra || trimmed.includes(extra.slice(0, 80))) {
    return body
  }
  return `${trimmed}\n${extra}`.slice(0, 2_000)
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
    consent: boolean,
    signal?: AbortSignal,
    within?: BrowserWithin
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
    const read = await readTargets(current, within)
    const domText = await readablePageText(current)
    const body = await pageTextWithOcr(domText, url, options.readPageText, signal)
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
      summary: pageObservationSummary(observation.title, observation.untrustedText),
      observation
    }
  }

  async function resolveTarget(
    input: BrowserElementInput,
    signal?: AbortSignal
  ): Promise<{ page: Page; target: BrowserTarget; locator: Locator } | BrowserOutcome> {
    const current = requirePage(signal)
    if (!('goto' in current)) {
      return current
    }
    const selected = selectObservedTarget(input)
    if ('target' in selected) {
      let wanted = selected.target
      const stored = snapshots.get(input.snapshotId)
      if (!stored || now() - stored.at > ttl) {
        const rematched = await rematchTarget(wanted, signal)
        if ('target' in rematched) {
          wanted = rematched.target
        } else {
          const named = await resolveByNameRole(input, signal)
          if (named) {
            return named
          }
          return rematched
        }
      }
      const live = await resolveLive(current, wanted)
      if ('target' in live) {
        return live
      }
      const named = await resolveByNameRole(input, signal)
      return named ?? live
    }
    const named = await resolveByNameRole(input, signal)
    return named ?? selected
  }

  async function rematchTarget(
    wanted: BrowserTarget,
    signal?: AbortSignal
  ): Promise<{ target: BrowserTarget } | BrowserOutcome> {
    const refreshed = await currentObservation(false, false, signal)
    if (refreshed.status !== 'success_verified' || !refreshed.observation) {
      return {
        status: 'failed',
        summary: 'That screen reading expired. I need to look again.',
        errorCode: 'stale_snapshot'
      }
    }
    const stored = snapshots.get(refreshed.observation.snapshotId)
    if (!stored) {
      return {
        status: 'failed',
        summary: 'That screen reading expired. I need to look again.',
        errorCode: 'stale_snapshot'
      }
    }
    const matches = targetsMatchingIdentity(stored.targets, targetIdentityKey(wanted))
    if (matches.length === 1) {
      return { target: matches[0]! }
    }
    const byName = preferUniqueTarget(
      stored.targets.filter(
        (item) => item.role === wanted.role && item.name === wanted.name && !item.sensitive
      ),
      wanted
    )
    if (byName) {
      return { target: byName }
    }
    return {
      status: 'failed',
      summary: 'That control changed. I need to look again.',
      errorCode: 'stale_snapshot'
    }
  }

  async function resolveByNameRole(
    input: BrowserElementInput,
    signal?: AbortSignal
  ): Promise<{ page: Page; target: BrowserTarget; locator: Locator } | null> {
    const current = requirePage(signal)
    if (!('goto' in current)) {
      return null
    }
    const role = browserRoles.find((item) => item === input.role)
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!role || !name) {
      return null
    }
    const refreshed = await currentObservation(false, false, signal)
    const pool = refreshed.observation?.targets ?? []
    const matches = preferUniqueTarget(
      pool.filter(
        (item) => item.role === role && item.name === name && !item.sensitive && item.enabled
      ),
      { ancestors: Array.isArray(input.ancestors) ? input.ancestors : [] }
    )
    if (!matches) {
      return null
    }
    const live = await resolveLive(current, matches)
    return 'target' in live ? live : null
  }

  function selectObservedTarget(
    input: BrowserElementInput
  ): { target: BrowserTarget } | BrowserOutcome {
    const stored = snapshots.get(input.snapshotId)
    if (input.query) {
      const pool = stored?.targets ?? []
      const resolved = resolveTargetQuery(pool, input.query)
      if (!resolved.ok) {
        return {
          status: resolved.reason === 'unsupported' ? 'failed' : 'ambiguous_target',
          summary:
            resolved.reason === 'unsupported'
              ? 'Use a list item index inside within, not a global ordinal.'
              : resolved.reason === 'missing'
                ? "I couldn't find that one control."
                : 'More than one control matches that description.',
          errorCode: resolved.reason
        }
      }
      return { target: resolved.target }
    }
    if (!input.targetId) {
      return {
        status: 'failed',
        summary: 'I need one control from the current page reading.',
        errorCode: 'missing_target'
      }
    }
    if (!stored) {
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
    return { target }
  }

  async function resolveLive(
    current: Page,
    target: BrowserTarget
  ): Promise<{ page: Page; target: BrowserTarget; locator: Locator } | BrowserOutcome> {
    if (target.sensitive || isSensitiveBrowserField({ name: target.name, role: target.role })) {
      return {
        status: 'blocked_sensitive',
        summary: "I can't type into or press a password or security code.",
        errorCode: 'sensitive'
      }
    }
    const matches = current.getByRole(target.role, { name: target.name, exact: true })
    const count = await matches.count()
    const identity = targetIdentityKey(target)
    const survivors: Array<{ locator: Locator; live: BrowserTarget }> = []
    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index)
      if (!(await locator.isVisible().catch(() => false))) {
        continue
      }
      const live = await describeTarget(locator, target.role)
      if (targetIdentityKey(live) !== identity) {
        continue
      }
      if (
        live.sensitive ||
        isSensitiveBrowserField({
          name: `${live.name} ${live.fieldName}`,
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
      survivors.push({ locator, live })
    }
    if (survivors.length === 0) {
      return {
        status: 'failed',
        summary: 'That control changed. I need to look again.',
        errorCode: 'stale_snapshot'
      }
    }
    if (survivors.length > 1) {
      return {
        status: 'ambiguous_target',
        summary: 'More than one control has that name, so I did not press one.',
        errorCode: 'ambiguous'
      }
    }
    return { page: current, target: survivors[0]!.live, locator: survivors[0]!.locator }
  }

  const port: BrowserAutomationPort = {
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
      if (
        options.browserExecutable === null ||
        (options.browserExecutable !== undefined &&
          (!existsSync(options.browserExecutable) ||
            isDevOnlyRuntimePath(options.browserExecutable)))
      ) {
        return {
          status: 'unsupported',
          summary: "Agent Browser isn't included in this copy of Companion.",
          errorCode: 'unavailable'
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
      executablePath = options.browserExecutable ?? playwright.chromium.executablePath()
      if (isDevOnlyRuntimePath(executablePath)) {
        return {
          status: 'failed',
          summary: "I only open Companion's own Agent Browser.",
          errorCode: 'external_browser'
        }
      }
      const startContext = (): Promise<BrowserContext> =>
        playwright.chromium.launchPersistentContext(options.profileDir, {
          ...agentBrowserLaunchOptions(headed),
          executablePath,
          env: browserProcessEnv()
        })
      let launched: BrowserContext
      try {
        launched = await startContext()
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const busy = agentBrowserProfileBusy(message)
        const released = busy ? await releaseLockedAgentBrowser(options.profileDir) : false
        if (!released) {
          return {
            status: 'failed',
            summary: busy
              ? 'Agent Browser is still open from another Companion window.'
              : "I couldn't open Agent Browser.",
            errorCode: 'launch_failed'
          }
        }
        try {
          launched = await startContext()
        } catch {
          return {
            status: 'failed',
            summary: "I couldn't open Agent Browser after closing the previous one.",
            errorCode: 'launch_failed'
          }
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
      if (!page || !context) {
        const started = await port.launch({}, call)
        if (started.status !== 'success_verified') {
          return started
        }
      }
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
      if (page && !call?.signal?.aborted) {
        await page
          .waitForFunction(
            () => ((document.body && document.body.innerText) || '').trim().length > 120,
            undefined,
            { timeout: 8_000 }
          )
          .catch(() => undefined)
      }
      return currentObservation(false, false, call?.signal)
    },

    async observe(input: BrowserObserveInput, call) {
      const current = requirePage(call?.signal)
      if (!('goto' in current)) {
        return current
      }
      return currentObservation(
        input.includeImage === true,
        input.consent === true,
        call?.signal,
        input.within
      )
    },

    async click(input, call) {
      const resolved = await resolveTarget(input, call?.signal)
      if (!('target' in resolved)) {
        return resolved
      }
      const beforeUrl = resolved.page.url()
      const beforeText = await pageText(resolved.page)
      try {
        const pressed = await withSignal(call?.signal, resolved.locator.click({ timeout: 5_000 }))
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
      const after = await waitForActionEffect(resolved.page, {
        beforeUrl,
        beforeText,
        expectUrlIncludes: input.expectUrlIncludes,
        expectTextIncludes: input.expectTextIncludes
      })
      if (after.verified) {
        return {
          status: 'success_verified',
          summary: `I pressed ${resolved.target.name}.`
        }
      }
      if (after.alreadyTrue) {
        return {
          status: 'changed_but_unverified',
          summary: `I pressed ${resolved.target.name}. The text you expected was already on the page before the click, so it cannot confirm anything. Pick evidence that appears only after the action.`,
          errorCode: 'expectation_already_true'
        }
      }
      if (after.changed) {
        return {
          status: 'changed_but_unverified',
          summary: 'I pressed it, but I could not confirm the expected result.'
        }
      }
      return {
        status: 'changed_but_unverified',
        summary: 'I pressed it, but the page did not show a change.'
      }
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
      if (resolved.target.role === 'checkbox' || resolved.target.role === 'radio') {
        return {
          status: 'failed',
          summary: 'Use browser.click to change a checkbox or radio.',
          errorCode: 'use_click'
        }
      }
      try {
        const typed = await withSignal(
          call?.signal,
          resolved.locator.fill(input.text, { timeout: 5_000 })
        )
        if (isOutcome(typed)) {
          return typed
        }
        const value = await resolved.locator.inputValue()
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
      // A text field's value never shows up in page.innerText, so without echoing it
      // here, a goal check that asks whether the typed text landed has no evidence to
      // read — it would wait forever on a fill that already succeeded.
      return {
        status: 'success_verified',
        summary: `I typed "${redactSecretText(input.text).slice(0, 120)}" into ${resolved.target.name}. I did not submit the form.`
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
      return currentObservation(false, false, call?.signal)
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
  return port
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
  current: Page,
  within?: BrowserWithin
): Promise<{ targets: BrowserTarget[]; truncated: boolean }> {
  const roles: string[] = [...browserRoles]
  const raw = await current
    .evaluate((wantedRoles: string[]) => {
      const landmark = new Set([
        'dialog',
        'alertdialog',
        'main',
        'navigation',
        'complementary',
        'form',
        'region',
        'list',
        'listitem',
        'article',
        'group'
      ])
      const implicitRole = (node: Element): string => {
        const tag = node.tagName.toLowerCase()
        if (tag === 'main') return 'main'
        if (tag === 'nav') return 'navigation'
        if (tag === 'aside') return 'complementary'
        if (tag === 'form') return 'form'
        if (tag === 'article') return 'article'
        if (tag === 'dialog') return 'dialog'
        if (tag === 'ul' || tag === 'ol') return 'list'
        if (tag === 'li') return 'listitem'
        if (tag === 'button') return 'button'
        if (tag === 'a' && node.hasAttribute('href')) return 'link'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return 'combobox'
        if (tag === 'input') {
          const type = ((node as HTMLInputElement).type || 'text').toLowerCase()
          if (type === 'checkbox') return 'checkbox'
          if (type === 'radio') return 'radio'
          if (type === 'search') return 'searchbox'
          if (['button', 'submit', 'reset'].includes(type)) return 'button'
          return 'textbox'
        }
        return (node.getAttribute('role') || '').toLowerCase()
      }
      const explicitName = (node: HTMLElement): string => {
        const labelledBy = node.getAttribute('aria-labelledby')
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => node.ownerDocument.getElementById(id)?.textContent ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
          if (parts) return parts.slice(0, 120)
        }
        return (node.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      }
      const controlName = (node: HTMLElement): string => {
        const named = explicitName(node)
        if (named) return named
        const id = node.getAttribute('id')
        if (id) {
          const owner = node.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
          const label = (owner?.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (label) return label.slice(0, 120)
        }
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
        return (text || node.getAttribute('name') || '').slice(0, 120)
      }
      const ancestorsOf = (
        node: HTMLElement
      ): { ancestors: Array<{ role: string; name?: string }>; inListIndex?: number } => {
        const ancestors: Array<{ role: string; name?: string }> = []
        let listIndex: number | undefined
        let cursor: HTMLElement | null = node.parentElement
        while (cursor && ancestors.length < 4) {
          const roleName = (cursor.getAttribute('role') || implicitRole(cursor)).toLowerCase()
          if (landmark.has(roleName)) {
            let name = explicitName(cursor)
            if (!name && roleName === 'listitem') {
              name = (cursor.innerText || cursor.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120)
            }
            ancestors.unshift({ role: roleName, ...(name ? { name } : {}) })
            if (roleName === 'listitem' && listIndex === undefined) {
              let index = 1
              let sibling = cursor.previousElementSibling
              while (sibling) {
                const siblingRole = (
                  sibling.getAttribute('role') || implicitRole(sibling)
                ).toLowerCase()
                if (siblingRole === 'listitem') index += 1
                sibling = sibling.previousElementSibling
              }
              listIndex = index
            }
          }
          cursor = cursor.parentElement
        }
        return { ancestors, inListIndex: listIndex }
      }
      const isVisible = (node: HTMLElement): boolean => {
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const collected: Array<{
        role: string
        name: string
        enabled: boolean
        inputType: string
        autocomplete: string
        fieldName: string
        ancestors: Array<{ role: string; name?: string }>
        inListIndex?: number
      }> = []
      const all = Array.from(document.querySelectorAll('body *')) as HTMLElement[]
      for (const node of all) {
        const role = implicitRole(node)
        if (!wantedRoles.includes(role)) continue
        if (!isVisible(node)) continue
        const name = controlName(node)
        if (!name) continue
        const context = ancestorsOf(node)
        collected.push({
          role,
          name,
          enabled:
            !(node as HTMLButtonElement).disabled && node.getAttribute('aria-disabled') !== 'true',
          inputType: node.getAttribute('type') ?? '',
          autocomplete: node.getAttribute('autocomplete') ?? '',
          fieldName: node.getAttribute('name') ?? '',
          ancestors: context.ancestors,
          inListIndex: context.inListIndex
        })
      }
      return collected
    }, roles)
    .catch(() => [])

  const collected: BrowserTarget[] = []
  for (const [index, item] of raw.entries()) {
    const role = browserRoles.find((entry) => entry === item.role)
    if (!role) {
      continue
    }
    collected.push({
      id: `t${index + 1}`,
      role,
      name: item.name.slice(0, 120),
      enabled: item.enabled,
      sensitive: isSensitiveBrowserField({
        name: `${item.name} ${item.fieldName}`,
        role,
        inputType: item.inputType,
        autocomplete: item.autocomplete
      }),
      ancestors: item.ancestors,
      inListIndex: item.inListIndex
    })
  }
  const scoped = within ? collected.filter((item) => targetInWithin(item, within)) : collected
  const capped = preferTargets(scoped, within ? browserScopedTargetCap : browserTargetSoftCap)
  return {
    targets: assignObservationIds(capped.targets),
    truncated: capped.truncated
  }
}

function targetInWithin(target: BrowserTarget, within: BrowserWithin): boolean {
  const ancestor = target.ancestors.find((entry) => {
    if (entry.role !== within.role) {
      return false
    }
    if (within.name !== undefined && entry.name !== within.name) {
      return false
    }
    if (
      within.nameIncludes &&
      !(entry.name ?? '').toLowerCase().includes(within.nameIncludes.toLowerCase())
    ) {
      return false
    }
    return true
  })
  if (!ancestor) {
    return false
  }
  if (within.itemOrdinal === undefined) {
    return true
  }
  return target.inListIndex === within.itemOrdinal
}

async function describeTarget(
  locator: Locator,
  role: BrowserTarget['role']
): Promise<
  BrowserTarget & {
    inputType: string
    autocomplete: string
    fieldName: string
  }
> {
  const enabled = await locator.isEnabled().catch(() => false)
  const facts = await locator.evaluate((element, expectedRole) => {
    const landmark = new Set([
      'dialog',
      'alertdialog',
      'main',
      'navigation',
      'complementary',
      'form',
      'region',
      'list',
      'listitem',
      'article',
      'group'
    ])
    const implicitRole = (node: Element): string => {
      const tag = node.tagName.toLowerCase()
      if (tag === 'main') return 'main'
      if (tag === 'nav') return 'navigation'
      if (tag === 'aside') return 'complementary'
      if (tag === 'form') return 'form'
      if (tag === 'article') return 'article'
      if (tag === 'dialog') return 'dialog'
      if (tag === 'ul' || tag === 'ol') return 'list'
      if (tag === 'li') return 'listitem'
      return ''
    }
    const explicitName = (node: HTMLElement): string => {
      const labelledBy = node.getAttribute('aria-labelledby')
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((id) => node.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (parts) {
          return parts.slice(0, 120)
        }
      }
      const aria = (node.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim()
      if (aria) {
        return aria.slice(0, 120)
      }
      return ''
    }
    const node = element as HTMLElement
    const ancestors: Array<{ role: string; name?: string }> = []
    let listIndex: number | undefined
    let cursor: HTMLElement | null = node.parentElement
    while (cursor && ancestors.length < 4) {
      const roleName = (cursor.getAttribute('role') || implicitRole(cursor)).toLowerCase()
      if (landmark.has(roleName)) {
        let name = explicitName(cursor)
        if (!name && roleName === 'listitem') {
          name = (cursor.innerText || cursor.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
        }
        ancestors.unshift({ role: roleName, ...(name ? { name } : {}) })
        if (roleName === 'listitem' && listIndex === undefined) {
          let index = 1
          let sibling = cursor.previousElementSibling
          while (sibling) {
            const siblingRole = (
              sibling.getAttribute('role') || implicitRole(sibling)
            ).toLowerCase()
            if (siblingRole === 'listitem') {
              index += 1
            }
            sibling = sibling.previousElementSibling
          }
          listIndex = index
        }
      }
      cursor = cursor.parentElement
    }
    const id = node.getAttribute('id')
    let label = node.getAttribute('aria-label') ?? ''
    if (!label && id) {
      const owner = node.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)
      label = owner?.textContent ?? ''
    }
    if (!label) {
      label = node.innerText || node.textContent || ''
    }
    const name = label.replace(/\s+/g, ' ').trim()
    const fieldName = node.getAttribute('name') ?? ''
    const inputType = node.getAttribute('type') ?? ''
    const autocomplete = node.getAttribute('autocomplete') ?? ''
    return {
      role: expectedRole,
      name: name || fieldName,
      ancestors,
      inListIndex: listIndex,
      inputType,
      autocomplete,
      fieldName
    }
  }, role)
  const sensitive = isSensitiveBrowserField({
    name: `${facts.name} ${facts.fieldName}`,
    role,
    inputType: facts.inputType,
    autocomplete: facts.autocomplete
  })
  return {
    id: 'live',
    role,
    name: facts.name.slice(0, 120),
    enabled,
    sensitive,
    ancestors: facts.ancestors,
    inListIndex: facts.inListIndex,
    inputType: facts.inputType,
    autocomplete: facts.autocomplete,
    fieldName: facts.fieldName
  }
}

async function waitForActionEffect(
  current: Page,
  input: {
    beforeUrl: string
    beforeText: string
    expectUrlIncludes?: string
    expectTextIncludes?: string
  }
): Promise<{ verified: boolean; changed: boolean; alreadyTrue: boolean }> {
  const textNeedle = input.expectTextIncludes?.trim()
  const urlNeedle = input.expectUrlIncludes?.trim()
  // Evidence that was already on the screen before the action can never become newly
  // true, so trusting it would permanently mark a real, working click unverified. Fall
  // back to the same generic "did anything change" check used when no expectation was
  // given at all, instead of giving up on this action.
  const alreadyTrue = Boolean(
    (textNeedle && input.beforeText.toLowerCase().includes(textNeedle.toLowerCase())) ||
    (urlNeedle && input.beforeUrl.toLowerCase().includes(urlNeedle.toLowerCase()))
  )
  const hasExpectation = Boolean((textNeedle || urlNeedle) && !alreadyTrue)
  let afterUrl = current.url()
  let afterText = await pageText(current)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    afterUrl = current.url()
    afterText = await pageText(current)
    if (hasExpectation) {
      if (
        actionExpectationMet({
          beforeText: input.beforeText,
          afterText,
          beforeUrl: input.beforeUrl,
          afterUrl,
          expectTextIncludes: input.expectTextIncludes,
          expectUrlIncludes: input.expectUrlIncludes
        })
      ) {
        return { verified: true, changed: true, alreadyTrue }
      }
    } else if (
      meaningfulPageChange({
        beforeText: input.beforeText,
        afterText,
        beforeUrl: input.beforeUrl,
        afterUrl
      })
    ) {
      return { verified: true, changed: true, alreadyTrue }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const changed = meaningfulPageChange({
    beforeText: input.beforeText,
    afterText,
    beforeUrl: input.beforeUrl,
    afterUrl
  })
  if (hasExpectation) {
    return { verified: false, changed, alreadyTrue }
  }
  return { verified: changed, changed, alreadyTrue }
}

async function pageText(current: Page): Promise<string> {
  return readablePageText(current)
}

async function readablePageText(current: Page): Promise<string> {
  return current
    .evaluate(() => {
      const paragraphs = Array.from(
        document.querySelectorAll('#mw-content-text .mw-parser-output > p')
      )
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 40)
        .slice(0, 4)
        .join(' ')
      if (paragraphs.length > 40) {
        return paragraphs.slice(0, 2_000)
      }
      const main = document.querySelector(
        'main, article, #content, #mw-content-text, [role="main"]'
      )
      const mainText = ((main as HTMLElement | null)?.innerText || '').trim()
      if (mainText.length > 40) {
        return mainText.slice(0, 2_000)
      }
      return (document.body?.innerText || '').slice(0, 2_000)
    })
    .catch(() => '')
}

async function scrollTop(current: Page): Promise<number> {
  return current.evaluate(() => document.scrollingElement?.scrollTop ?? window.scrollY ?? 0)
}
