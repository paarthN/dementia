import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { companionIpcChannels } from '../../shared/channels'
import { parseCompanionIpcArgs } from '../../shared/ipcSchemas'
import { isAllowedAppUrl } from '../../shared/navigation'
import type { PanelView } from '../../shared/session'
import type { SystemSettingsSection } from '../../shared/systemSettings'
import type { Desktop } from '../desktop'
import { appUrlPolicy } from '../security/appUrlPolicy'

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url
  if (!url || !isAllowedAppUrl(url, appUrlPolicy())) {
    throw new Error('Untrusted IPC sender')
  }
}

function parseArgs(channel: string, args: readonly unknown[]): unknown {
  try {
    return parseCompanionIpcArgs(channel, args)
  } catch {
    throw new Error('Invalid IPC arguments')
  }
}

export function registerIpc(desktop: Desktop): void {
  ipcMain.handle(companionIpcChannels.getCapabilities, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    parseArgs(companionIpcChannels.getCapabilities, args)
    return desktop.capabilities()
  })

  ipcMain.handle(companionIpcChannels.getSession, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    parseArgs(companionIpcChannels.getSession, args)
    return desktop.snapshot()
  })

  ipcMain.handle(companionIpcChannels.openPanel, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.openPanel, args) as { view?: PanelView }
    desktop.openPanel(payload.view)
  })

  ipcMain.handle(companionIpcChannels.closePanel, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    parseArgs(companionIpcChannels.closePanel, args)
    desktop.closePanel()
  })

  ipcMain.handle(companionIpcChannels.setMascotInteractive, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setMascotInteractive, args) as {
      interactive: boolean
    }
    desktop.setMascotInteractive(payload.interactive)
  })

  ipcMain.handle(companionIpcChannels.nudgeMascot, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.nudgeMascot, args) as { dx: number; dy: number }
    desktop.nudgeMascot(payload.dx, payload.dy)
  })

  ipcMain.handle(companionIpcChannels.setMascotCollapsed, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setMascotCollapsed, args) as {
      collapsed: boolean
    }
    desktop.setMascotCollapsed(payload.collapsed)
  })

  ipcMain.handle(companionIpcChannels.updateAppearance, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.updateAppearance, args) as Parameters<
      Desktop['updateAppearance']
    >[0]
    return desktop.updateAppearance(payload)
  })

  ipcMain.handle(companionIpcChannels.resetAppearance, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    parseArgs(companionIpcChannels.resetAppearance, args)
    return desktop.resetAppearanceSettings()
  })

  ipcMain.handle(companionIpcChannels.enlargeText, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    parseArgs(companionIpcChannels.enlargeText, args)
    return desktop.enlargeText()
  })

  ipcMain.handle(companionIpcChannels.setLaunchAtLogin, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setLaunchAtLogin, args) as { enabled: boolean }
    return desktop.setLaunchAtLogin(payload.enabled)
  })

  ipcMain.handle(companionIpcChannels.saveFavorite, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.saveFavorite, args) as Parameters<
      Desktop['saveFavorite']
    >[0]
    return desktop.saveFavorite(payload)
  })

  ipcMain.handle(companionIpcChannels.deleteFavorite, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.deleteFavorite, args) as { id: string }
    return desktop.deleteFavorite(payload.id)
  })

  ipcMain.handle(companionIpcChannels.moveFavorite, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.moveFavorite, args) as {
      id: string
      direction: 'up' | 'down'
    }
    return desktop.moveFavorite(payload.id, payload.direction)
  })

  ipcMain.handle(companionIpcChannels.launchFavorite, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.launchFavorite, args) as { id: string }
    return desktop.launchFavorite(payload.id)
  })

  ipcMain.handle(companionIpcChannels.launchBundle, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.launchBundle, args) as { bundleId: string }
    return desktop.launchKnownBundle(payload.bundleId)
  })

  ipcMain.handle(companionIpcChannels.openSystemSettings, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.openSystemSettings, args) as {
      section: SystemSettingsSection
    }
    return desktop.openSystemSettings(payload.section)
  })

  ipcMain.handle(companionIpcChannels.submitChat, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.submitChat, args) as {
      text: string
      mode?: 'execute' | 'guide' | 'explain'
    }
    return desktop.submitChat(payload.text, payload.mode ?? 'execute')
  })

  ipcMain.handle(companionIpcChannels.confirmChat, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.confirmChat, args) as {
      taskId: string
      approvalId: string
    }
    return desktop.confirmChat(payload.taskId, payload.approvalId)
  })

  ipcMain.handle(companionIpcChannels.cancelChat, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.cancelChat, args) as { taskId: string }
    return desktop.cancelChat(payload.taskId)
  })

  ipcMain.handle(companionIpcChannels.recoverChat, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.recoverChat, args) as { actionKey: string }
    return desktop.recoverChat(payload.actionKey)
  })

  ipcMain.handle(companionIpcChannels.createReminder, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.createReminder, args) as Parameters<
      Desktop['createReminder']
    >[0]
    return desktop.createReminder(payload)
  })

  ipcMain.handle(companionIpcChannels.cancelReminder, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.cancelReminder, args) as { id: string }
    return desktop.cancelReminder(payload.id)
  })

  ipcMain.handle(companionIpcChannels.snoozeReminder, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.snoozeReminder, args) as { id: string }
    return desktop.snoozeReminder(payload.id)
  })

  ipcMain.handle(companionIpcChannels.completeReminder, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.completeReminder, args) as { id: string }
    return desktop.completeReminder(payload.id)
  })

  ipcMain.handle(companionIpcChannels.setReminderNotifications, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setReminderNotifications, args) as {
      enabled: boolean
    }
    return desktop.setReminderNotifications(payload.enabled)
  })

  ipcMain.handle(companionIpcChannels.setScreenAccess, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setScreenAccess, args) as { enabled: boolean }
    return desktop.setScreenAccess(payload.enabled)
  })

  ipcMain.handle(
    companionIpcChannels.requestSystemPermissions,
    async (event, ...args: unknown[]) => {
      assertTrustedIpcSender(event)
      const payload = parseArgs(companionIpcChannels.requestSystemPermissions, args) as {
        openSettings?: boolean
        resumeScreen?: boolean
      }
      return desktop.requestSystemPermissions(payload)
    }
  )

  ipcMain.handle(companionIpcChannels.stopSharing, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    parseArgs(companionIpcChannels.stopSharing, args)
    return desktop.stopSharing()
  })

  ipcMain.handle(companionIpcChannels.setDeveloperInspection, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setDeveloperInspection, args) as {
      enabled: boolean
    }
    return desktop.setDeveloperInspection(payload.enabled)
  })

  ipcMain.handle(companionIpcChannels.setVoice, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setVoice, args) as {
      enabled: boolean
      readRepliesAloud: boolean
    }
    return desktop.setVoice(payload.enabled, payload.readRepliesAloud)
  })

  ipcMain.handle(companionIpcChannels.setAssistantMode, (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.setAssistantMode, args) as {
      mode: 'demo' | 'cloud'
      origin?: string
      consent?: boolean
    }
    return desktop.setAssistantMode(payload)
  })

  ipcMain.handle(companionIpcChannels.guideAction, async (event, ...args: unknown[]) => {
    assertTrustedIpcSender(event)
    const payload = parseArgs(companionIpcChannels.guideAction, args) as {
      action: 'did_it' | 'repeat' | 'cant_find' | 'manual' | 'stop' | 'press'
    }
    return desktop.guideAction(payload.action)
  })
}
