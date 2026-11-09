import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createPeekabooDesktop } from '../src/main/agent/ports/PeekabooDesktopAdapter'
import { launchBundle } from '../src/main/services/launcher'

const live = process.env.COMPANION_NOTES_LIVE === '1'

describe.skipIf(!live)('live Notes paste', () => {
  it('types Wikipedia sentences into a new Notes note through Peekaboo', async () => {
    const sentences =
      'San Diego is a city on the Pacific coast of California. It is known for its beaches, parks, and mild climate year round.'
    const { port } = createPeekabooDesktop()
    const runOpen = async (): Promise<boolean> => {
      const opened = await launchBundle('com.apple.Notes', async (command, args) => {
        return await new Promise<number>((resolve) => {
          const child = spawn(command, args, { stdio: 'ignore' })
          child.on('close', (code) => resolve(code ?? 1))
          child.on('error', () => resolve(1))
        })
      })
      return opened.status === 'succeeded'
    }
    expect(await runOpen()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const before = await port.observe({})
    expect(before.status).toBe('success_verified')
    expect(before.observation?.window.id).toBeTruthy()
    const pressed = await port.keyPress({
      chord: 'cmd+n',
      windowId: before.observation!.window.id,
      bundleId: before.observation!.app.bundleId || 'com.apple.Notes',
      processId: before.observation!.app.processId ?? 0
    })
    expect(pressed.status).toBe('success_verified')
    const after = await port.observe({})
    expect(after.status).toBe('success_verified')
    const target = after.observation?.targets.find(
      (item) =>
        (item.role === 'AXTextArea' || item.role === 'AXTextField') && item.enabled !== false
    )
    expect(target).toBeTruthy()
    const typed = await port.setText({
      snapshotId: after.observation!.snapshotId,
      targetId: target!.id,
      windowId: after.observation!.window.id,
      bundleId: after.observation!.app.bundleId || 'com.apple.Notes',
      name: target!.name,
      role: target!.role,
      text: sentences
    })
    console.info('live-setText', typed.status, typed.summary)
    expect(typed.status).toBe('success_verified')
  }, 60_000)
})
