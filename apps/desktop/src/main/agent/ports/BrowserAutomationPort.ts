export const browserRoles = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'searchbox'
] as const

export const browserTextLimit = 500
export const browserSnapshotTtlMs = 3_000

export type BrowserRole = (typeof browserRoles)[number]

export type BrowserStatus =
  | 'success_verified'
  | 'changed_but_unverified'
  | 'no_change'
  | 'ambiguous_target'
  | 'blocked_sensitive'
  | 'failed'
  | 'cancelled'
  | 'unsupported'

export interface BrowserTarget {
  id: string
  role: BrowserRole
  name: string
  enabled: boolean
  sensitive: boolean
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
  targetId: string
}

export interface BrowserAutomationPort {
  launch(input: Record<string, unknown>, options?: BrowserCallOptions): Promise<BrowserOutcome>
  open(input: { url: string }, options?: BrowserCallOptions): Promise<BrowserOutcome>
  observe(
    input: { includeImage?: boolean; consent?: boolean },
    options?: BrowserCallOptions
  ): Promise<BrowserOutcome>
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
