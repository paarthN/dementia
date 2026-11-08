import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPlaywrightAdapter } from '../src/main/agent/ports/PlaywrightAdapter'
import { createNativeMacAdapter } from '../src/main/agent/ports/NativeMacAdapter'
import { createMacOsBridge, resolveHelperCommand } from '../src/main/services/osBridge'
import { benchmarkOutcome, type BenchmarkMark } from '../src/shared/releaseBenchmark'
import { systemSettingsUrl } from '../src/shared/systemSettings'

const live = process.env.COMPANION_RELEASE_BENCHMARK === '1'
const helper = resolveHelperCommand(process.env, resolve(__dirname, '../../..'))

interface BenchmarkRow {
  task: string
  mark: BenchmarkMark
  status: string
  steps: number
  latencyMs: number
  confirmations: number
  recovery: string
}

function openPath(command: string, args: string[]): Promise<void> {
  return new Promise((resolveOpen, reject) => {
    execFile(command, args, (error) => (error ? reject(error) : resolveOpen()))
  })
}

describe.skipIf(!live || !helper)('release benchmark on this Mac', () => {
  it('records TextEdit, Finder, System Settings, and Agent Browser', async () => {
    const bridge = createMacOsBridge(helper ?? { command: 'true' })
    const adapter = createNativeMacAdapter({ bridge })
    const rows: BenchmarkRow[] = []
    const directory = mkdtempSync(join(tmpdir(), 'companion-benchmark-'))
    const note = join(directory, 'note.txt')
    writeFileSync(note, '')
    const started = Date.now()
    try {
      const textStarted = Date.now()
      let textSteps = 1
      await openPath('/usr/bin/open', ['-a', 'TextEdit', note])
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 800))
      textSteps += 1
      const opened = await adapter.listWindows({ bundleId: 'com.apple.TextEdit' })
      const textEdit = opened.windows?.[0]
      let textStatus = opened.status
      if (textEdit?.bundleId) {
        textSteps += 1
        const seen = await adapter.observe({ windowId: textEdit.windowId })
        textStatus = seen.status
        const field = seen.observation?.targets.find(
          (target) => target.role === 'AXTextArea' && target.enabled
        )
        const textAreas =
          seen.observation?.targets.filter((target) => target.role === 'AXTextArea').length ?? 0
        if (seen.status === 'success_verified' && textAreas === 1 && field && seen.observation) {
          textSteps += 1
          const typed = await adapter.setText({
            snapshotId: seen.observation.snapshotId,
            targetId: field.id,
            windowId: seen.observation.window.id,
            bundleId: seen.observation.app.bundleId ?? textEdit.bundleId,
            name: field.name,
            role: field.role,
            text: 'Hello from Companion'
          })
          textStatus = typed.status
        }
      }
      rows.push({
        task: 'TextEdit type into a temporary note',
        mark: benchmarkOutcome(textStatus),
        status: textStatus,
        steps: textSteps,
        latencyMs: Date.now() - textStarted,
        confirmations: 0,
        recovery: 'The note was not saved. Close TextEdit without saving if it is still open.'
      })

      const finderStarted = Date.now()
      const finder = (await adapter.listWindows({ bundleId: 'com.apple.finder' })).windows?.[0]
      let finderStatus = 'failed'
      if (finder?.bundleId) {
        const focused = await adapter.focusWindow({
          windowId: finder.windowId,
          bundleId: finder.bundleId
        })
        finderStatus = focused.status
      }
      rows.push({
        task: 'Finder focus',
        mark: benchmarkOutcome(finderStatus),
        status: finderStatus,
        steps: finder ? 2 : 1,
        latencyMs: Date.now() - finderStarted,
        confirmations: 0,
        recovery: 'Bring the app you were using back to the front.'
      })

      const settingsStarted = Date.now()
      let settingsStatus = 'failed'
      try {
        await openPath('/usr/bin/open', [systemSettingsUrl('display')])
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200))
        const settings = (await adapter.listWindows({ bundleId: 'com.apple.systempreferences' }))
          .windows?.[0]
        if (settings) {
          const seen = await adapter.observe({ windowId: settings.windowId })
          settingsStatus = seen.status
        }
      } catch {
        settingsStatus = 'failed'
      }
      rows.push({
        task: 'System Settings Displays page',
        mark: benchmarkOutcome(settingsStatus),
        status: settingsStatus,
        steps: 2,
        latencyMs: Date.now() - settingsStarted,
        confirmations: 0,
        recovery: 'System Settings was opened. No Mac setting was changed.'
      })

      const browserStarted = Date.now()
      const profileDir = mkdtempSync(join(tmpdir(), 'companion-benchmark-browser-'))
      const server = createServer((_request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end('<!doctype html><title>Library search</title><body><p>Fixture</p></body>')
      })
      const origin = await new Promise<string>((resolveOrigin) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          const port = typeof address === 'object' && address ? address.port : 0
          resolveOrigin(`http://127.0.0.1:${port}`)
        })
      })
      const browser = createPlaywrightAdapter({
        profileDir,
        headed: true,
        fixtureOrigins: [origin]
      })
      const launched = await browser.launch({})
      const browserPage =
        launched.status === 'success_verified'
          ? await browser.open({ url: `${origin}/` })
          : launched
      await browser.close()
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()))
      })
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      rows.push({
        task: 'Agent Browser local fixture',
        mark: benchmarkOutcome(browserPage.status),
        status: browserPage.status,
        steps: launched.status === 'success_verified' ? 2 : 1,
        latencyMs: Date.now() - browserStarted,
        confirmations: 0,
        recovery: 'Agent Browser was closed. It did not use Safari or Chrome.'
      })
    } finally {
      bridge.close()
    }

    const marks = rows.map((row) => row.mark)
    writeFileSync(
      join(tmpdir(), 'companion-release-benchmark.json'),
      JSON.stringify({
        rows,
        elapsedMs: Date.now() - started,
        modelRequests: 0,
        estimatedCostUsd: 0,
        confirmations: 0
      })
    )
    expect(rows).toHaveLength(4)
    expect(
      marks.every((mark) => mark === 'success' || mark === 'partial' || mark === 'failure')
    ).toBe(true)
    expect(rows.some((row) => row.mark === 'success' && row.status !== 'success_verified')).toBe(
      false
    )
  }, 90_000)
})
