import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMacOsBridge,
  HelperCallError,
  resolveHelperCommand
} from '../src/main/services/osBridge'

const live = process.env['COMPANION_STOP_RACE'] === '1'
const helper = resolveHelperCommand(process.env, resolve(__dirname, '../../..'))

describe.skipIf(!live || !helper)('hands-on Stop during a helper read', () => {
  it('aborts an in-flight read and still answers the next call', async () => {
    const bridge = createMacOsBridge(helper ?? { command: 'true' })
    const controller = new AbortController()
    const pending = bridge.request(
      'ui.inspectForeground',
      {},
      { timeoutMs: 8_000, signal: controller.signal }
    )
    const abortTimer = setTimeout(() => controller.abort(), 30)
    let first: 'aborted' | 'finished' = 'finished'
    try {
      await pending
    } catch (error) {
      clearTimeout(abortTimer)
      expect(error).toBeInstanceOf(HelperCallError)
      expect((error as HelperCallError).code).toBe('aborted')
      first = 'aborted'
    }
    clearTimeout(abortTimer)
    const ping = await bridge.request('system.ping', {}, { timeoutMs: 5_000 })
    expect(ping).toBeTruthy()
    expect(first).toBe('aborted')
    bridge.close()
  }, 20_000)
})
