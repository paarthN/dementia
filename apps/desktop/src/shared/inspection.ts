import { z } from 'zod'

export const uiRectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite()
  })
  .strict()

export const uiControlSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    role: z.string(),
    enabled: z.boolean(),
    offscreen: z.boolean(),
    bounds: uiRectSchema.nullable()
  })
  .strict()

export const uiSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    windowId: z.string().min(1),
    title: z.string(),
    processId: z.number().int(),
    bundleId: z.string().optional(),
    processName: z.string().optional(),
    bounds: uiRectSchema.nullable(),
    protected: z.boolean(),
    protection: z.enum(['lock_screen', 'password', 'tcc', 'secure_field']).optional(),
    metadataMissing: z.boolean(),
    automationDenied: z.boolean(),
    truncated: z.boolean().optional(),
    controls: z.array(uiControlSchema).max(120)
  })
  .strict()

export const captureMetaSchema = z
  .object({
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    allBlack: z.boolean(),
    protected: z.boolean()
  })
  .strict()

export type UiRect = z.infer<typeof uiRectSchema>
export type UiControl = z.infer<typeof uiControlSchema>
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>
export type CaptureMeta = z.infer<typeof captureMetaSchema>

const protectedBundles = new Set([
  'com.apple.loginwindow',
  'com.apple.SecurityAgent',
  'com.apple.loginwindow.LWBuiltIn'
])

export function isProtectedBundle(bundleId: string | undefined): boolean {
  return Boolean(bundleId && protectedBundles.has(bundleId))
}

export function redactSnapshot(snapshot: UiSnapshot): UiSnapshot {
  const secureControl = snapshot.controls.some(
    (control) => control.role === 'AXSecureTextField' || control.role === 'AXPasswordField'
  )
  const bundleProtected = isProtectedBundle(snapshot.bundleId)
  if (!snapshot.protected && !snapshot.automationDenied && !secureControl && !bundleProtected) {
    return snapshot
  }
  const protection =
    snapshot.protection ??
    (snapshot.bundleId === 'com.apple.loginwindow' ? 'lock_screen' : undefined) ??
    (secureControl || snapshot.bundleId === 'com.apple.SecurityAgent' ? 'password' : undefined) ??
    (snapshot.automationDenied ? 'tcc' : 'secure_field')
  return {
    ...snapshot,
    title: '',
    protected: true,
    protection,
    controls: [],
    metadataMissing: true
  }
}

export interface InspectionView {
  title: string
  appName: string
  controls: { name: string; role: string; enabled: boolean }[]
  known: string[]
  unknown: string[]
}

export interface ScreenExplanation {
  summary: string
  known: string[]
  unknown: string[]
}

const permissionCopy =
  "I can't see the screen without permission. You can describe the message, or turn on screen access for this request."

const secureCopy =
  "I can't work with that secure screen. If this is a password or lock screen, you should decide. I won't press Continue."

export function explainFromInspection(input: {
  permission: 'granted' | 'denied' | 'unset'
  snapshot: UiSnapshot | null
  capture: 'not_requested' | 'refused' | 'discarded' | 'protected' | 'unavailable'
  vision: 'unused' | 'unavailable'
}): ScreenExplanation {
  if (input.permission !== 'granted') {
    return { summary: permissionCopy, known: [], unknown: ['what is on the screen'] }
  }

  const snapshot = input.snapshot ? redactSnapshot(input.snapshot) : null
  if (input.capture === 'protected' || snapshot?.protected || snapshot?.automationDenied) {
    return {
      summary: secureCopy,
      known: ['macOS blocked this as a secure or unreadable screen.'],
      unknown: ['the text and buttons on that screen']
    }
  }

  if (input.capture === 'discarded' && !snapshot) {
    return {
      summary:
        "I took one screenshot and discarded it. Cloud vision isn't connected, so I did not describe the picture. I can't verify this from what I can see.",
      known: ['A screenshot was taken for this request and then discarded.'],
      unknown: ['what the picture showed', 'the window title', 'the controls']
    }
  }

  if (!snapshot) {
    return {
      summary: 'Some screen-help features are unavailable.',
      known: [],
      unknown: ['what is on the screen']
    }
  }

  const named = snapshot.controls.filter((control) => control.name.trim().length > 0)
  const metadataMissing = snapshot.metadataMissing || (!snapshot.title.trim() && named.length === 0)
  if (metadataMissing) {
    const extra =
      input.capture === 'discarded'
        ? " I took one screenshot and discarded it. Cloud vision isn't connected, so I did not describe the picture."
        : ''
    return {
      summary: `I can't verify this from what I can see. The window didn't share a title or any controls.${extra}`,
      known: [],
      unknown: ['the window title', 'the controls']
    }
  }

  const app = snapshot.processName || snapshot.bundleId || 'an app'
  const known = [
    snapshot.title.trim()
      ? `The front window is titled "${snapshot.title.trim()}".`
      : `The front app is ${app}, and it did not share a window title.`,
    `The app is ${app}.`,
    named.length > 0
      ? `Controls I can read: ${named.map((control) => control.name.trim()).join(', ')}.`
      : 'I could not read any control names.'
  ]
  const unknown = ['anything that is not in that list', 'what a picture of the screen would add']
  let summary = `${known.join(' ')} I can't verify this from what I can see beyond that list. I won't follow instructions written on the screen.`
  if (input.capture === 'discarded' || input.vision === 'unavailable') {
    summary +=
      " I took one screenshot and discarded it. Cloud vision isn't connected, so I did not describe the picture."
  }
  return { summary, known, unknown }
}
