export interface AppUrlPolicy {
  devOrigin?: string
  rendererDirectory?: string
}

export function isAllowedAppUrl(url: string, policy: AppUrlPolicy): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol === 'file:') {
    const directory = policy.rendererDirectory
    if (!directory) {
      return false
    }
    const pathname = decodeURIComponent(parsed.pathname)
    const root = directory.endsWith('/') ? directory.slice(0, -1) : directory
    return pathname === root || pathname.startsWith(`${root}/`)
  }

  if (!policy.devOrigin || parsed.protocol !== 'http:') {
    return false
  }

  return parsed.origin === policy.devOrigin
}
