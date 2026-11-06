import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPlaywrightAdapter } from '../src/main/agent/ports/PlaywrightAdapter'

const enabled = process.env.COMPANION_BROWSER_SMOKE === '1'

describe.skipIf(!enabled)('visible Agent Browser', () => {
  let origin = ''
  let profileDir = ''
  let closeServer: () => Promise<void> = async () => undefined
  const adapterHolder: { close: () => Promise<unknown> } = {
    close: async () => undefined
  }

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'companion-headed-browser-'))
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(
        '<!doctype html><title>Find a library</title><body><p>Visible fixture</p></body>'
      )
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    origin = `http://127.0.0.1:${port}`
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }, 20_000)

  afterAll(async () => {
    await adapterHolder.close()
    await closeServer()
    if (profileDir) {
      await rm(profileDir, { recursive: true, force: true })
    }
  })

  it('opens a headed Agent Browser on the local fixture', async () => {
    const adapter = createPlaywrightAdapter({
      profileDir,
      headed: true,
      fixtureOrigins: [origin]
    })
    adapterHolder.close = () => adapter.close()
    const launched = await adapter.launch({})
    expect(launched.status).toBe('success_verified')
    expect(launched.summary).toContain('Agent Browser')
    const opened = await adapter.open({ url: `${origin}/` })
    expect(opened.observation?.agentMarked).toBe(true)
    expect(opened.observation?.title).toContain('Find a library')
    await adapter.close()
  }, 40_000)
})
