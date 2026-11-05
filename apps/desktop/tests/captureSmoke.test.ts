import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createObservationService, observationForModel } from '../src/main/agent/ObservationService'
import { createNativeMacAdapter } from '../src/main/agent/ports/NativeMacAdapter'
import { createScreenCoordinator } from '../src/main/services/screenCoordinator'
import { createMacOsBridge, resolveHelperCommand } from '../src/main/services/osBridge'

const live = process.env['COMPANION_CAPTURE_SMOKE'] === '1'
const helperCommand = resolveHelperCommand(process.env, resolve(__dirname, '../../..'))

describe.skipIf(!live || !helperCommand)('hands-on window capture', () => {
  it('captures one TextEdit window and keeps the pixels only in memory', async () => {
    const bridge = createMacOsBridge(helperCommand ?? { command: 'true' })
    const adapter = createNativeMacAdapter({ bridge })
    const screen = createScreenCoordinator({ bridge })
    const service = createObservationService({
      desktop: adapter,
      bridge,
      screen
    })
    const directory = mkdtempSync(join(tmpdir(), 'companion-note-'))
    const note = join(directory, 'note.txt')
    writeFileSync(note, 'Hello from Companion\n')
    const captureDir = join(tmpdir(), 'companion-captures')
    const before = existsSync(captureDir) ? readdirSync(captureDir) : []
    screen.grant()
    try {
      execFileSync('open', ['-a', 'TextEdit', note])
      let textEdit: { windowId: string; bundleId?: string } | undefined
      for (let attempt = 0; attempt < 8 && !textEdit?.windowId; attempt += 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
        const opened = await adapter.listWindows({ bundleId: 'com.apple.TextEdit' })
        console.info(
          'capture-smoke-list',
          opened.status,
          opened.errorCode ?? '',
          opened.windows?.length ?? 0
        )
        textEdit = opened.windows?.[0]
      }
      expect(textEdit?.windowId).toBeTruthy()
      const seen = await service.observe({
        ...(textEdit?.windowId ? { windowId: textEdit.windowId } : {}),
        includeImage: true
      })
      console.info(
        'capture-smoke',
        seen.status,
        seen.errorCode ?? '',
        seen.summary,
        seen.observation?.app.name ?? '',
        seen.observation?.image?.width ?? 0,
        seen.observation?.image?.height ?? 0
      )
      expect(seen.status).toBe('success_verified')
      const bytes = seen.observation?.image?.bytes
      expect(bytes && bytes.byteLength > 8).toBe(true)
      const shared = observationForModel(seen.observation ?? seen.observation!)
      expect(shared.image).toBeUndefined()
      expect(shared.imageIncluded).toBe(false)
      const probe = join(tmpdir(), 'companion-phase3-capture.png')
      writeFileSync(probe, Buffer.from(bytes ?? []))
      const pixels = samplePng(probe)
      console.info('capture-smoke-pixels', pixels)
      unlinkSync(probe)
      expect(pixels.max).toBeGreaterThan(40)
      expect(pixels.max - pixels.min).toBeGreaterThan(12)
      const after = existsSync(captureDir) ? readdirSync(captureDir) : []
      expect(after.filter((name) => !before.includes(name))).toEqual([])
    } finally {
      screen.revoke()
      bridge.close()
    }
  }, 20_000)
})

function samplePng(file: string): { width: number; height: number; min: number; max: number } {
  const bmp = `${file}.bmp`
  execFileSync('sips', ['-s', 'format', 'bmp', file, '--out', bmp])
  try {
    const bytes = readFileSync(bmp)
    const offset = bytes.readUInt32LE(10)
    const width = bytes.readInt32LE(18)
    const height = Math.abs(bytes.readInt32LE(22))
    const bits = bytes.readUInt16LE(28)
    const channels = bits / 8
    let min = 255
    let max = 0
    const rowStride = Math.ceil((width * channels) / 4) * 4
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 40))) {
      for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 40))) {
        const index = offset + y * rowStride + x * channels
        const blue = bytes[index] ?? 0
        const green = bytes[index + 1] ?? 0
        const red = bytes[index + 2] ?? 0
        const luminance = Math.round((red + green + blue) / 3)
        min = Math.min(min, luminance)
        max = Math.max(max, luminance)
      }
    }
    return { width, height, min, max }
  } finally {
    unlinkSync(bmp)
  }
}
