export type MediaGrant = 'granted' | 'denied' | 'unknown'

export const panelChrome = {
  width: 1040,
  height: 680,
  minWidth: 860,
  minHeight: 560
} as const

export const privacySettingsUrl =
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'

export function classifyMediaAccess(status: string): MediaGrant {
  if (status === 'granted') {
    return 'granted'
  }
  if (status === 'denied' || status === 'restricted') {
    return 'denied'
  }
  return 'unknown'
}

export function mediaPermissionAllowed(permission: string): boolean {
  return permission === 'media'
}
