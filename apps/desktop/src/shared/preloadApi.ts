import type { CompanionCapabilities } from './capabilities'
import { companionIpcChannels } from './channels'
import type { FavoriteSaveResult } from './favorites'
import type { ReminderCommandResult } from './reminders'
import type { ActionResult, PanelView, SessionSnapshot } from './session'
import type { SystemSettingsSection } from './systemSettings'

type Invoker = (channel: string, payload?: unknown) => Promise<unknown>

export interface AppearancePatch {
  textScale?: SessionSnapshot['preferences']['appearance']['textScale']
  contentScale?: number
  theme?: SessionSnapshot['preferences']['appearance']['theme']
  accentColorId?: SessionSnapshot['preferences']['appearance']['accentColorId']
  mascotColorId?: SessionSnapshot['preferences']['appearance']['mascotColorId']
  mascotSize?: SessionSnapshot['preferences']['appearance']['mascotSize']
  reduceMotion?: boolean
  extraLineSpacing?: boolean
}

export function createCompanionApi(invoke: Invoker): {
  getCapabilities: () => Promise<CompanionCapabilities>
  getSession: () => Promise<SessionSnapshot>
  openPanel: (view?: PanelView) => Promise<void>
  closePanel: () => Promise<void>
  setMascotInteractive: (interactive: boolean) => Promise<void>
  nudgeMascot: (dx: number, dy: number) => Promise<void>
  setMascotCollapsed: (collapsed: boolean) => Promise<void>
  updateAppearance: (patch: AppearancePatch) => Promise<SessionSnapshot>
  resetAppearance: () => Promise<SessionSnapshot>
  setLaunchAtLogin: (enabled: boolean) => Promise<SessionSnapshot>
  enlargeText: () => Promise<SessionSnapshot>
  saveFavorite: (input: {
    id?: string
    kind: 'application' | 'website'
    title: string
    target: string
    confirmDomainChange?: boolean
  }) => Promise<FavoriteSaveResult>
  deleteFavorite: (id: string) => Promise<SessionSnapshot>
  moveFavorite: (id: string, direction: 'up' | 'down') => Promise<SessionSnapshot>
  launchFavorite: (id: string) => Promise<ActionResult>
  launchBundle: (bundleId: string) => Promise<ActionResult>
  openSystemSettings: (section: SystemSettingsSection) => Promise<ActionResult>
  submitChat: (input: {
    text: string
    mode?: 'execute' | 'guide' | 'explain'
  }) => Promise<SessionSnapshot>
  confirmChat: (taskId: string, approvalId: string) => Promise<SessionSnapshot>
  cancelChat: (taskId: string) => Promise<SessionSnapshot>
  recoverChat: (actionKey: string) => Promise<SessionSnapshot>
  createReminder: (input: {
    title: string
    year: number
    month: number
    day: number
    hour: number
    minute: number
    timeZone: string
  }) => Promise<ReminderCommandResult>
  cancelReminder: (id: string) => Promise<SessionSnapshot>
  snoozeReminder: (id: string) => Promise<SessionSnapshot>
  completeReminder: (id: string) => Promise<SessionSnapshot>
  setReminderNotifications: (enabled: boolean) => Promise<SessionSnapshot>
  setScreenAccess: (enabled: boolean) => Promise<SessionSnapshot>
  requestSystemPermissions: (input?: {
    openSettings?: boolean
    resumeScreen?: boolean
  }) => Promise<SessionSnapshot>
  stopSharing: () => Promise<SessionSnapshot>
  setDeveloperInspection: (enabled: boolean) => Promise<SessionSnapshot>
  setVoice: (input: { enabled: boolean; readRepliesAloud: boolean }) => Promise<SessionSnapshot>
  setAssistantMode: (input: {
    mode: 'demo' | 'cloud'
    origin?: string
    consent?: boolean
  }) => Promise<SessionSnapshot>
  guideAction: (
    action: 'did_it' | 'repeat' | 'cant_find' | 'manual' | 'stop' | 'press'
  ) => Promise<SessionSnapshot>
} {
  return {
    getCapabilities: () =>
      invoke(companionIpcChannels.getCapabilities, {}) as Promise<CompanionCapabilities>,
    getSession: () => invoke(companionIpcChannels.getSession, {}) as Promise<SessionSnapshot>,
    openPanel: (view) =>
      invoke(companionIpcChannels.openPanel, view ? { view } : {}) as Promise<void>,
    closePanel: () => invoke(companionIpcChannels.closePanel, {}) as Promise<void>,
    setMascotInteractive: (interactive) =>
      invoke(companionIpcChannels.setMascotInteractive, { interactive }) as Promise<void>,
    nudgeMascot: (dx, dy) => invoke(companionIpcChannels.nudgeMascot, { dx, dy }) as Promise<void>,
    setMascotCollapsed: (collapsed) =>
      invoke(companionIpcChannels.setMascotCollapsed, { collapsed }) as Promise<void>,
    updateAppearance: (patch) =>
      invoke(companionIpcChannels.updateAppearance, patch) as Promise<SessionSnapshot>,
    resetAppearance: () =>
      invoke(companionIpcChannels.resetAppearance, {}) as Promise<SessionSnapshot>,
    setLaunchAtLogin: (enabled) =>
      invoke(companionIpcChannels.setLaunchAtLogin, { enabled }) as Promise<SessionSnapshot>,
    enlargeText: () => invoke(companionIpcChannels.enlargeText, {}) as Promise<SessionSnapshot>,
    saveFavorite: (input) =>
      invoke(companionIpcChannels.saveFavorite, input) as Promise<FavoriteSaveResult>,
    deleteFavorite: (id) =>
      invoke(companionIpcChannels.deleteFavorite, { id }) as Promise<SessionSnapshot>,
    moveFavorite: (id, direction) =>
      invoke(companionIpcChannels.moveFavorite, { id, direction }) as Promise<SessionSnapshot>,
    launchFavorite: (id) =>
      invoke(companionIpcChannels.launchFavorite, { id }) as Promise<ActionResult>,
    launchBundle: (bundleId) =>
      invoke(companionIpcChannels.launchBundle, { bundleId }) as Promise<ActionResult>,
    openSystemSettings: (section) =>
      invoke(companionIpcChannels.openSystemSettings, { section }) as Promise<ActionResult>,
    submitChat: (input) =>
      invoke(companionIpcChannels.submitChat, input) as Promise<SessionSnapshot>,
    confirmChat: (taskId, approvalId) =>
      invoke(companionIpcChannels.confirmChat, { taskId, approvalId }) as Promise<SessionSnapshot>,
    cancelChat: (taskId) =>
      invoke(companionIpcChannels.cancelChat, { taskId }) as Promise<SessionSnapshot>,
    recoverChat: (actionKey) =>
      invoke(companionIpcChannels.recoverChat, { actionKey }) as Promise<SessionSnapshot>,
    createReminder: (input) =>
      invoke(companionIpcChannels.createReminder, input) as Promise<ReminderCommandResult>,
    cancelReminder: (id) =>
      invoke(companionIpcChannels.cancelReminder, { id }) as Promise<SessionSnapshot>,
    snoozeReminder: (id) =>
      invoke(companionIpcChannels.snoozeReminder, { id }) as Promise<SessionSnapshot>,
    completeReminder: (id) =>
      invoke(companionIpcChannels.completeReminder, { id }) as Promise<SessionSnapshot>,
    setReminderNotifications: (enabled) =>
      invoke(companionIpcChannels.setReminderNotifications, {
        enabled
      }) as Promise<SessionSnapshot>,
    setScreenAccess: (enabled) =>
      invoke(companionIpcChannels.setScreenAccess, { enabled }) as Promise<SessionSnapshot>,
    requestSystemPermissions: (input) =>
      invoke(
        companionIpcChannels.requestSystemPermissions,
        input ?? {}
      ) as Promise<SessionSnapshot>,
    stopSharing: () => invoke(companionIpcChannels.stopSharing, {}) as Promise<SessionSnapshot>,
    setDeveloperInspection: (enabled) =>
      invoke(companionIpcChannels.setDeveloperInspection, {
        enabled
      }) as Promise<SessionSnapshot>,
    setVoice: (input) => invoke(companionIpcChannels.setVoice, input) as Promise<SessionSnapshot>,
    setAssistantMode: (input) =>
      invoke(companionIpcChannels.setAssistantMode, input) as Promise<SessionSnapshot>,
    guideAction: (action) =>
      invoke(companionIpcChannels.guideAction, { action }) as Promise<SessionSnapshot>
  }
}
