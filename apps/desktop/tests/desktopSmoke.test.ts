import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNativeMacAdapter } from '../src/main/agent/ports/NativeMacAdapter'
import { createMacOsBridge, resolveHelperCommand } from '../src/main/services/osBridge'

const live = process.env['COMPANION_DESKTOP_SMOKE'] === '1'
const helper = resolveHelperCommand(process.env, resolve(__dirname, '../../..'))

describe.skipIf(!live || !helper)('hands-on Mac desktop tools', () => {
  it('lists windows, looks at a disposable TextEdit note, and focuses Finder', async () => {
    const bridge = createMacOsBridge(helper ?? { command: 'true' })
    const adapter = createNativeMacAdapter({ bridge })
    const directory = mkdtempSync(join(tmpdir(), 'companion-note-'))
    const note = join(directory, 'note.txt')
    writeFileSync(note, '')
    try {
      const listed = await adapter.listWindows({})
      console.info(
        'desktop-smoke-windows',
        listed.status,
        listed.windows?.map((item) => `${item.appName}:${item.windowId}`).join(', ')
      )
      expect(listed.status === 'success_verified' || listed.status === 'needs_permission').toBe(
        true
      )
      execFileSync('open', ['-a', 'TextEdit', note])
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 800))
      const opened = await adapter.listWindows({ bundleId: 'com.apple.TextEdit' })
      const textEdit = opened.windows?.[0]
      if (!textEdit?.bundleId) {
        console.info('desktop-smoke-textedit', 'not-listed')
        console.info('desktop-smoke-type', 'not-attempted')
      } else {
        const seen = await adapter.observe({ windowId: textEdit.windowId })
        const textAreas =
          seen.observation?.targets.filter((target) => target.role === 'AXTextArea').length ?? 0
        console.info(
          'desktop-smoke-textedit',
          seen.status,
          seen.observation?.app.name,
          seen.observation?.targets.length ?? 0,
          textAreas
        )
        expect(seen.observation?.imageIncluded ?? false).toBe(false)
        const field = seen.observation?.targets.find(
          (target) => target.role === 'AXTextArea' && target.enabled
        )
        const onlyOne = textAreas === 1
        if (
          seen.status === 'success_verified' &&
          onlyOne &&
          field &&
          seen.observation?.app.bundleId
        ) {
          const typed = await adapter.setText({
            snapshotId: seen.observation.snapshotId,
            targetId: field.id,
            windowId: seen.observation.window.id,
            bundleId: seen.observation.app.bundleId,
            name: field.name,
            role: field.role,
            text: 'Hello from Companion'
          })
          console.info('desktop-smoke-type', typed.status)
        } else {
          console.info('desktop-smoke-type', 'not-attempted', seen.status)
        }
      }
      const finder = (await adapter.listWindows({ bundleId: 'com.apple.finder' })).windows?.[0]
      if (finder?.bundleId) {
        const focused = await adapter.focusWindow({
          windowId: finder.windowId,
          bundleId: finder.bundleId
        })
        console.info('desktop-smoke-finder', focused.status, focused.summary)
      } else {
        console.info('desktop-smoke-finder', 'no-window')
      }
    } finally {
      bridge.close()
    }
  })
})
