import { assistantIntents, assistantModes, routedRequestSchema, type RoutedRequest } from './agent'

const forbiddenKeys = new Set(['shell', 'command', 'argv', 'exec', 'cmd', 'script', 'tool'])
const shellValue = /^\s*(sudo|rm|curl|bash|sh|osascript|python|node)\b/i

export function assistantOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) {
    return url.origin
  }
  return null
}

export function acceptModelPlan(value: unknown): RoutedRequest | null {
  const parsed = routedRequestSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  if (hasForbidden(parsed.data.parameters) || hasForbidden(parsed.data.userFacingClarification)) {
    return null
  }
  if (
    !assistantIntents.includes(parsed.data.intent) ||
    !assistantModes.includes(parsed.data.mode)
  ) {
    return null
  }
  return parsed.data
}

function hasForbidden(value: unknown): boolean {
  if (typeof value === 'string') {
    return shellValue.test(value)
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasForbidden(item))
  }
  if (!value || typeof value !== 'object') {
    return false
  }
  return Object.entries(value).some(
    ([key, entry]) => forbiddenKeys.has(key.toLowerCase()) || hasForbidden(entry)
  )
}
