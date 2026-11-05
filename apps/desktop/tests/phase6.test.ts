import { describe, expect, it } from 'vitest'
import { createScreenCoordinator } from '../src/main/services/screenCoordinator'
import { TaskOrchestrator } from '../src/main/services/taskOrchestrator'
import { openDatabase } from '../src/main/storage/database'
import { reduceGuide, startGuide } from '../src/shared/guides'
import {
  applyGuidanceOverlayBehavior,
  guidanceOverlayWindowOptions,
  overlayPlacements,
  placeHighlight,
  type DisplaySpace
} from '../src/shared/highlightGeometry'
import type { UiSnapshot } from '../src/shared/inspection'
import type { OsBridge } from '../src/main/services/osBridge'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const primary: DisplaySpace = { id: 'a', x: 0, y: 0, width: 1440, height: 900, scaleFactor: 1 }
const secondary: DisplaySpace = {
  id: 'b',
  x: 1440,
  y: 0,
  width: 1280,
  height: 800,
  scaleFactor: 1.5
}

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-guide-')), 'test.sqlite'))
}

function textEdit(controls: UiSnapshot['controls'], title = 'Untitled'): UiSnapshot {
  return {
    snapshotId: 'snap-textedit',
    windowId: 'pid:42',
    title,
    processId: 42,
    bundleId: 'com.apple.TextEdit',
    processName: 'TextEdit',
    bounds: { x: 40, y: 40, width: 600, height: 400 },
    protected: false,
    metadataMissing: false,
    automationDenied: false,
    controls
  }
}

function control(
  name: string,
  role: string,
  bounds: { x: number; y: number; width: number; height: number } | null
): UiSnapshot['controls'][number] {
  return { id: name, name, role, enabled: true, offscreen: false, bounds }
}

describe('guidance highlights', () => {
  it('T-GUIDE-01 aligns a highlight with a real Accessibility element', () => {
    const bounds = { x: 100, y: 200, width: 80, height: 30 }
    const placed = placeHighlight(bounds, [primary])
    expect(placed).toMatchObject({ displayId: 'a', x: 100, y: 200, width: 80, height: 30 })
    const started = startGuide(
      'textedit.save',
      textEdit([control('File', 'AXMenuBarItem', bounds)]),
      [primary]
    )
    expect(started?.view.instruction).toBe('Click File at the top of the window.')
    expect(started?.view.highlight).toMatchObject({ x: 100, y: 200, width: 80, height: 30 })
  })

  it('T-GUIDE-02 moves the highlight with the window and drops it when the target is gone', () => {
    const started = startGuide(
      'textedit.save',
      textEdit([control('File', 'AXMenuBarItem', { x: 10, y: 4, width: 40, height: 22 })]),
      [primary]
    )
    expect(started).not.toBeNull()
    const moved = reduceGuide(
      started?.state ?? { guideId: 'textedit.save', stepIndex: 0, status: 'showing' },
      'refresh',
      textEdit([control('File', 'AXMenuBarItem', { x: 200, y: 4, width: 40, height: 22 })]),
      [primary]
    )
    expect(moved.view.highlight).toMatchObject({ x: 200, y: 4 })
    const gone = reduceGuide(
      moved.state,
      'refresh',
      textEdit([control('File', 'AXMenuBarItem', null)]),
      [primary]
    )
    expect(gone.view.highlight).toBeNull()
    expect(gone.view.status).toBe('missing')
  })

  it('T-GUIDE-03 says the control is unavailable and keeps no stale box', () => {
    const started = startGuide(
      'textedit.save',
      textEdit([control('File', 'AXMenuBarItem', { x: 12, y: 4, width: 36, height: 20 })]),
      [primary]
    )
    const missing = reduceGuide(
      started?.state as NonNullable<typeof started>['state'],
      'refresh',
      textEdit([]),
      [primary]
    )
    expect(missing.view.status).toBe('missing')
    expect(missing.view.instruction).toContain("I can't reliably find that button")
    expect(missing.view.highlight).toBeNull()
    expect(overlayPlacements(missing.view.highlight, [primary])).toEqual([])
  })

  it('T-GUIDE-04 does not let the overlay take the click', () => {
    const calls: unknown[] = []
    applyGuidanceOverlayBehavior({
      setIgnoreMouseEvents: (ignore) => calls.push(['ignore', ignore]),
      setFocusable: (focusable) => calls.push(['focus', focusable]),
      setAlwaysOnTop: (flag) => calls.push(['top', flag]),
      setVisibleOnAllWorkspaces: (visible) => calls.push(['spaces', visible])
    })
    expect(calls).toContainEqual(['ignore', true])
    expect(calls).toContainEqual(['focus', false])
    const options = guidanceOverlayWindowOptions(primary)
    expect(options.ignoreMouseEvents).toBe(true)
    expect(options.focusable).toBe(false)
    expect(options.transparent).toBe(true)
  })

  it('T-GUIDE-05 keeps highlight size in points on a 150% display', () => {
    const placed = placeHighlight({ x: 1500, y: 100, width: 120, height: 40 }, [primary, secondary])
    expect(placed).toMatchObject({
      displayId: 'b',
      x: 60,
      y: 100,
      width: 120,
      height: 40,
      dipWidth: 120,
      physicalWidth: 180
    })
    expect(placed?.width).not.toBe(placed?.physicalWidth)
  })

  it('T-GUIDE-06 stop ends the guide and removes every overlay', () => {
    const started = startGuide(
      'textedit.save',
      textEdit([control('File', 'AXMenuBarItem', { x: 8, y: 4, width: 40, height: 18 })]),
      [primary, secondary]
    )
    expect(overlayPlacements(started?.view.highlight ?? null, [primary, secondary])).toHaveLength(1)
    const stopped = reduceGuide(
      started?.state as NonNullable<typeof started>['state'],
      'stop',
      null,
      [primary, secondary]
    )
    expect(stopped.view.status).toBe('stopped')
    expect(stopped.view.highlight).toBeNull()
    expect(overlayPlacements(stopped.view.highlight, [primary, secondary])).toEqual([])
  })

  it('includes TextEdit Save and Accessibility Display guides', async () => {
    const bridge: OsBridge = {
      async request(method) {
        if (method !== 'ui.inspectForeground') {
          return { trusted: false }
        }
        return {
          snapshotId: 'snap-settings',
          windowId: 'pid:7',
          title: 'Accessibility',
          processId: 7,
          bundleId: 'com.apple.systempreferences',
          processName: 'System Settings',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          protected: false,
          metadataMissing: false,
          automationDenied: false,
          controls: [control('Display', 'AXButton', { x: 40, y: 180, width: 220, height: 44 })]
        }
      },
      close() {
        return undefined
      }
    }
    const screen = createScreenCoordinator({
      bridge,
      displays: () => [primary]
    })
    screen.grant()
    const outcome = await new TaskOrchestrator({
      db: database(),
      run: async () => 0,
      screenPermission: () => true,
      screen
    }).submit('Show me how to save this in TextEdit')
    expect(outcome.summary).toContain('TextEdit')
    const display = await screen.startGuide('accessibility.display')
    expect(display.summary).toBe('Click Display in the Accessibility list.')
    expect(screen.currentGuide()?.highlight).toMatchObject({
      x: 40,
      y: 180,
      width: 220,
      height: 44
    })
    const stopped = await screen.guideAction('stop')
    expect(stopped.summary).toContain('highlight is gone')
    expect(screen.currentGuide()).toBeNull()
  })
})
