import { z } from 'zod'
import { companionIpcChannels, type CompanionIpcChannel } from './channels'
import { mascotColorIds, mascotSizes, textScales, themeModes } from './preferences'
import { panelViews } from './session'
import { systemSettingsSections } from './systemSettings'

const emptyArgsSchema = z.object({}).strict()

const ipcSchemas = {
  [companionIpcChannels.getCapabilities]: emptyArgsSchema,
  [companionIpcChannels.getSession]: emptyArgsSchema,
  [companionIpcChannels.closePanel]: emptyArgsSchema,
  [companionIpcChannels.resetAppearance]: emptyArgsSchema,
  [companionIpcChannels.enlargeText]: emptyArgsSchema,
  [companionIpcChannels.openPanel]: z.object({ view: z.enum(panelViews).optional() }).strict(),
  [companionIpcChannels.setMascotInteractive]: z.object({ interactive: z.boolean() }).strict(),
  [companionIpcChannels.nudgeMascot]: z
    .object({ dx: z.number().finite(), dy: z.number().finite() })
    .strict(),
  [companionIpcChannels.setMascotCollapsed]: z.object({ collapsed: z.boolean() }).strict(),
  [companionIpcChannels.setLaunchAtLogin]: z.object({ enabled: z.boolean() }).strict(),
  [companionIpcChannels.updateAppearance]: z
    .object({
      textScale: z.enum(textScales).optional(),
      contentScale: z.number().min(1).max(1.6).optional(),
      theme: z.enum(themeModes).optional(),
      accentColorId: z.enum(mascotColorIds).optional(),
      mascotColorId: z.enum(mascotColorIds).optional(),
      mascotSize: z.enum(mascotSizes).optional(),
      reduceMotion: z.boolean().optional(),
      extraLineSpacing: z.boolean().optional()
    })
    .strict(),
  [companionIpcChannels.saveFavorite]: z
    .object({
      id: z.string().min(1).optional(),
      kind: z.enum(['application', 'website']),
      title: z.string().max(80),
      target: z.string().max(500),
      confirmDomainChange: z.boolean().optional()
    })
    .strict(),
  [companionIpcChannels.deleteFavorite]: z.object({ id: z.string().min(1) }).strict(),
  [companionIpcChannels.moveFavorite]: z
    .object({ id: z.string().min(1), direction: z.enum(['up', 'down']) })
    .strict(),
  [companionIpcChannels.launchFavorite]: z.object({ id: z.string().min(1) }).strict(),
  [companionIpcChannels.launchBundle]: z.object({ bundleId: z.string().min(1).max(240) }).strict(),
  [companionIpcChannels.openSystemSettings]: z
    .object({ section: z.enum(systemSettingsSections) })
    .strict(),
  [companionIpcChannels.submitChat]: z
    .object({
      text: z.string().max(2000),
      mode: z.enum(['execute', 'guide', 'explain']).optional()
    })
    .strict(),
  [companionIpcChannels.confirmChat]: z
    .object({ taskId: z.string().min(1), approvalId: z.string().min(1) })
    .strict(),
  [companionIpcChannels.cancelChat]: z.object({ taskId: z.string().min(1) }).strict(),
  [companionIpcChannels.recoverChat]: z.object({ actionKey: z.string().min(1).max(80) }).strict(),
  [companionIpcChannels.createReminder]: z
    .object({
      title: z.string().max(200),
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      timeZone: z.string().min(1).max(80)
    })
    .strict(),
  [companionIpcChannels.cancelReminder]: z.object({ id: z.string().min(1) }).strict(),
  [companionIpcChannels.snoozeReminder]: z.object({ id: z.string().min(1) }).strict(),
  [companionIpcChannels.completeReminder]: z.object({ id: z.string().min(1) }).strict(),
  [companionIpcChannels.setReminderNotifications]: z.object({ enabled: z.boolean() }).strict(),
  [companionIpcChannels.setScreenAccess]: z.object({ enabled: z.boolean() }).strict(),
  [companionIpcChannels.stopSharing]: emptyArgsSchema,
  [companionIpcChannels.setDeveloperInspection]: z.object({ enabled: z.boolean() }).strict(),
  [companionIpcChannels.setVoice]: z
    .object({ enabled: z.boolean(), readRepliesAloud: z.boolean() })
    .strict(),
  [companionIpcChannels.setAssistantMode]: z
    .object({
      mode: z.enum(['demo', 'cloud']),
      origin: z.string().max(200).optional(),
      consent: z.boolean().optional()
    })
    .strict(),
  [companionIpcChannels.guideAction]: z
    .object({ action: z.enum(['did_it', 'repeat', 'cant_find', 'manual', 'stop']) })
    .strict()
} satisfies Record<CompanionIpcChannel, z.ZodType>

export function parseCompanionIpcArgs(channel: string, args: readonly unknown[]): unknown {
  if (!(channel in ipcSchemas)) {
    throw new Error('Unknown IPC channel')
  }

  if (args.length > 1) {
    throw new Error('Unexpected IPC arguments')
  }

  const payload = args.length === 0 ? {} : args[0]
  return ipcSchemas[channel as CompanionIpcChannel].parse(payload)
}
