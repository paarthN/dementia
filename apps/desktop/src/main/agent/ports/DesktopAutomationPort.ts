export const desktopKeyChords = [
  'tab',
  'shift+tab',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'pageup',
  'pagedown',
  'home',
  'end'
] as const

/** Chords the Peekaboo path accepts beyond the navigation keys. */
export const desktopExtraChords = ['return', 'delete', 'cmd+a', 'cmd+n', 'cmd+v'] as const

export const desktopAllowedChords = [...desktopKeyChords, ...desktopExtraChords] as const

export const desktopTextLimit = 500
export const desktopSnapshotTtlMs = 3_000

export type DesktopKeyChord = (typeof desktopKeyChords)[number]

export type DesktopStatus =
  | 'success_verified'
  | 'changed_but_unverified'
  | 'no_change'
  | 'ambiguous_target'
  | 'needs_permission'
  | 'blocked_sensitive'
  | 'failed'
  | 'cancelled'
  | 'uncertain_after_timeout'
  | 'unsupported'

export interface DesktopTarget {
  id: string
  role: string
  name: string
  enabled: boolean
  value?: string
  bounds?: { x: number; y: number; width: number; height: number } | null
}

export interface DesktopObservation {
  snapshotId: string
  capturedAtUtc: string
  app: { name: string; bundleId?: string; processId?: number }
  window: { id: string; title?: string }
  targets: DesktopTarget[]
  protected: boolean
  truncated: boolean
  imageIncluded: boolean
  contextText?: string
  image?: DesktopImage
}

export interface DesktopImage {
  mime: 'image/png'
  bytes: Uint8Array
  width: number
  height: number
  displayId: string
  scale: number
}

export interface DesktopWindow {
  windowId: string
  appName: string
  bundleId?: string
  title: string
  processId: number
}

export interface DesktopOutcome {
  status: DesktopStatus
  summary: string
  errorCode?: string
  observation?: DesktopObservation
  windows?: DesktopWindow[]
}

export interface DesktopCallOptions {
  signal?: AbortSignal
}

export interface DesktopElementInput {
  snapshotId: string
  targetId: string
  windowId: string
  bundleId: string
  name: string
  role: string
}

export interface DesktopAutomationPort {
  listWindows(input: { bundleId?: string }, options?: DesktopCallOptions): Promise<DesktopOutcome>
  focusWindow(
    input: { windowId: string; bundleId: string },
    options?: DesktopCallOptions
  ): Promise<DesktopOutcome>
  observe(
    input: { windowId?: string; includeImage?: boolean },
    options?: DesktopCallOptions
  ): Promise<DesktopOutcome>
  clickElement(input: DesktopElementInput, options?: DesktopCallOptions): Promise<DesktopOutcome>
  setText(
    input: DesktopElementInput & { text: string },
    options?: DesktopCallOptions
  ): Promise<DesktopOutcome>
  keyPress(
    input: { chord: string; windowId: string; bundleId: string; processId: number },
    options?: DesktopCallOptions
  ): Promise<DesktopOutcome>
  scroll(
    input: {
      direction: string
      amount: number
      windowId: string
      bundleId: string
      processId: number
    },
    options?: DesktopCallOptions
  ): Promise<DesktopOutcome>
  clickPoint(
    input: { snapshotId: string; windowId: string; x: number; y: number },
    options?: DesktopCallOptions
  ): Promise<DesktopOutcome>
}
