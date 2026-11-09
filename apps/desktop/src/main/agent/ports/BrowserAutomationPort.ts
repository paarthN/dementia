export const browserRoles = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'searchbox'
] as const

export const browserAncestorRoles = [
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
] as const

export const browserTextLimit = 4_000
export const browserSnapshotTtlMs = 3_000
export const browserTargetSoftCap = 80
export const browserScopedTargetCap = 80

export type BrowserRole = (typeof browserRoles)[number]
export type BrowserAncestorRole = (typeof browserAncestorRoles)[number]

export type BrowserStatus =
  | 'success_verified'
  | 'changed_but_unverified'
  | 'no_change'
  | 'ambiguous_target'
  | 'blocked_sensitive'
  | 'failed'
  | 'cancelled'
  | 'unsupported'

export interface BrowserAncestor {
  role: BrowserAncestorRole | string
  name?: string
}

export interface BrowserTarget {
  id: string
  role: BrowserRole
  name: string
  enabled: boolean
  sensitive: boolean
  ancestors: BrowserAncestor[]
  inListIndex?: number
}

export interface BrowserWithin {
  role: string
  name?: string
  nameIncludes?: string
  itemOrdinal?: number
}

export interface BrowserTargetQuery {
  role: BrowserRole
  name?: string
  nameIncludes?: string
  /** Rejected: ordinals are list-relative via within.itemOrdinal. */
  ordinal?: number
  within?: BrowserWithin
}

export interface BrowserImage {
  mime: 'image/png'
  bytes: Uint8Array
}

export interface BrowserObservation {
  snapshotId: string
  capturedAtUtc: string
  url: string
  title: string
  targets: BrowserTarget[]
  untrustedText: string
  truncated: boolean
  agentMarked: boolean
  imageIncluded: boolean
  image?: BrowserImage
}

export interface BrowserTab {
  index: number
  url: string
  title: string
}

export interface BrowserOutcome {
  status: BrowserStatus
  summary: string
  errorCode?: string
  observation?: BrowserObservation
  tabs?: BrowserTab[]
  executablePath?: string
}

export interface BrowserCallOptions {
  signal?: AbortSignal
}

export interface BrowserElementInput {
  snapshotId: string
  targetId?: string
  /** Set by the runner from the current observation so stale snapshot ids can rematch. */
  name?: string
  role?: BrowserRole
  /** Copied from the observed target so ambiguous names (two Saves) rematch uniquely. */
  ancestors?: BrowserAncestor[]
  query?: BrowserTargetQuery
  expectUrlIncludes?: string
  expectTextIncludes?: string
}

export interface BrowserObserveInput {
  includeImage?: boolean
  consent?: boolean
  within?: BrowserWithin
}

export interface BrowserAutomationPort {
  launch(input: Record<string, unknown>, options?: BrowserCallOptions): Promise<BrowserOutcome>
  open(input: { url: string }, options?: BrowserCallOptions): Promise<BrowserOutcome>
  observe(input: BrowserObserveInput, options?: BrowserCallOptions): Promise<BrowserOutcome>
  click(input: BrowserElementInput, options?: BrowserCallOptions): Promise<BrowserOutcome>
  fill(
    input: BrowserElementInput & { text: string },
    options?: BrowserCallOptions
  ): Promise<BrowserOutcome>
  press(input: { chord: string }, options?: BrowserCallOptions): Promise<BrowserOutcome>
  scroll(
    input: { direction: string; amount: number },
    options?: BrowserCallOptions
  ): Promise<BrowserOutcome>
  back(options?: BrowserCallOptions): Promise<BrowserOutcome>
  listTabs(options?: BrowserCallOptions): Promise<BrowserOutcome>
  selectTab(input: { index: number }, options?: BrowserCallOptions): Promise<BrowserOutcome>
  close(): Promise<BrowserOutcome>
  isOpen(): boolean
}
