import { randomUUID } from 'node:crypto'
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray
} from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import type { ActiveTaskView, ChatMessage, PendingApproval, RoutedRequest } from '../shared/agent'
import { isBundleId } from '../shared/favorites'
import {
  clampScreenPoint,
  mascotWindowSize,
  resolveWorkArea,
  screenToUnit,
  unitToScreen,
  type WorkArea
} from '../shared/mascotPlacement'
import { nextTextScale, resetAppearance } from '../shared/preferences'
import { assistantOrigin } from '../shared/assistant'
import { routeUtterance } from '../shared/router'
import type { FavoriteSaveResult } from '../shared/favorites'
import {
  reminderNotificationCopy,
  type DueReminder,
  type ReminderCommandResult
} from '../shared/reminders'
import type { ActionResult, PanelView, SessionSnapshot } from '../shared/session'
import { guideUtterance } from '../shared/guides'
import {
  applyGuidanceOverlayBehavior,
  guidanceOverlayWindowOptions,
  type DisplaySpace
} from '../shared/highlightGeometry'
import { panelChrome, privacySettingsUrl } from '../shared/systemPermissions'
import type { SystemSettingsSection } from '../shared/systemSettings'
import {
  deleteFavorite,
  listFavorites,
  loadPreferences,
  markFavoriteLaunched,
  reorderFavorite,
  saveFavorite,
  savePreferences
} from './storage/database'
import {
  launchBundle,
  launchSystemSettings,
  launchWebsite,
  type CommandRunner
} from './services/launcher'
import {
  createFromLocalParts,
  createReminderScheduler,
  type ReminderNotice
} from './services/reminderScheduler'
import { readCapabilities } from './services/capabilities'
import { writeCrashNote } from './services/crashNote'
import { resolveBundledBrowser } from './packaging/bundledRuntime'
import { planHelperPrompts, readHelperPermissionStatus } from '../shared/permissionPrompt'
import { promptSystemMedia } from './services/systemPermissions'
import { createScreenCoordinator } from './services/screenCoordinator'
import {
  createClosedOsBridge,
  createMacOsBridge,
  resolveHelperCommand,
  type OsBridge
} from './services/osBridge'
import { TaskOrchestrator, type TaskOutcome } from './services/taskOrchestrator'
import { AgentSessionController } from './agent/AgentSessionController'
import { AuthorizedToolExecutor } from './agent/AuthorizedToolExecutor'
import {
  cloudAgentConsent,
  createAgentProviderClient,
  runConsentedAgent
} from './agent/AgentProviderClient'
import {
  browserObservationForAgent,
  observationForAgent,
  prepareModelObservation
} from './agent/AgentPrompt'
import { createPeekabooDesktop } from './agent/ports/PeekabooDesktopAdapter'
import type { DesktopAutomationPort } from './agent/ports/DesktopAutomationPort'
import type { BrowserAutomationPort } from './agent/ports/BrowserAutomationPort'
import { createPlaywrightAdapter, isAgentBrowserApp } from './agent/ports/PlaywrightAdapter'
import { createRemoteAssistant } from './providers/assistant'
import { createToolRegistry } from './services/toolRegistry'
import type { AgentRunResult } from '../shared/computerAgent'
import { agentBusy, agentStatusSchema, type AgentStatus } from '../shared/agentStatus'
import { AgentApprovalGate } from './agent/AgentApprovalGate'
import { readLiveTarget } from './agent/AgentEvents'
import { listReminders } from './storage/reminders'
import { devToolsAllowed, secureWebPreferences } from './windows/secureWebPreferences'
import { loadRenderer } from './windows/loadRenderer'

export class Desktop {
  private panelWindow: BrowserWindow | null = null
  private mascotWindow: BrowserWindow | null = null
  private overlayWindow: BrowserWindow | null = null
  private guideTimer: ReturnType<typeof setInterval> | null = null
  private tray: Tray | null = null
  private panelView: PanelView = 'home'
  private shortcutWarning: string | null = null
  private notice: string | null = null
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private loginItemTouched = false
  private messages: ChatMessage[] = []
  private activeTask: ActiveTaskView | null = null
  private pendingApproval: PendingApproval | null = null
  private dueReminders: DueReminder[] = []
  private helperRunning = false
  private pendingScreenText: string | null = null
  private screenShareStopped = false
  private helperAccessibilityTrusted: boolean | null = null
  private helperScreenCaptureAllowed: boolean | null = null
  private helperPrompts = { accessibility: false, screenCapture: false }
  private readonly scheduler: ReturnType<typeof createReminderScheduler>
  private readonly bridge: OsBridge
  private readonly remote: ReturnType<typeof createRemoteAssistant>
  private readonly agentClient: ReturnType<typeof createAgentProviderClient>
  private readonly agentSession = new AgentSessionController()
  private readonly agentGate = new AgentApprovalGate()
  private agentStatus: AgentStatus | null = null
  private agentGoal: string | null = null
  private readonly screenHelp: ReturnType<typeof createScreenCoordinator>
  private readonly orchestrator: TaskOrchestrator
  private desktopPort: DesktopAutomationPort | null = null
  private readonly browserPort: BrowserAutomationPort

  constructor(
    private readonly db: DatabaseSync,
    private readonly run: CommandRunner
  ) {
    this.scheduler = createReminderScheduler({
      db: this.db,
      now: () => new Date(),
      timer: {
        set: (delay, fn) => setTimeout(fn, delay),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
      },
      notify: (notice) => this.rememberReminder(notice)
    })
    const helper = resolveHelperCommand(process.env, process.cwd(), {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    })
    this.bridge = helper ? createMacOsBridge(helper) : createClosedOsBridge()
    const displays = (): DisplaySpace[] =>
      screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        scaleFactor: display.scaleFactor
      }))
    const peekaboo = createPeekabooDesktop()
    const desktopPort = peekaboo.port
    this.screenHelp = createScreenCoordinator({
      bridge: this.bridge,
      displays
    })
    this.desktopPort = desktopPort
    this.browserPort = createPlaywrightAdapter({
      profileDir: join(app.getPath('userData'), 'agent-browser'),
      headed: true,
      browserExecutable: app.isPackaged ? resolveBundledBrowser(process.resourcesPath) : undefined,
      readPageText: (signal) => peekaboo.readVisibleText(signal)
    })
    this.screenHelp.setDeveloperInspection(
      loadPreferences(this.db).privacy.developerInspection === true
    )
    this.remote = createRemoteAssistant({
      origin: () => loadPreferences(this.db).privacy.assistantOrigin ?? '',
      token: () => process.env.COMPANION_PROXY_TOKEN
    })
    this.agentClient = createAgentProviderClient({
      origin: () => loadPreferences(this.db).privacy.assistantOrigin ?? '',
      token: () => process.env.COMPANION_PROXY_TOKEN
    })
    this.orchestrator = new TaskOrchestrator({
      db: this.db,
      run: this.run,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reminders: this.scheduler,
      screenPermission: () => this.screenHelp.status().access === 'on',
      screen: this.screenHelp,
      desktop: desktopPort,
      browser: this.browserPort,
      interpret: (text) => this.interpret(text)
    })
  }

  private interpret(text: string): Promise<RoutedRequest> {
    const guide = this.screenHelp.currentGuide()
    const pointed =
      guide && guide.status === 'showing' && guide.targetName
        ? { name: guide.targetName, role: guide.targetRole, appName: guide.appName }
        : undefined
    const local = routeUtterance(text, {
      favorites: listFavorites(this.db).map((favorite) => ({
        kind: favorite.kind,
        title: favorite.title,
        target: favorite.target
      })),
      now: new Date(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pointed
    })
    const preferences = loadPreferences(this.db)
    const cloud =
      preferences.privacy.assistantMode === 'cloud' &&
      preferences.privacy.cloudConsentAtUtc &&
      preferences.privacy.assistantOrigin
    const resolvedHere =
      local.intent === 'press_control' ||
      (local.intent === 'guide_task' && typeof local.parameters.name === 'string')
    if (!cloud || !preferences.privacy.assistantOrigin || resolvedHere) {
      return Promise.resolve(local)
    }
    return this.remote.interpret(text)
  }

  runComputerAgent(goal: string): Promise<AgentRunResult> {
    const consented = cloudAgentConsent(loadPreferences(this.db).privacy)
    return runConsentedAgent({
      goal,
      consented,
      remote: this.agentClient,
      executor: new AuthorizedToolExecutor(createToolRegistry()),
      session: this.agentSession,
      context: (signal) => ({
        db: this.db,
        run: this.run,
        now: () => new Date(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screenPermission: this.screenHelp.status().access === 'on',
        allowedBundleIds: () =>
          listFavorites(this.db)
            .filter((favorite) => favorite.kind === 'application')
            .map((favorite) => favorite.target),
        signal,
        reminders: this.scheduler,
        screen: this.screenHelp,
        desktop: this.desktopPort ?? undefined,
        browser: this.browserPort
      }),
      screenShare: () => this.screenShared(),
      observe: (signal) => this.observeForAgent(signal),
      onStatus: (status) => this.setAgentStatus(status),
      waitForApproval: (approval, signal) => this.agentGate.wait(approval, signal)
    })
  }

  currentAgentStatus(): AgentStatus | null {
    return this.agentStatus
  }

  startAgent(text: string): AgentStatus | null {
    const goal = text.trim()
    if (!goal) {
      this.flash('Type a request first.')
      return this.agentStatus
    }
    if (this.agentStatus && agentBusy(this.agentStatus)) {
      this.flash('A task is already running. Press Stop before starting another.')
      return this.agentStatus
    }
    this.agentGoal = goal.slice(0, 240)
    this.messages.push(this.message('user', goal, 'text'))
    if (!cloudAgentConsent(loadPreferences(this.db).privacy)) {
      const reason =
        'Cloud assistant is off until you allow it in Settings. You can do this yourself instead.'
      this.messages.push(this.message('assistant', reason, 'status'))
      this.setAgentStatus({
        taskId: 'needs-consent',
        goal: this.agentGoal,
        state: 'awaiting_permission',
        current: 'Waiting for you.',
        completed: null,
        step: 0,
        verified: false,
        approval: null,
        permissionReason: reason,
        observing: false
      })
      this.publish()
      return this.agentStatus
    }
    this.publish()
    void this.runComputerAgent(this.agentGoal)
      .then((result) => {
        const kind = result.actionOutcome === 'success_verified' ? 'success' : 'status'
        this.messages.push(this.message('assistant', result.summary, kind))
        this.publish()
      })
      .catch(() => {
        this.setAgentStatus({
          taskId: this.agentSession.activeId() ?? 'agent-failed',
          goal: this.agentGoal ?? 'this request',
          state: 'failed',
          current: "I couldn't finish that.",
          completed: this.agentStatus?.verified ? this.agentStatus.completed : null,
          step: this.agentStatus?.step ?? 0,
          verified: this.agentStatus?.verified ?? false,
          approval: null,
          permissionReason: null,
          observing: false
        })
        this.publish()
      })
    return this.agentStatus
  }

  pauseAgent(taskId: string): AgentStatus | null {
    this.agentSession.pause(taskId)
    if (this.agentStatus?.taskId === taskId) {
      this.setAgentStatus({
        ...this.agentStatus,
        state: 'paused',
        current: 'Paused. Nothing else will happen until you resume.'
      })
    }
    return this.agentStatus
  }

  resumeAgent(taskId: string): AgentStatus | null {
    this.agentSession.resume(taskId)
    if (this.agentStatus?.taskId === taskId) {
      this.setAgentStatus({
        ...this.agentStatus,
        state: 'observing',
        current: 'Resuming.'
      })
    }
    return this.agentStatus
  }

  stopAgent(taskId: string): AgentStatus | null {
    this.agentGate.decline(taskId)
    if (this.agentSession.activeId() === taskId) {
      this.agentSession.stop(taskId)
    }
    if (this.agentStatus?.taskId === taskId) {
      this.setAgentStatus({
        ...this.agentStatus,
        state: 'cancelled',
        current: 'I stopped. Nothing else will run for that request.',
        approval: null,
        permissionReason: null,
        observing: false
      })
    }
    return this.agentStatus
  }

  async confirmAgent(taskId: string, approvalId: string): Promise<AgentStatus | null> {
    const held = this.agentGate.current()
    if (!held || held.taskId !== taskId || held.approvalId !== approvalId) {
      return this.agentStatus
    }
    const liveTarget = await readLiveTarget(held, {
      desktop: this.desktopPort,
      browser: this.browserPort
    })
    this.agentGate.confirm(taskId, approvalId, liveTarget)
    return this.agentStatus
  }

  async guideAgent(taskId: string): Promise<SessionSnapshot> {
    const goal = this.agentGoal
    this.agentGate.decline(taskId)
    if (this.agentSession.activeId() === taskId) {
      this.agentSession.stop(taskId)
    }
    this.agentGoal = null
    this.setAgentStatus(null)
    if (!goal) {
      return this.snapshot()
    }
    const outcome = await this.orchestrator.submit(goal, { mode: 'guide' })
    this.remember(outcome)
    this.publish()
    return this.snapshot()
  }

  private screenShared(): boolean {
    const privacy = loadPreferences(this.db).privacy
    return (
      cloudAgentConsent(privacy) &&
      privacy.cloudScreenAnalysisEnabled &&
      !this.screenShareStopped &&
      this.screenHelp.status().access === 'on'
    )
  }

  private async observeForAgent(
    signal: AbortSignal
  ): Promise<ReturnType<typeof observationForAgent>> {
    const sharing = this.screenShared()
    if (!this.desktopPort) {
      return null
    }
    const seen = await this.desktopPort.observe({ includeImage: sharing }, { signal })
    const front = seen.observation?.app.name ?? ''
    // Read the page only when Agent Browser is actually in front, or when the desktop
    // could not be read at all. The old allowlist of eight app names meant any other
    // app — Chrome, Slack, Excel — was treated as "not a desktop app" and the loop
    // observed the browser instead of the window the person was looking at.
    const readBrowser = isAgentBrowserApp(front) || !seen.observation
    if (this.browserPort?.isOpen() && readBrowser) {
      const page = await this.browserPort.observe(
        { includeImage: sharing, consent: sharing },
        { signal }
      )
      if (page.observation && /^https?:/i.test(page.observation.url)) {
        return browserObservationForAgent(page.observation, sharing)
      }
    }
    if (!seen.observation) {
      return prepareModelObservation(
        {
          snapshotId: 'screen-unread',
          appName: 'Desktop',
          capturedAtUtc: new Date().toISOString(),
          untrustedText: seen.summary
        },
        false
      )
    }
    return observationForAgent(seen.observation, sharing)
  }

  start(): void {
    void this.bridge
      .request('system.ping', {}, { timeoutMs: 3_000 })
      .then(async () => {
        this.helperRunning = true
        await this.refreshHelperPermissions()
        this.publish()
      })
      .catch(() => {
        this.helperRunning = false
      })
    this.applyLoginItem()
    this.registerShortcut()
    this.createTray()
    const missed = this.scheduler.start()
    this.showMascot()
    this.openPanel(missed.length > 0 ? 'home' : 'chat')
    screen.on('display-removed', () => this.placeMascot())
    screen.on('display-metrics-changed', () => this.placeMascot())
    powerMonitor.on('resume', () => this.recoverReminders())
    powerMonitor.on('unlock-screen', () => this.recoverReminders())
  }

  snapshot(): SessionSnapshot {
    return {
      preferences: loadPreferences(this.db),
      favorites: listFavorites(this.db),
      reminders: listReminders(this.db),
      dueReminders: this.dueReminders,
      messages: this.messages,
      activeTask: this.activeTask,
      pendingApproval: this.pendingApproval,
      shortcutWarning: this.shortcutWarning,
      notice: this.notice,
      panelView: this.panelView,
      screen: {
        access: this.screenHelp.status().access,
        captureActive: this.screenHelp.status().captureActive,
        helper: this.helperRunning ? 'running' : 'unavailable'
      },
      inspectionView: this.screenHelp.inspectionView(),
      guide: this.screenHelp.currentGuide()
    }
  }

  capabilities(): ReturnType<typeof readCapabilities> {
    return readCapabilities(this.helperRunning, {
      helperAccessibilityTrusted: this.helperAccessibilityTrusted,
      helperScreenCaptureAllowed: this.helperScreenCaptureAllowed
    })
  }

  async stop(): Promise<void> {
    const agentId = this.agentSession.activeId()
    if (agentId) {
      this.stopAgent(agentId)
    }
    const task = this.activeTask
    if (
      task &&
      task.state !== 'completed' &&
      task.state !== 'failed' &&
      task.state !== 'cancelled'
    ) {
      this.remember(this.orchestrator.cancel(task.id))
    }
    if (this.guideTimer) {
      clearInterval(this.guideTimer)
      this.guideTimer = null
    }
    this.closeOverlay()
    this.screenHelp.revoke()
    this.screenHelp.close()
    await this.browserPort.close()
  }

  openPanel(view: PanelView = 'home'): void {
    this.panelView = view
    this.ensurePanel()
    this.publish()
  }

  closePanel(): void {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.hide()
    }
  }

  setMascotInteractive(interactive: boolean): void {
    const mascot = this.mascotWindow
    if (!mascot || mascot.isDestroyed()) {
      return
    }
    mascot.setIgnoreMouseEvents(!interactive, { forward: true })
    mascot.setFocusable(interactive)
  }

  nudgeMascot(dx: number, dy: number): void {
    const mascot = this.mascotWindow
    if (!mascot || mascot.isDestroyed()) {
      return
    }
    const bounds = mascot.getBounds()
    const area = this.areaForBounds(bounds)
    const size = { width: bounds.width, height: bounds.height }
    const next = clampScreenPoint(area, bounds.x + dx, bounds.y + dy, size)
    mascot.setPosition(next.x, next.y)
    const unit = screenToUnit(area, next.x, next.y, size)
    const preferences = loadPreferences(this.db)
    savePreferences(this.db, {
      ...preferences,
      mascot: {
        ...preferences.mascot,
        monitorId: area.id,
        normalizedX: unit.normalizedX,
        normalizedY: unit.normalizedY
      }
    })
  }

  setMascotCollapsed(collapsed: boolean): void {
    const preferences = loadPreferences(this.db)
    savePreferences(this.db, {
      ...preferences,
      mascot: { ...preferences.mascot, collapsed }
    })
    this.placeMascot()
    this.publish()
  }

  updateAppearance(patch: {
    textScale?: SessionSnapshot['preferences']['appearance']['textScale']
    contentScale?: number
    theme?: SessionSnapshot['preferences']['appearance']['theme']
    accentColorId?: SessionSnapshot['preferences']['appearance']['accentColorId']
    mascotColorId?: SessionSnapshot['preferences']['appearance']['mascotColorId']
    mascotSize?: SessionSnapshot['preferences']['appearance']['mascotSize']
    reduceMotion?: boolean
    extraLineSpacing?: boolean
  }): SessionSnapshot {
    const current = loadPreferences(this.db)
    const next = {
      ...current,
      appearance: {
        ...current.appearance,
        ...(patch.textScale ? { textScale: patch.textScale } : {}),
        ...(patch.contentScale !== undefined ? { contentScale: patch.contentScale } : {}),
        ...(patch.theme ? { theme: patch.theme } : {}),
        ...(patch.accentColorId ? { accentColorId: patch.accentColorId } : {}),
        ...(patch.mascotColorId ? { mascotColorId: patch.mascotColorId } : {}),
        ...(patch.mascotSize ? { mascotSize: patch.mascotSize } : {}),
        ...(patch.reduceMotion !== undefined ? { reduceMotion: patch.reduceMotion } : {})
      },
      accessibility: {
        ...current.accessibility,
        ...(patch.extraLineSpacing !== undefined
          ? { extraLineSpacing: patch.extraLineSpacing }
          : {})
      }
    }
    savePreferences(this.db, next)
    this.placeMascot()
    this.publish()
    return this.snapshot()
  }

  resetAppearanceSettings(): SessionSnapshot {
    savePreferences(this.db, resetAppearance(loadPreferences(this.db)))
    this.placeMascot()
    this.publish()
    return this.snapshot()
  }

  enlargeText(): SessionSnapshot {
    const current = loadPreferences(this.db)
    return this.updateAppearance({ textScale: nextTextScale(current.appearance.textScale) })
  }

  setLaunchAtLogin(enabled: boolean): SessionSnapshot {
    const current = loadPreferences(this.db)
    savePreferences(this.db, {
      ...current,
      startup: { ...current.startup, launchAtLogin: enabled }
    })
    this.applyLoginItem()
    this.publish()
    return this.snapshot()
  }

  saveFavorite(input: {
    id?: string
    kind: 'application' | 'website'
    title: string
    target: string
    confirmDomainChange?: boolean
  }): FavoriteSaveResult {
    const result = saveFavorite(this.db, input)
    if (result.status === 'saved') {
      this.publish()
    }
    return result
  }

  deleteFavorite(id: string): SessionSnapshot {
    deleteFavorite(this.db, id)
    this.publish()
    return this.snapshot()
  }

  moveFavorite(id: string, direction: 'up' | 'down'): SessionSnapshot {
    reorderFavorite(this.db, id, direction)
    this.publish()
    return this.snapshot()
  }

  async launchFavorite(id: string): Promise<ActionResult> {
    const blocked = this.agentWorkBlocked()
    if (blocked) {
      return blocked
    }
    const favorite = listFavorites(this.db).find((item) => item.id === id)
    if (!favorite) {
      return { status: 'failed', summary: "I couldn't find that favorite." }
    }
    const result =
      favorite.kind === 'website'
        ? await launchWebsite(favorite.target, this.run)
        : await launchBundle(favorite.target, this.run)
    if (result.status === 'succeeded') {
      markFavoriteLaunched(this.db, id, new Date().toISOString())
      this.publish()
    }
    return result
  }

  async launchKnownBundle(bundleId: string): Promise<ActionResult> {
    const blocked = this.agentWorkBlocked()
    if (blocked) {
      return blocked
    }
    if (!isBundleId(bundleId)) {
      return { status: 'failed', summary: "I couldn't find that app on this computer." }
    }
    return launchBundle(bundleId, this.run)
  }

  openSystemSettings(section: SystemSettingsSection): Promise<ActionResult> {
    return launchSystemSettings(section, this.run)
  }

  async submitChat(
    text: string,
    mode: 'execute' | 'guide' | 'explain' = 'execute'
  ): Promise<SessionSnapshot> {
    if (this.agentStatus && agentBusy(this.agentStatus)) {
      this.flash('A task is already running. Press Stop before starting another.')
      return this.snapshot()
    }
    this.dropPendingApproval()
    const trimmed = text.trim()
    if (trimmed) {
      this.messages.push(this.message('user', trimmed, 'text'))
    }
    const guideAction = this.screenHelp.currentGuide() ? guideUtterance(trimmed) : null
    if (guideAction) {
      const result = await this.screenHelp.guideAction(guideAction)
      this.remember({
        task: null,
        responseState:
          result.status === 'cancelled'
            ? 'cancelled'
            : result.status === 'succeeded'
              ? 'success'
              : 'failure',
        summary: result.summary
      })
      this.publish()
      return this.snapshot()
    }
    const outcome = await this.orchestrator.submit(text, { mode })
    if (outcome.responseState === 'needs_permission') {
      this.pendingScreenText = trimmed || null
    }
    this.remember(outcome)
    this.publish()
    return this.snapshot()
  }

  async confirmChat(taskId: string, approvalId: string): Promise<SessionSnapshot> {
    const outcome = await this.orchestrator.confirm(taskId, approvalId)
    this.remember(outcome)
    this.publish()
    return this.snapshot()
  }

  cancelChat(taskId: string): SessionSnapshot {
    this.pendingScreenText = null
    this.screenHelp.endCapture()
    this.screenHelp.clearGuide()
    const outcome = this.orchestrator.cancel(taskId)
    this.remember(outcome)
    this.publish()
    return this.snapshot()
  }

  recoverChat(actionKey: string): Promise<SessionSnapshot> {
    if (actionKey === 'capture_screen') {
      return this.captureScreen()
    }
    const outcome = this.orchestrator.recover(actionKey)
    this.remember(outcome)
    this.publish()
    return Promise.resolve(this.snapshot())
  }

  async guideAction(
    action: 'did_it' | 'repeat' | 'cant_find' | 'manual' | 'stop' | 'press'
  ): Promise<SessionSnapshot> {
    if (action === 'press') {
      return this.pressHighlighted()
    }
    const result = await this.screenHelp.guideAction(action)
    this.remember({
      task: null,
      responseState:
        result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'succeeded'
            ? 'success'
            : 'failure',
      summary: result.summary
    })
    this.publish()
    return this.snapshot()
  }

  private async pressHighlighted(): Promise<SessionSnapshot> {
    const guide = this.screenHelp.currentGuide()
    if (!guide?.targetName || guide.status !== 'showing') {
      this.flash('Nothing to press.')
      return this.snapshot()
    }
    const outcome = await this.orchestrator.pressHighlighted(guide.targetName, guide.targetRole)
    this.remember(outcome)
    this.flash(
      outcome.responseState === 'success' ? `Pressed ${guide.targetName}.` : outcome.summary
    )
    this.publish()
    return this.snapshot()
  }

  private flash(text: string): void {
    this.notice = text
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer)
    }
    this.noticeTimer = setTimeout(() => {
      this.notice = null
      this.noticeTimer = null
      this.publish()
    }, 2600)
    this.publish()
  }

  private async refreshHelperPermissions(): Promise<void> {
    try {
      const raw = await this.bridge.request('system.permissionStatus', {}, { timeoutMs: 3_000 })
      const parsed = readHelperPermissionStatus(raw)
      if (!parsed) {
        return
      }
      this.helperAccessibilityTrusted = parsed.accessibilityTrusted
      this.helperScreenCaptureAllowed = parsed.screenCaptureAllowed
    } catch {
      this.helperAccessibilityTrusted = null
      this.helperScreenCaptureAllowed = null
    }
  }

  private async promptMissingHelperPermissions(userRequestedScreen: boolean): Promise<void> {
    const plan = planHelperPrompts({
      accessibilityTrusted: this.helperAccessibilityTrusted,
      screenCaptureAllowed: this.helperScreenCaptureAllowed,
      askedAccessibility: this.helperPrompts.accessibility,
      askedScreenCapture: this.helperPrompts.screenCapture,
      userRequestedScreen
    })
    if (plan.promptAccessibility) {
      this.helperPrompts.accessibility = true
      await this.screenHelp.promptAccessibility()
    }
    if (plan.promptScreenCapture) {
      this.helperPrompts.screenCapture = true
      try {
        await this.bridge.request('system.promptScreenCapture', {}, { timeoutMs: 3_000 })
      } catch {
        // macOS shows the dialog. A timeout still leaves the switch for the user.
      }
    }
  }

  async setScreenAccess(enabled: boolean): Promise<SessionSnapshot> {
    if (!enabled) {
      return this.stopSharing()
    }
    this.screenShareStopped = false
    this.screenHelp.grant()
    await this.refreshHelperPermissions()
    await this.promptMissingHelperPermissions(true)
    const pending = this.pendingScreenText
    this.pendingScreenText = null
    if (pending) {
      const outcome = await this.orchestrator.submit(pending)
      this.remember(outcome)
    }
    this.publish()
    return this.snapshot()
  }

  stopSharing(): SessionSnapshot {
    this.screenShareStopped = true
    const agentId = this.agentSession.activeId()
    if (agentId) {
      this.agentSession.stop(agentId)
    }
    this.screenHelp.revoke()
    this.pendingScreenText = null
    const running =
      this.activeTask &&
      this.activeTask.state !== 'completed' &&
      this.activeTask.state !== 'failed' &&
      this.activeTask.state !== 'cancelled'
    if (running && this.activeTask) {
      const outcome = this.orchestrator.cancel(this.activeTask.id)
      this.remember(outcome)
    }
    this.publish()
    return this.snapshot()
  }

  async requestSystemPermissions(options: {
    openSettings?: boolean
    resumeScreen?: boolean
  }): Promise<SessionSnapshot> {
    const result = await promptSystemMedia()
    if (options.resumeScreen) {
      this.screenShareStopped = false
    }
    if (result.screen === 'granted' && !this.screenShareStopped) {
      this.screenHelp.grant()
    }
    await this.refreshHelperPermissions()
    await this.promptMissingHelperPermissions(options.resumeScreen === true)
    await this.refreshHelperPermissions()
    if (
      options.openSettings &&
      process.platform === 'darwin' &&
      (result.microphone !== 'granted' || result.screen !== 'granted')
    ) {
      try {
        await shell.openExternal(privacySettingsUrl)
      } catch {
        // The sidebar can ask again. System Settings is still available from macOS.
      }
    }
    this.publish()
    return this.snapshot()
  }

  setDeveloperInspection(enabled: boolean): SessionSnapshot {
    const current = loadPreferences(this.db)
    savePreferences(this.db, {
      ...current,
      privacy: { ...current.privacy, developerInspection: enabled }
    })
    this.screenHelp.setDeveloperInspection(enabled)
    this.publish()
    return this.snapshot()
  }

  setDiagnosticTelemetry(enabled: boolean): SessionSnapshot {
    const current = loadPreferences(this.db)
    savePreferences(this.db, {
      ...current,
      privacy: { ...current.privacy, allowDiagnosticTelemetry: enabled }
    })
    this.publish()
    return this.snapshot()
  }

  dismissOnboarding(): SessionSnapshot {
    const current = loadPreferences(this.db)
    savePreferences(this.db, {
      ...current,
      onboarding: { seenLimits: true }
    })
    this.publish()
    return this.snapshot()
  }

  recordCrash(error: { name?: string; message?: string }): void {
    try {
      const consent = loadPreferences(this.db).privacy.allowDiagnosticTelemetry
      writeCrashNote(join(app.getPath('userData'), 'diagnostics'), consent, {
        name: error.name ?? 'Error',
        message: error.message ?? '',
        atUtc: new Date().toISOString()
      })
    } catch {
      // A crash note must not throw a second time.
    }
  }

  setVoice(enabled: boolean, readRepliesAloud: boolean): SessionSnapshot {
    const current = loadPreferences(this.db)
    savePreferences(this.db, {
      ...current,
      voice: { ...current.voice, enabled, readRepliesAloud }
    })
    this.publish()
    return this.snapshot()
  }

  setAssistantMode(input: {
    mode: 'demo' | 'cloud'
    origin?: string
    consent?: boolean
  }): SessionSnapshot {
    const current = loadPreferences(this.db)
    if (input.mode === 'demo') {
      savePreferences(this.db, {
        ...current,
        privacy: { ...current.privacy, assistantMode: 'demo' }
      })
      this.publish()
      return this.snapshot()
    }
    const origin = input.origin ? assistantOrigin(input.origin) : null
    if (!input.consent || !origin) {
      this.publish()
      return this.snapshot()
    }
    savePreferences(this.db, {
      ...current,
      privacy: {
        ...current.privacy,
        assistantMode: 'cloud',
        assistantOrigin: origin,
        cloudConsentAtUtc: new Date().toISOString()
      }
    })
    this.publish()
    return this.snapshot()
  }

  private async captureScreen(): Promise<SessionSnapshot> {
    const outcome = await this.screenHelp.captureOnce(this.screenHelp.status().access === 'on')
    this.remember({
      task: null,
      responseState:
        outcome.status === 'succeeded'
          ? 'success'
          : outcome.status === 'cancelled'
            ? 'cancelled'
            : 'failure',
      summary: outcome.summary
    })
    this.publish()
    return this.snapshot()
  }

  createReminder(input: {
    title: string
    year: number
    month: number
    day: number
    hour: number
    minute: number
    timeZone: string
  }): ReminderCommandResult {
    const result = createFromLocalParts(this.scheduler, { ...input, source: 'user' })
    this.publish()
    return result
  }

  cancelReminder(id: string): SessionSnapshot {
    this.scheduler.cancel(id)
    this.dueReminders = this.dueReminders.filter((item) => item.reminderId !== id)
    this.publish()
    return this.snapshot()
  }

  snoozeReminder(id: string): SessionSnapshot {
    this.scheduler.snooze(id, 10)
    this.dueReminders = this.dueReminders.filter((item) => item.reminderId !== id)
    this.publish()
    return this.snapshot()
  }

  completeReminder(id: string): SessionSnapshot {
    this.scheduler.complete(id)
    this.dueReminders = this.dueReminders.filter((item) => item.reminderId !== id)
    this.publish()
    return this.snapshot()
  }

  setReminderNotifications(enabled: boolean): SessionSnapshot {
    const current = loadPreferences(this.db)
    savePreferences(this.db, {
      ...current,
      startup: { ...current.startup, showNotifications: enabled }
    })
    this.publish()
    return this.snapshot()
  }

  showMascot(): void {
    if (this.mascotWindow && !this.mascotWindow.isDestroyed()) {
      this.mascotWindow.showInactive()
      return
    }

    const preferences = loadPreferences(this.db)
    const size = mascotWindowSize(preferences.mascot.collapsed, preferences.appearance.mascotSize)
    this.mascotWindow = new BrowserWindow({
      ...size,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Companion',
      backgroundColor: '#00000000',
      webPreferences: secureWebPreferences({
        preloadPath: join(__dirname, '../preload/index.js'),
        devTools: devToolsAllowed()
      })
    })
    this.mascotWindow.setAlwaysOnTop(true, 'floating')
    this.mascotWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.mascotWindow.setIgnoreMouseEvents(true, { forward: true })
    this.mascotWindow.on('closed', () => {
      this.mascotWindow = null
    })
    this.mascotWindow.on('ready-to-show', () => {
      this.placeMascot()
      this.mascotWindow?.showInactive()
    })
    loadRenderer(this.mascotWindow, 'mascot.html')
  }

  private ensurePanel(): void {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      if (!this.panelWindow.isVisible()) {
        this.panelWindow.show()
      }
      this.panelWindow.focus()
      return
    }

    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(panelChrome.width, area.width)
    const height = Math.min(panelChrome.height, area.height)
    this.panelWindow = new BrowserWindow({
      width,
      height,
      minWidth: Math.min(panelChrome.minWidth, width),
      minHeight: Math.min(panelChrome.minHeight, height),
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      show: false,
      title: 'Companion',
      autoHideMenuBar: true,
      backgroundColor: '#f3f3f1',
      webPreferences: secureWebPreferences({
        preloadPath: join(__dirname, '../preload/index.js'),
        devTools: devToolsAllowed()
      })
    })
    this.panelWindow.on('ready-to-show', () => {
      this.panelWindow?.show()
      this.panelWindow?.focus()
      void this.requestSystemPermissions({})
    })
    this.panelWindow.on('closed', () => {
      this.panelWindow = null
    })
    loadRenderer(this.panelWindow, 'panel.html')
  }

  private recoverReminders(): void {
    const notices = this.scheduler.start()
    if (notices.length > 0) {
      this.openPanel('home')
    }
  }

  private placeMascot(): void {
    const mascot = this.mascotWindow
    if (!mascot || mascot.isDestroyed()) {
      return
    }
    const preferences = loadPreferences(this.db)
    const size = mascotWindowSize(preferences.mascot.collapsed, preferences.appearance.mascotSize)
    const areas = this.workAreas()
    const area = resolveWorkArea(areas, preferences.mascot.monitorId, this.primaryId())
    const point = unitToScreen(
      area,
      preferences.mascot.normalizedX,
      preferences.mascot.normalizedY,
      size
    )
    mascot.setBounds({ ...point, ...size })
    if (preferences.mascot.monitorId !== area.id) {
      savePreferences(this.db, {
        ...preferences,
        mascot: { ...preferences.mascot, monitorId: area.id }
      })
    }
  }

  private areaForBounds(bounds: { x: number; y: number; width: number; height: number }): WorkArea {
    const display = screen.getDisplayMatching(bounds)
    return {
      id: String(display.id),
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
  }

  private workAreas(): WorkArea[] {
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }))
  }

  private primaryId(): string {
    return String(screen.getPrimaryDisplay().id)
  }

  private rememberReminder(notice: ReminderNotice): void {
    this.dueReminders.push({
      reminderId: notice.reminder.id,
      kind: notice.kind,
      summary: notice.summary
    })
    const copy = reminderNotificationCopy(
      notice.kind,
      notice.reminder.title,
      loadPreferences(this.db).startup.showNotifications
    )
    if (copy && Notification.isSupported()) {
      try {
        new Notification(copy).show()
      } catch {
        // The in-app reminder still shows when the system notification cannot.
      }
    }
    this.publish()
  }

  private dropPendingApproval(): void {
    if (!this.pendingApproval) {
      return
    }
    this.orchestrator.cancel(this.pendingApproval.taskId)
    this.pendingApproval = null
  }

  private remember(outcome: TaskOutcome): void {
    this.messages.push(
      this.message(
        'assistant',
        outcome.summary,
        outcome.responseState === 'success'
          ? 'success'
          : outcome.responseState === 'failure'
            ? 'error'
            : 'status',
        outcome.recovery
      )
    )
    if (this.messages.length > 40) {
      this.messages = this.messages.slice(-40)
    }
    this.pendingApproval = outcome.approval ?? null
    this.activeTask = outcome.task
      ? {
          id: outcome.task.id,
          state: outcome.task.state,
          summary: outcome.task.safeSummary ?? null
        }
      : null
  }

  private message(
    role: ChatMessage['role'],
    text: string,
    kind: ChatMessage['kind'],
    recovery?: ChatMessage['recovery']
  ): ChatMessage {
    return {
      id: randomUUID(),
      role,
      text,
      kind,
      createdAtUtc: new Date().toISOString(),
      recovery
    }
  }

  private agentWorkBlocked(): ActionResult | null {
    if (!this.agentStatus || !agentBusy(this.agentStatus)) {
      return null
    }
    const summary = 'A task is already running. Press Stop before starting another.'
    this.flash(summary)
    return { status: 'failed', summary }
  }

  private setAgentStatus(status: AgentStatus | null): void {
    if (status === null) {
      this.agentStatus = null
    } else {
      const parsed = agentStatusSchema.safeParse(status)
      if (!parsed.success) {
        return
      }
      this.agentStatus = parsed.data
    }
    this.renderTrayMenu()
    for (const window of [this.mascotWindow, this.panelWindow, this.overlayWindow]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('companion:agent-status', this.agentStatus)
      }
    }
  }

  private publish(): void {
    this.syncOverlay()
    this.watchGuide()
    for (const window of [this.mascotWindow, this.panelWindow, this.overlayWindow]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('companion:session-changed')
      }
    }
  }

  private watchGuide(): void {
    const guide = this.screenHelp.currentGuide()
    if (!guide || guide.status !== 'showing') {
      if (this.guideTimer) {
        clearInterval(this.guideTimer)
        this.guideTimer = null
      }
      return
    }
    if (this.guideTimer) {
      return
    }
    this.guideTimer = setInterval(() => {
      void this.screenHelp.guideAction('refresh').then(() => this.publish())
    }, 700)
  }

  private syncOverlay(): void {
    const highlight = this.screenHelp.currentGuide()?.highlight ?? null
    if (!highlight || this.screenHelp.status().access !== 'on') {
      this.closeOverlay()
      return
    }
    const display = screen.getAllDisplays().find((item) => String(item.id) === highlight.displayId)
    if (!display) {
      this.closeOverlay()
      return
    }
    const options = guidanceOverlayWindowOptions({
      id: String(display.id),
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor
    })
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      this.overlayWindow = new BrowserWindow({
        x: options.x,
        y: options.y,
        width: options.width,
        height: options.height,
        transparent: options.transparent,
        frame: options.frame,
        focusable: options.focusable,
        alwaysOnTop: options.alwaysOnTop,
        hasShadow: options.hasShadow,
        skipTaskbar: options.skipTaskbar,
        roundedCorners: options.roundedCorners,
        backgroundColor: options.backgroundColor,
        show: options.show,
        type: options.type,
        title: 'Companion highlight',
        webPreferences: secureWebPreferences({
          preloadPath: join(__dirname, '../preload/index.js'),
          devTools: devToolsAllowed()
        })
      })
      applyGuidanceOverlayBehavior(this.overlayWindow)
      this.overlayWindow.on('closed', () => {
        this.overlayWindow = null
      })
      loadRenderer(this.overlayWindow, 'overlay.html')
    } else {
      this.overlayWindow.setBounds({
        x: options.x,
        y: options.y,
        width: options.width,
        height: options.height
      })
    }
    this.overlayWindow.showInactive()
  }

  private closeOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close()
    }
    this.overlayWindow = null
  }

  private applyLoginItem(): void {
    const enabled = loadPreferences(this.db).startup.launchAtLogin
    if (!enabled && !this.loginItemTouched) {
      return
    }
    this.loginItemTouched = true
    app.setLoginItemSettings({ openAtLogin: enabled })
  }

  private registerShortcut(): void {
    const accelerator = 'Control+Alt+Space'
    const registered = globalShortcut.register(accelerator, () => {
      if (this.panelWindow && this.panelWindow.isVisible() && this.panelView === 'chat') {
        this.closePanel()
        return
      }
      this.openPanel('chat')
    })
    if (!registered) {
      this.shortcutWarning = `${accelerator} is already used by another app. You can still open Chat from the mascot.`
    }
  }

  private createTray(): void {
    const icon = nativeImage
      .createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAo4gEhgAAAABJRU5ErkJggg=='
      )
      .resize({ width: 16, height: 16 })
    icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Companion')
    this.renderTrayMenu()
  }

  private renderTrayMenu(): void {
    if (!this.tray) {
      return
    }
    const taskId = this.agentStatus && agentBusy(this.agentStatus) ? this.agentStatus.taskId : null
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Restore',
          click: () => {
            this.setMascotCollapsed(false)
            this.showMascot()
          }
        },
        {
          label: 'Stop',
          enabled: taskId !== null,
          click: () => {
            if (taskId) {
              this.stopAgent(taskId)
            }
          }
        },
        {
          label: 'Quit',
          click: () => {
            app.quit()
          }
        }
      ])
    )
  }
}
