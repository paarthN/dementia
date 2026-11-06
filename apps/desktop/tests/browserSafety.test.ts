import { describe, expect, it } from 'vitest'
import { classifyNavigation, isSensitiveBrowserField } from '../src/main/agent/ports/browserSafety'

const publicLookup = async (): Promise<string[]> => ['93.184.216.34']
const privateLookup = async (): Promise<string[]> => ['10.1.2.3']

describe('agent browser address checks', () => {
  it('allows a public https address', async () => {
    const decision = await classifyNavigation('https://example.com/library', {
      lookup: publicLookup
    })
    expect(decision.ok).toBe(true)
  })

  it('blocks unsafe schemes, loopback, metadata, and private addresses', async () => {
    const cases = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hello',
      'http://localhost/admin',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'https://user:secret@example.com/',
      'https://intranet.example'
    ]
    for (const url of cases) {
      const decision = await classifyNavigation(url, { lookup: privateLookup })
      expect(decision.ok, url).toBe(false)
    }
  })

  it('blocks a public name that resolves to a private address', async () => {
    const decision = await classifyNavigation('https://rebound.example/path', {
      lookup: privateLookup
    })
    expect(decision.ok).toBe(false)
  })

  it('ignores a fixture exception for a public site', async () => {
    const decision = await classifyNavigation('https://example.com/', {
      lookup: privateLookup,
      fixtureOrigins: ['https://example.com']
    })
    expect(decision.ok).toBe(false)
  })

  it('allows one exact test fixture origin and still blocks its redirects', async () => {
    const fixture = 'http://127.0.0.1:43111'
    const allowed = await classifyNavigation(`${fixture}/results`, {
      lookup: privateLookup,
      fixtureOrigins: [fixture]
    })
    const redirect = await classifyNavigation('http://127.0.0.1:9/secret', {
      lookup: privateLookup,
      fixtureOrigins: [fixture]
    })
    expect(allowed.ok).toBe(true)
    expect(redirect.ok).toBe(false)
  })

  it('treats password and one-time-code fields as sensitive', () => {
    expect(isSensitiveBrowserField({ name: 'Password', inputType: 'password' })).toBe(true)
    expect(isSensitiveBrowserField({ autocomplete: 'one-time-code' })).toBe(true)
    expect(isSensitiveBrowserField({ name: 'Search', inputType: 'text' })).toBe(false)
  })
})
