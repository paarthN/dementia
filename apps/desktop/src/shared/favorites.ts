export type FavoriteKind = 'application' | 'website'

export interface Favorite {
  id: string
  kind: FavoriteKind
  title: string
  target: string
  sortOrder: number
  lastLaunchAt: string | null
}

export type FavoriteSaveResult =
  | { status: 'saved'; favorite: Favorite }
  | { status: 'needs_confirmation'; summary: string }
  | { status: 'failed'; summary: string }

const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{1,220}$/

export function isBundleId(value: string): boolean {
  return bundleIdPattern.test(value) && value.includes('.') && !value.includes('..')
}

export function parseWebsite(input: string): { url: string; domain: string } | { error: string } {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return { error: "That website address doesn't look safe or valid." }
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return { error: "That website address doesn't look safe or valid." }
  }

  return { url: parsed.toString(), domain: parsed.hostname }
}

const webTlds = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'io',
  'co',
  'uk',
  'us',
  'ca',
  'app',
  'dev',
  'me',
  'info',
  'biz',
  'tv'
])

export function websiteFromPhrase(phrase: string): { url: string; domain: string } | null {
  const trimmed = phrase.trim()
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes(':') || trimmed.includes('@')) {
    return null
  }
  if (!/^[a-z0-9.-]+(?:\/[^\s]*)?$/i.test(trimmed)) {
    return null
  }
  const host = trimmed.split('/')[0] ?? ''
  const labels = host.split('.').filter((label) => label.length > 0)
  const tld = labels.at(-1)?.toLowerCase()
  if (!tld || labels.length < 2 || !webTlds.has(tld)) {
    return null
  }
  const parsed = parseWebsite(`https://${trimmed}`)
  if ('error' in parsed) {
    return null
  }
  return parsed
}

export function domainsDiffer(previousUrl: string, nextUrl: string): boolean {
  const previous = parseWebsite(previousUrl)
  const next = parseWebsite(nextUrl)
  if ('error' in previous || 'error' in next) {
    return false
  }
  return previous.domain !== next.domain
}

export function validateFavoriteTarget(
  kind: FavoriteKind,
  target: string
): { target: string } | { error: string } {
  if (kind === 'application') {
    const bundleId = target.trim()
    if (!isBundleId(bundleId)) {
      return { error: "I couldn't find that app on this computer." }
    }
    return { target: bundleId }
  }

  const website = parseWebsite(target)
  if ('error' in website) {
    return { error: website.error }
  }
  return { target: website.url }
}

export function moveSortOrder(
  idsInOrder: string[],
  id: string,
  direction: 'up' | 'down'
): string[] {
  const index = idsInOrder.indexOf(id)
  const swapWith = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || swapWith < 0 || swapWith >= idsInOrder.length) {
    return idsInOrder
  }
  const next = [...idsInOrder]
  const current = next[index]
  const other = next[swapWith]
  if (current === undefined || other === undefined) {
    return idsInOrder
  }
  next[index] = other
  next[swapWith] = current
  return next
}
