export const systemSettingsSections = [
  'text',
  'display',
  'zoom',
  'pointer',
  'contrast',
  'brightness'
] as const

export type SystemSettingsSection = (typeof systemSettingsSections)[number]

const settingsAnchors: Record<SystemSettingsSection, string> = {
  text: 'com.apple.Accessibility?Display',
  display: 'com.apple.Displays-Settings.extension',
  zoom: 'com.apple.Accessibility?Zoom',
  pointer: 'com.apple.Accessibility?PointerControl',
  contrast: 'com.apple.Accessibility?Display',
  brightness: 'com.apple.Displays-Settings.extension'
}

export function systemSettingsUrl(section: SystemSettingsSection): string {
  return `x-apple.systempreferences:${settingsAnchors[section]}`
}
