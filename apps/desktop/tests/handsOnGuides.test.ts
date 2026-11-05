import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMacOsBridge, resolveHelperCommand } from '../src/main/services/osBridge'
import { createScreenCoordinator } from '../src/main/services/screenCoordinator'
import type { DisplaySpace } from '../src/shared/highlightGeometry'

const live = process.env['COMPANION_HANDS_ON'] === '1'
const helper = resolveHelperCommand(process.env, resolve(__dirname, '../../..'))
const display: DisplaySpace = {
  id: 'main',
  x: 0,
  y: 0,
  width: 4000,
  height: 2000,
  scaleFactor: 2
}

describe.skipIf(!live || !helper)('hands-on macOS guides', () => {
  const bridge = createMacOsBridge(helper ?? { command: 'true' })
  const screen = createScreenCoordinator({
    bridge,
    displays: () => [display]
  })

  afterAll(() => {
    bridge.close()
  })

  it('highlights TextEdit File from the real menu bar, then Save or Command-S', async () => {
    execFileSync('open', ['-b', 'com.apple.TextEdit'])
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 800))
    screen.grant()
    const started = await screen.startGuide('textedit.save')
    const guide = screen.currentGuide()
    console.info('textedit-guide', started.summary, guide?.highlight)
    expect(started.summary.length).toBeGreaterThan(0)
    expect(guide?.guideId).toBe('textedit.save')
    if (guide?.highlight) {
      expect(guide.highlight.width).toBeGreaterThan(0)
      expect(guide.highlight.height).toBeGreaterThan(0)
      expect(started.summary).toContain('File')
    } else {
      expect(started.summary).toMatch(/Command-S|can't reliably find|Bring TextEdit/)
    }

    try {
      execFileSync('osascript', [
        '-e',
        'tell application "System Events" to tell process "TextEdit" to click menu bar item "File" of menu bar 1'
      ])
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400))
      const stepped = await screen.guideAction('refresh')
      const next = screen.currentGuide()
      console.info('textedit-save', stepped.summary, next?.highlight)
      if (next?.highlight) {
        expect(stepped.summary.toLowerCase()).toContain('save')
        expect(next.highlight.width).toBeGreaterThan(0)
      }
      execFileSync('osascript', ['-e', 'tell application "System Events" to key code 53'])
    } catch (error) {
      expect(String(error)).toMatch(/osascript|System Events|not allowed|-1743/)
    }

    const stopped = await screen.guideAction('stop')
    expect(stopped.summary).toContain('highlight is gone')
    expect(screen.currentGuide()).toBeNull()
  })

  it('highlights Accessibility or Display in the real System Settings window', async () => {
    execFileSync('open', ['x-apple.systempreferences:com.apple.Sound-Settings.extension'])
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200))
    screen.grant()
    const started = await screen.startGuide('accessibility.display')
    const guide = screen.currentGuide()
    console.info('settings-guide', started.summary, guide?.highlight)
    expect(guide?.guideId).toBe('accessibility.display')
    expect(started.summary).toMatch(/Accessibility|Display/)
    expect(guide?.highlight?.width).toBeGreaterThan(0)
    expect(guide?.highlight?.height).toBeGreaterThan(0)
    const stopped = await screen.guideAction('stop')
    expect(screen.currentGuide()).toBeNull()
    expect(stopped.summary).toContain('highlight is gone')
  })
})
