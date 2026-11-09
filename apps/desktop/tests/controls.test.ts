import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { HelperCallError, type OsBridge } from '../src/main/services/osBridge'
import { decidePolicy } from '../src/main/services/policyEngine'
import { createScreenCoordinator } from '../src/main/services/screenCoordinator'
import { TaskOrchestrator } from '../src/main/services/taskOrchestrator'
import { createToolRegistry } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'
import { findPressableControls, findVisibleControls, pressPreview } from '../src/shared/controls'
import { reduceGuide, startGuide, startPoint } from '../src/shared/guides'
import { placeCallout } from '../src/shared/highlightGeometry'
import type { UiSnapshot } from '../src/shared/inspection'
import { routeUtterance } from '../src/shared/router'

const display = { id: 'a', x: 0, y: 0, width: 1440, height: 900, scaleFactor: 1 }
const card = { width: 280, height: 88 }

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-controls-')), 'test.sqlite'))
}

function snapshot(
  controls: UiSnapshot['controls'],
  title = 'Untitled',
  extra: Partial<UiSnapshot> = {}
): UiSnapshot {
  return {
    snapshotId: 'snap-1',
    windowId: 'pid:42',
    title,
    processId: 42,
    bundleId: 'com.apple.TextEdit',
    processName: 'TextEdit',
    bounds: { x: 40, y: 40, width: 600, height: 400 },
    protected: false,
    metadataMissing: false,
    automationDenied: false,
    controls,
    ...extra
  }
}

function control(
  name: string,
  role: string,
  bounds: { x: number; y: number; width: number; height: number } | null,
  enabled = true
): UiSnapshot['controls'][number] {
  return { id: `${role}-${name}`, name, role, enabled, offscreen: false, bounds }
}

describe('show and press a control', () => {
  it('points at the named control instead of a fixed script', () => {
    expect(routeUtterance('Show me Save')).toMatchObject({
      intent: 'guide_task',
      mode: 'guide',
      parameters: { name: 'Save' },
      missingRequiredFields: []
    })
    expect(routeUtterance('Where is File?').parameters).toMatchObject({ name: 'File' })
    expect(routeUtterance('Show me how to make this bold').parameters).toMatchObject({
      name: 'bold'
    })
    expect(routeUtterance('Show me how to save this in TextEdit').parameters).toMatchObject({
      guideId: 'textedit.save'
    })
  })

  it('asks what to press until a control is named or already highlighted', () => {
    expect(routeUtterance('Do it for me')).toMatchObject({
      intent: 'press_control',
      missingRequiredFields: ['control']
    })
    expect(
      routeUtterance('Do it for me', {
        pointed: { name: 'Save', role: 'AXMenuItem', appName: 'TextEdit' }
      }).parameters
    ).toMatchObject({ name: 'Save', role: 'AXMenuItem', appName: 'TextEdit' })
    expect(routeUtterance('Click the Save button').parameters).toMatchObject({ name: 'Save' })
    expect(routeUtterance('Type hello into the search field').parameters).toMatchObject({
      name: 'search',
      text: 'hello'
    })
  })

  it('highlights one matching control and drops the ring when it disappears', () => {
    const bold = control('Bold', 'AXCheckBox', { x: 80, y: 40, width: 36, height: 28 })
    const started = startPoint({ name: 'bold' }, snapshot([bold]), [display])
    expect(started.view.status).toBe('showing')
    expect(started.view.highlight).toMatchObject({ x: 80, y: 40, width: 36, height: 28 })
    expect(started.view.targetName).toBe('Bold')
    expect(started.view.instruction).toBe('Click Bold in TextEdit.')
    const gone = reduceGuide(started.state, 'refresh', snapshot([]), [display])
    expect(gone.view.highlight).toBeNull()
    expect(gone.view.status).toBe('missing')
    expect(gone.view.instruction).toContain("can't find Bold")
  })

  it('asks which control when the name matches more than one', () => {
    const matches = findVisibleControls(
      snapshot([
        control('Save', 'AXButton', { x: 10, y: 10, width: 40, height: 20 }),
        control('Save', 'AXMenuItem', { x: 10, y: 40, width: 80, height: 22 })
      ]),
      'Save'
    )
    expect(matches).toHaveLength(2)
    const pointed = startPoint({ name: 'Save' }, snapshot([matches[0]!, matches[1]!]), [display])
    expect(pointed.view.highlight).toBeNull()
    expect(pointed.view.instruction).toContain('Which one')
    expect(findPressableControls(snapshot([]), 'Password')).toEqual([])
  })

  it('names the app and the control in the press preview', () => {
    expect(pressPreview({ name: 'Save', appName: 'TextEdit' })).toBe("I'll click Save in TextEdit.")
    expect(pressPreview({ name: 'Search', appName: 'Notes', text: 'hello' })).toBe(
      "I'll type “hello” into Search in Notes."
    )
    const decision = decidePolicy(createToolRegistry(), {
      tool: 'ui.press',
      input: { name: 'Save', role: 'AXButton', appName: 'TextEdit' },
      source: 'user',
      now: new Date(),
      screenPermission: true
    })
    expect(decision).toMatchObject({ effect: 'allow', risk: 'R2' })
  })

  it('places the card beside the control', () => {
    const box = { x: 100, y: 80, width: 40, height: 24 }
    const spot = placeCallout(box, display, card)
    expect(spot).toEqual({ x: 152, y: 80 })
    expect(overlaps(spot, card, box)).toBe(false)
    const edge = placeCallout({ x: 1200, y: 40, width: 180, height: 30 }, display, card)
    expect(edge.x + card.width).toBeLessThanOrEqual(display.width)
    expect(overlaps(edge, card, { x: 1200, y: 40, width: 180, height: 30 })).toBe(false)
  })

  it('presses the named control when asked', async () => {
    let pressed = false
    const invoked: Record<string, unknown>[] = []
    const bridge: OsBridge = {
      async request(method, params) {
        if (method === 'ui.inspectForeground') {
          return snapshot(
            [control('Save', 'AXButton', { x: 20, y: 20, width: 60, height: 24 })],
            pressed ? 'Saved' : 'Untitled'
          )
        }
        if (method === 'ui.invokeElement') {
          invoked.push(params ?? {})
          pressed = true
          return { pressed: true, changed: true, name: 'Save', role: 'AXButton' }
        }
        throw new HelperCallError('unknown_method', 'no')
      },
      close() {
        return undefined
      }
    }
    const screen = createScreenCoordinator({ bridge, displays: () => [display] })
    screen.grant()
    const orchestrator = new TaskOrchestrator({
      db: database(),
      run: async () => 0,
      screenPermission: () => true,
      screen
    })
    const done = await orchestrator.submit('Click Save', { mode: 'guide' })
    expect(done.responseState).toBe('success')
    expect(done.summary).toContain('I pressed Save in TextEdit')
    expect(invoked).toEqual([{ name: 'Save', role: 'AXButton', processId: 42 }])
  })

  it('points from the live control list and says when the helper is down', async () => {
    const bridge: OsBridge = {
      async request(method) {
        if (method !== 'ui.inspectForeground') {
          throw new HelperCallError('unknown_method', 'no')
        }
        return snapshot([control('Bold', 'AXCheckBox', { x: 12, y: 16, width: 28, height: 28 })])
      },
      close() {
        return undefined
      }
    }
    const screen = createScreenCoordinator({ bridge, displays: () => [display] })
    screen.grant()
    const shown = await screen.point('Bold')
    expect(shown.summary).toBe('Click Bold in TextEdit.')
    expect(screen.currentGuide()?.highlight).toMatchObject({ x: 12, y: 16 })
    const down = createScreenCoordinator({
      bridge: {
        async request() {
          throw new HelperCallError('helper_unavailable', 'down')
        },
        close() {
          return undefined
        }
      },
      displays: () => [display]
    })
    down.grant()
    const failed = await down.point('Save')
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('helper_unavailable')
    expect(down.currentGuide()).toBeNull()
  })

  it('points at File until Save is visible', () => {
    const file = control('File', 'AXMenuBarItem', { x: 20, y: 0, width: 40, height: 22 })
    const started = startPoint({ name: 'Save' }, snapshot([file]), [display])
    expect(started.state.targetName).toBe('Save')
    expect(started.view.targetName).toBe('File')
    expect(started.view.instruction).toBe('Click File. Save is in that menu.')
    expect(started.view.highlight).toMatchObject({ x: 20, y: 0 })
    const opened = reduceGuide(
      started.state,
      'refresh',
      snapshot([file, control('Save', 'AXMenuItem', { x: 20, y: 40, width: 160, height: 22 })]),
      [display]
    )
    expect(opened.view.targetName).toBe('Save')
    expect(opened.view.highlight).toMatchObject({ y: 40 })
  })

  it('keeps the scripted File step pressable', () => {
    const started = startGuide(
      'textedit.save',
      snapshot([control('File', 'AXMenuBarItem', { x: 8, y: 0, width: 42, height: 22 })]),
      [display]
    )
    expect(started?.view.targetName).toBe('File')
    expect(started?.view.targetRole).toBe('AXMenuBarItem')
  })
})

function overlaps(
  spot: { x: number; y: number },
  size: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    spot.x < box.x + box.width &&
    spot.x + size.width > box.x &&
    spot.y < box.y + box.height &&
    spot.y + size.height > box.y
  )
}
