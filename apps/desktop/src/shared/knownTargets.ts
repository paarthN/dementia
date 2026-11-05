export interface KnownApp {
  displayName: string
  bundleId: string
  aliases: string[]
}

export interface VettedSite {
  displayName: string
  url: string
  aliases: string[]
}

export const knownApps: KnownApp[] = [
  { displayName: 'TextEdit', bundleId: 'com.apple.TextEdit', aliases: ['textedit', 'text edit'] },
  { displayName: 'Safari', bundleId: 'com.apple.Safari', aliases: ['safari'] },
  { displayName: 'Mail', bundleId: 'com.apple.mail', aliases: ['mail', 'email'] },
  { displayName: 'Notes', bundleId: 'com.apple.Notes', aliases: ['notes'] },
  { displayName: 'Calendar', bundleId: 'com.apple.iCal', aliases: ['calendar'] },
  { displayName: 'Finder', bundleId: 'com.apple.finder', aliases: ['finder'] },
  { displayName: 'Preview', bundleId: 'com.apple.Preview', aliases: ['preview'] },
  { displayName: 'Photos', bundleId: 'com.apple.Photos', aliases: ['photos'] },
  { displayName: 'Music', bundleId: 'com.apple.Music', aliases: ['music'] },
  { displayName: 'Maps', bundleId: 'com.apple.Maps', aliases: ['maps'] },
  { displayName: 'Messages', bundleId: 'com.apple.MobileSMS', aliases: ['messages'] },
  { displayName: 'FaceTime', bundleId: 'com.apple.FaceTime', aliases: ['facetime', 'face time'] },
  {
    displayName: 'System Settings',
    bundleId: 'com.apple.systempreferences',
    aliases: ['system settings', 'settings']
  }
]

export const vettedSites: VettedSite[] = [
  { displayName: 'YouTube', url: 'https://www.youtube.com/', aliases: ['youtube', 'you tube'] },
  { displayName: 'Google', url: 'https://www.google.com/', aliases: ['google'] },
  { displayName: 'Wikipedia', url: 'https://www.wikipedia.org/', aliases: ['wikipedia'] }
]

const bundleIds = new Set(knownApps.map((app) => app.bundleId))

export function matchKnownApp(phrase: string): KnownApp | null {
  const name = normalizePhrase(phrase)
  return knownApps.find((app) => app.aliases.includes(name)) ?? null
}

export function matchKnownBundle(phrase: string): KnownApp | null {
  const name = phrase.trim().toLowerCase()
  return knownApps.find((app) => app.bundleId.toLowerCase() === name) ?? null
}

export function matchVettedSite(phrase: string): VettedSite | null {
  const name = normalizePhrase(phrase)
  return vettedSites.find((site) => site.aliases.includes(name)) ?? null
}

export function isKnownBundle(bundleId: string): boolean {
  return bundleIds.has(bundleId)
}

const appNamePattern = /^[\p{L}\p{N}][\p{L}\p{N} .+'’&_-]{0,79}$/u

const spokenAppNames: Record<string, string> = {
  chrome: 'Google Chrome',
  'google chrome': 'Google Chrome',
  brave: 'Brave Browser',
  edge: 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  code: 'Visual Studio Code',
  'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code'
}

export function appLaunchName(value: string): string | null {
  const name = value
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/\.app$/i, '')
    .replace(/^the\s+/i, '')
    .trim()
  if (
    !name ||
    name.length > 80 ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\') ||
    !appNamePattern.test(name)
  ) {
    return null
  }
  return spokenAppNames[name.toLowerCase()] ?? name
}

export function isVettedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return vettedSites.some((site) => {
    const vetted = new URL(site.url).hostname.toLowerCase()
    return host === vetted || host === vetted.replace(/^www\./, '')
  })
}

function normalizePhrase(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
}
