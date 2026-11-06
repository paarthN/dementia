import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export interface ClassifyOptions {
  lookup?: (hostname: string) => Promise<string[]>
  fixtureOrigins?: readonly string[]
}

export interface NavigationDecision {
  ok: boolean
  reason: string
}

const maxUrlLength = 2_000
const blockedAddresses = new BlockList()
const blockedName =
  /^(localhost|metadata|metadata\.google\.internal)$|\.localhost$|\.local$|\.internal$/i
const sensitiveText =
  /\b(password|passcode|passphrase|pin|otp|one[- ]time|cvv|cvc|ssn|social security|security code)\b/i
const sensitiveAuto = /password|one-time-code|cc-number|cc-csc/i
const consequentialName = /\b(submit|send|buy|purchase|delete|pay|transfer)\b/i

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4')
}
blockedAddresses.addAddress('255.255.255.255', 'ipv4')
blockedAddresses.addAddress('::', 'ipv6')
blockedAddresses.addAddress('::1', 'ipv6')
blockedAddresses.addSubnet('fc00::', 7, 'ipv6')
blockedAddresses.addSubnet('fe80::', 10, 'ipv6')
blockedAddresses.addSubnet('ff00::', 8, 'ipv6')
blockedAddresses.addSubnet('2001:db8::', 32, 'ipv6')

export async function classifyNavigation(
  raw: string,
  options: ClassifyOptions = {}
): Promise<NavigationDecision> {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > maxUrlLength) {
    return blocked('That address is not allowed.')
  }
  if (raw === 'about:blank') {
    return { ok: true, reason: '' }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return blocked('That address is not allowed.')
  }
  if (url.username || url.password) {
    return blocked('That address is not allowed.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return blocked('That address is not allowed.')
  }
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase()
  if (!hostname || blockedName.test(hostname) || isWeirdIp(hostname)) {
    return blocked('That address is not allowed.')
  }
  if (isFixtureUrl(url, options.fixtureOrigins)) {
    return { ok: true, reason: '' }
  }
  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? blocked('That address is not allowed.')
      : { ok: true, reason: '' }
  }
  let addresses: string[]
  try {
    addresses = await (options.lookup ?? lookupPublic)(hostname)
  } catch {
    return blocked('I could not check that address.')
  }
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    return blocked('That address is not allowed.')
  }
  return { ok: true, reason: '' }
}

export function isSensitiveBrowserField(input: {
  name?: string
  role?: string
  inputType?: string
  autocomplete?: string
}): boolean {
  const type = (input.inputType ?? '').toLowerCase()
  if (type === 'password' || type === 'hidden') {
    return true
  }
  if (sensitiveAuto.test(input.autocomplete ?? '')) {
    return true
  }
  return sensitiveText.test(input.name ?? '') || sensitiveText.test(input.role ?? '')
}

export function isConsequentialBrowserControl(name: string): boolean {
  return consequentialName.test(name)
}

function isFixtureUrl(url: URL, origins: readonly string[] | undefined): boolean {
  if (!origins || origins.length === 0) {
    return false
  }
  return origins.some((origin) => {
    try {
      const parsed = new URL(origin)
      return (
        parsed.origin === url.origin &&
        parsed.protocol === 'http:' &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        parsed.port !== ''
      )
    } catch {
      return false
    }
  })
}

function isWeirdIp(hostname: string): boolean {
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f.]+$/i.test(hostname)) {
    return true
  }
  return /^[\d.]+$/.test(hostname) && isIP(hostname) === 0
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  const family = isIP(normalized)
  if (family === 0) {
    return true
  }
  return blockedAddresses.check(normalized, family === 6 ? 'ipv6' : 'ipv4')
}

async function lookupPublic(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function blocked(reason: string): NavigationDecision {
  return { ok: false, reason }
}
