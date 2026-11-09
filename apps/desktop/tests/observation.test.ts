import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createObservationService,
  createObservingDesktopPort,
  observationForModel
} from '../src/main/agent/ObservationService'
import type {
  DesktopAutomationPort,
  DesktopObservation,
  DesktopOutcome
} from '../src/main/agent/ports/DesktopAutomationPort'
import { validateCaptureGeometry } from '../src/main/agent/security/ObservationRedaction'
import type { DisplaySpace } from '../src/shared/highlightGeometry'
import { desktopToolDefinitions } from '../src/main/agent/tools/desktopTools'
import { createScreenCoordinator } from '../src/main/services/screenCoordinator'
import { HelperCallError, type OsBridge } from '../src/main/services/osBridge'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function stage(bytes: Buffer, mode = 0o600): { directory: string; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'companion-capture-'))
  chmodSync(directory, 0o700)
  const filePath = join(directory, 'shot.png')
  writeFileSync(filePath, bytes, { mode })
  chmodSync(filePath, mode)
  return { directory, filePath }
}

function observed(): DesktopObservation {
  return {
    snapshotId: 'snap-1',
    capturedAtUtc: new Date(1_000).toISOString(),
    app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 42 },
    window: { id: '7', title: 'Untitled' },
    targets: [{ id: 'body', role: 'AXTextArea', name: 'Text', enabled: true }],
    protected: false,
    truncated: false,
    imageIncluded: false
  }
}

function geometry(
  file: { directory: string; filePath: string },
  patch?: Record<string, unknown>
): Record<string, unknown> {
  return {
    windowId: '7',
    processId: 42,
    bundleId: 'com.apple.TextEdit',
    title: 'Untitled',
    displayId: '1',
    scale: 2,
    width: 400,
    height: 200,
    pointWidth: 200,
    pointHeight: 100,
    byteLength: png.length,
    filePath: file.filePath,
    directory: file.directory,
    blank: false,
    protected: false,
    ...patch
  }
}

function desktop(observation: DesktopObservation = observed()): DesktopAutomationPort {
  const outcome: DesktopOutcome = {
    status: 'success_verified',
    summary: 'I looked at TextEdit and can read 1 named controls.',
    observation
  }
  return {
    async listWindows() {
      return { status: 'failed', summary: 'unused' }
    },
    async focusWindow() {
      return { status: 'failed', summary: 'unused' }
    },
    async observe() {
      return outcome
    },
    async clickElement() {
      return { status: 'failed', summary: 'unused' }
    },
    async setText() {
      return { status: 'failed', summary: 'unused' }
    },
    async keyPress() {
      return { status: 'failed', summary: 'unused' }
    },
    async scroll() {
      return { status: 'failed', summary: 'unused' }
    },
    async clickPoint() {
      return { status: 'failed', summary: 'unused' }
    }
  }
}

function bridge(reply: (signal: AbortSignal | undefined) => Promise<unknown>): OsBridge & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    async request(method, _params, requestOptions) {
      calls.push(method)
      return reply(requestOptions?.signal)
    },
    close() {
      return undefined
    }
  }
}

function screen(): ReturnType<typeof createScreenCoordinator> {
  return createScreenCoordinator({
    bridge: {
      async request() {
        return { pong: true }
      },
      close() {
        return undefined
      }
    }
  })
}

const displays = (): DisplaySpace[] => [
  { id: '1', x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2 }
]

describe('capture geometry', () => {
  it('accepts a 2x window and a downscaled retina window', () => {
    expect(
      validateCaptureGeometry({
        expected: { windowId: '7', processId: 42, bundleId: 'com.apple.TextEdit' },
        displays: displays(),
        capture: {
          windowId: '7',
          processId: 42,
          bundleId: 'com.apple.TextEdit',
          displayId: '1',
          scale: 2,
          width: 400,
          height: 200,
          pointWidth: 200,
          pointHeight: 100,
          byteLength: 100,
          blank: false,
          protected: false
        }
      })
    ).toBeNull()
    expect(
      validateCaptureGeometry({
        expected: { windowId: '7', processId: 42, bundleId: 'com.apple.TextEdit' },
        displays: displays(),
        capture: {
          windowId: '7',
          processId: 42,
          bundleId: 'com.apple.TextEdit',
          displayId: '1',
          scale: 2,
          width: 1280,
          height: 512,
          pointWidth: 1000,
          pointHeight: 400,
          byteLength: 100,
          blank: false,
          protected: false
        }
      })
    ).toBeNull()
  })

  it('rejects the wrong window, a bad scale, and an oversized frame', () => {
    const base = {
      windowId: '7',
      processId: 42,
      bundleId: 'com.apple.TextEdit',
      displayId: '1',
      scale: 2,
      width: 400,
      height: 200,
      pointWidth: 200,
      pointHeight: 100,
      byteLength: 100,
      blank: false,
      protected: false
    }
    expect(
      validateCaptureGeometry({
        expected: { windowId: '7', processId: 42, bundleId: 'com.apple.TextEdit' },
        displays: displays(),
        capture: { ...base, windowId: '8' }
      })
    ).toBe('wrong_window')
    expect(
      validateCaptureGeometry({
        expected: { windowId: '7', processId: 42, bundleId: 'com.apple.TextEdit' },
        displays: displays(),
        capture: { ...base, width: 200, height: 100 }
      })
    ).toBe('bad_scale')
    expect(
      validateCaptureGeometry({
        expected: { windowId: '7', processId: 42, bundleId: 'com.apple.TextEdit' },
        displays: [{ id: '1', x: 0, y: 0, width: 800, height: 600, scaleFactor: 1 }],
        capture: base
      })
    ).toBe('bad_scale')
    expect(
      validateCaptureGeometry({
        expected: { windowId: '7', processId: 42, bundleId: 'com.apple.TextEdit' },
        displays: displays(),
        capture: { ...base, width: 2000, height: 800, pointWidth: 1000, pointHeight: 400 }
      })
    ).toBe('too_large')
  })
})

describe('window pictures', () => {
  it('keeps a matching picture in memory, deletes the file, and does not prepare it for a model', async () => {
    const files: string[] = []
    const helper = bridge(async () => {
      const file = stage(png)
      files.push(file.filePath)
      return geometry(file)
    })
    const view = screen()
    view.grant()
    const states: boolean[] = []
    const service = createObservationService({
      desktop: desktop(),
      bridge: helper,
      screen: view,
      displays,
      now: () => 1_000,
      onActivity: () => states.push(view.status().captureActive)
    })
    const result = await service.observe({ windowId: '7', includeImage: true })
    expect(result.status).toBe('success_verified')
    expect(result.observation?.image?.bytes.byteLength).toBe(png.length)
    expect(result.summary).toContain('did not send it anywhere')
    expect(files.every((file) => !existsSync(file))).toBe(true)
    expect(states).toEqual([true, false])
    expect(view.status().captureActive).toBe(false)
    const shared = observationForModel(result.observation ?? observed())
    expect(shared.image).toBeUndefined()
    expect(shared.imageIncluded).toBe(false)
    expect(JSON.stringify(shared)).not.toContain('filePath')
    const tool = desktopToolDefinitions().find((item) => item.name === 'desktop.observe')
    const port = createObservingDesktopPort(desktop(), service)
    const sent = await tool?.execute(
      { includeImage: true, windowId: '7' },
      { signal: new AbortController().signal, desktop: port }
    )
    expect(sent?.data).toMatchObject({ imageIncluded: true })
    expect(JSON.stringify(sent)).not.toContain('filePath')
    expect(JSON.stringify(sent)).not.toContain('companion-capture-')
  })

  it('does not capture when screen access is off, the snapshot is old, or the window is protected', async () => {
    const helper = bridge(async () => {
      throw new Error('capture should not run')
    })
    const view = screen()
    const service = createObservationService({
      desktop: desktop(),
      bridge: helper,
      screen: view,
      displays,
      now: () => 1_000
    })
    const denied = await service.observe({ includeImage: true, windowId: '7' })
    expect(denied.observation?.image).toBeUndefined()
    expect(denied.summary).toContain('did not take a picture')
    view.grant()
    const expired = createObservationService({
      desktop: desktop(),
      bridge: helper,
      screen: view,
      displays,
      now: () => 5_000
    })
    const stale = await expired.observe({ includeImage: true, windowId: '7' })
    expect(stale.errorCode).toBe('stale_snapshot')
    expect(stale.observation?.image).toBeUndefined()
    const secret = observed()
    secret.targets = [{ id: 'pw', role: 'AXSecureTextField', name: 'Password', enabled: true }]
    const blocked = createObservationService({
      desktop: desktop(secret),
      bridge: helper,
      screen: view,
      displays,
      now: () => 1_000
    })
    const hidden = await blocked.observe({ includeImage: true, windowId: '7' })
    expect(hidden.status).toBe('blocked_sensitive')
    expect(hidden.observation?.targets).toEqual([])
    expect(helper.calls).toEqual([])
  })

  it('discards a picture of the wrong window and deletes the file', async () => {
    const file = stage(png)
    const helper = bridge(async () => geometry(file, { windowId: '99' }))
    const view = screen()
    view.grant()
    const service = createObservationService({
      desktop: desktop(),
      bridge: helper,
      screen: view,
      displays,
      now: () => 1_000
    })
    const result = await service.observe({ includeImage: true, windowId: '7' })
    expect(result.errorCode).toBe('wrong_window')
    expect(result.observation?.image).toBeUndefined()
    expect(existsSync(file.filePath)).toBe(false)
  })

  it('discards a blank frame and a protected capture without keeping bytes', async () => {
    const helper = bridge(async () => {
      throw new HelperCallError('protected_capture', 'The capture was blank, so I discarded it.')
    })
    const view = screen()
    view.grant()
    const service = createObservationService({
      desktop: desktop(),
      bridge: helper,
      screen: view,
      displays,
      now: () => 1_000
    })
    const blank = await service.observe({ includeImage: true, windowId: '7' })
    expect(blank.errorCode).toBe('protected_capture')
    expect(blank.observation?.image).toBeUndefined()
    const locked = createObservationService({
      desktop: desktop(),
      bridge: bridge(async () => {
        throw new HelperCallError('protected_context', "I can't work with that secure screen.")
      }),
      screen: view,
      displays,
      now: () => 1_000
    })
    const refused = await locked.observe({ includeImage: true, windowId: '7' })
    expect(refused.status).toBe('blocked_sensitive')
    expect(JSON.stringify(refused.observation)).not.toContain('Password')
  })

  it('deletes the file when the picture is too large, unreadable, or outside the capture directory', async () => {
    const view = screen()
    view.grant()
    const huge = stage(Buffer.alloc(1_500_001, 1))
    const oversized = createObservationService({
      desktop: desktop(),
      bridge: bridge(async () => geometry(huge, { byteLength: 1_500_001 })),
      screen: view,
      displays,
      now: () => 1_000
    })
    const tooBig = await oversized.observe({ includeImage: true, windowId: '7' })
    expect(tooBig.errorCode).toBe('capture_too_large')
    expect(existsSync(huge.filePath)).toBe(false)

    const junkBytes = Buffer.from('not a picture')
    const junk = stage(junkBytes)
    const broken = createObservationService({
      desktop: desktop(),
      bridge: bridge(async () => geometry(junk, { byteLength: junkBytes.length })),
      screen: view,
      displays,
      now: () => 1_000
    })
    const unreadable = await broken.observe({ includeImage: true, windowId: '7' })
    expect(unreadable.observation?.image).toBeUndefined()
    expect(existsSync(junk.filePath)).toBe(false)

    const outside = join(tmpdir(), `companion-keep-${Date.now()}.txt`)
    writeFileSync(outside, 'leave this file')
    const directory = mkdtempSync(join(tmpdir(), 'companion-capture-'))
    chmodSync(directory, 0o700)
    const link = join(directory, 'shot.png')
    symlinkSync(outside, link)
    const escaped = createObservationService({
      desktop: desktop(),
      bridge: bridge(async () => geometry({ directory, filePath: link }, { byteLength: 15 })),
      screen: view,
      displays,
      now: () => 1_000
    })
    const rejected = await escaped.observe({ includeImage: true, windowId: '7' })
    expect(rejected.observation?.image).toBeUndefined()
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(link)).toBe(false)
  })

  it('stops the picture when sharing is revoked and does not take the next one', async () => {
    const view = screen()
    view.grant()
    let hanging = false
    const helper = bridge(
      (signal) =>
        new Promise((_resolve, reject) => {
          hanging = true
          signal?.addEventListener('abort', () => {
            reject(new HelperCallError('aborted', 'Screen access has stopped.', true))
          })
        })
    )
    const service = createObservationService({
      desktop: desktop(),
      bridge: helper,
      screen: view,
      displays,
      now: () => 1_000
    })
    const pending = service.observe({ includeImage: true, windowId: '7' })
    await waitUntil(() => hanging)
    expect(view.status().captureActive).toBe(true)
    view.revoke()
    const stopped = await pending
    expect(stopped.status).toBe('cancelled')
    expect(stopped.observation?.image).toBeUndefined()
    expect(view.status()).toEqual({ access: 'off', captureActive: false })
    const later = await service.observe({ includeImage: true, windowId: '7' })
    expect(later.summary).toContain('did not take a picture')
    expect(helper.calls).toEqual(['desktop.captureWindow'])
  })
})

async function waitUntil(ready: () => boolean): Promise<void> {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 1_000) {
      throw new Error('timed out waiting')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
