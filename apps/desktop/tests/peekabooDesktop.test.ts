import { describe, expect, it } from 'vitest'
import { observationForAgent } from '../src/main/agent/AgentPrompt'
import {
  createPeekabooDesktop,
  type PeekabooResult,
  type PeekabooRunner
} from '../src/main/agent/ports/PeekabooDesktopAdapter'
import { pageObservationSummary, pageTextWithOcr } from '../src/main/agent/ports/PlaywrightAdapter'

function ok(stdout: unknown): PeekabooResult {
  return { code: 0, stdout: JSON.stringify(stdout), stderr: '', aborted: false }
}

function runner(responses: PeekabooResult[]): PeekabooRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run: PeekabooRunner & { calls: string[][] } = async (args, options) => {
    calls.push([...args])
    if (options.signal?.aborted) {
      return { code: null, stdout: '', stderr: '', aborted: true }
    }
    return responses.shift() ?? { code: 1, stdout: '', stderr: 'missing', aborted: false }
  }
  run.calls = calls
  return run
}

const see = {
  data: {
    snapshot_id: 'snap-1',
    window_id: '42',
    app_name: 'Notes',
    bundle_id: 'com.apple.Notes',
    pid: 9,
    ui_elements: [{ id: 'note-body', role: 'AXWebArea', label: 'Note', enabled: true }]
  }
}

describe('Peekaboo desktop adapter', () => {
  it('pastes approved text into a web area and reads the OCR back', async () => {
    const run = runner([
      ok(see),
      ok({ data: { ocr_text: 'The University of California, San Diego is a public university.' } }),
      ok({})
    ])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    const seen = await port.observe({})
    const typed = await port.setText({
      snapshotId: 'snap-1',
      targetId: 'note-body',
      windowId: '42',
      bundleId: 'com.apple.Notes',
      name: 'Note',
      role: 'AXTextArea',
      text: 'The University of California, San Diego is a public university.'
    })
    expect(typed.status).toBe('success_verified')
    // The typed text never shows up in the window's visible text, so without it in the
    // summary a goal check asking whether it landed has no evidence to read.
    expect(typed.summary).toContain('The University of California, San Diego is a public')
    expect(run.calls[2]).toEqual([
      'set-value',
      '--on',
      'note-body',
      '--snapshot',
      'snap-1',
      '--value',
      'The University of California, San Diego is a public university.'
    ])
    expect(seen.observation?.contextText).toContain('public university')
    const model = observationForAgent(seen.observation!, false)
    expect(model?.untrustedText).toContain('public university')
  })

  it('falls back to paste when set-value fails and OCR cannot read Notes', async () => {
    const run = runner([
      ok(see),
      ok({ data: { ocr_text: 'short' } }),
      {
        code: 1,
        stdout: JSON.stringify({ success: false, error: { message: 'set-value failed' } }),
        stderr: '',
        aborted: false
      },
      ok({}),
      ok({}),
      ok({ data: {} }),
      ok({ data: { ui_elements: [] } })
    ])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    await port.observe({})
    const typed = await port.setText({
      snapshotId: 'snap-1',
      targetId: 'note-body',
      windowId: '42',
      bundleId: 'com.apple.Notes',
      name: 'Note',
      role: 'AXTextArea',
      text: 'San Diego is a city on the Pacific.'
    })
    expect(typed.status).toBe('success_verified')
    // The typed text never shows up in the window's visible text, so without it in the
    // summary a goal check asking whether it landed has no evidence to read.
    expect(typed.summary).toContain('San Diego is a city on the Pacific.')
    expect(run.calls.some((args) => args[0] === 'paste' && args.includes('--foreground'))).toBe(
      true
    )
  })

  it('refuses a command chord outside the short list and does not launch Peekaboo', async () => {
    const run = runner([ok({})])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    const refused = await port.keyPress({
      chord: 'cmd+shift+t',
      windowId: '42',
      bundleId: 'com.apple.Notes',
      processId: 9
    })
    expect(refused.status).toBe('failed')
    expect(run.calls).toEqual([])
    const allowed = await port.keyPress({
      chord: 'cmd+n',
      windowId: '42',
      bundleId: 'com.apple.Notes',
      processId: 9
    })
    expect(allowed.status).toBe('success_verified')
    expect(run.calls[0]).toEqual(['press', 'cmd+n', '--window-id', '42', '--foreground'])
  })

  it('stops before the action when the task is already aborted', async () => {
    const run = runner([])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    const signal = new AbortController()
    signal.abort()
    const stopped = await port.clickPoint(
      { snapshotId: 'snap-1', windowId: '42', x: 3, y: 4 },
      { signal: signal.signal }
    )
    expect(stopped.status).toBe('cancelled')
    expect(run.calls).toEqual([])
  })

  it('reports a missing binary and a permission failure without adding a new prompt', async () => {
    const missing = runner([
      { code: null, stdout: '', stderr: 'spawn peekaboo ENOENT', aborted: false }
    ])
    const { port } = createPeekabooDesktop({ run: missing, now: () => 1_000 })
    expect((await port.listWindows({})).summary).toContain('not installed')
    const denied = runner([
      { code: 1, stdout: '', stderr: 'Accessibility permission denied', aborted: false }
    ])
    const blocked = createPeekabooDesktop({ run: denied, now: () => 1_000 })
    const outcome = await blocked.port.focusWindow({ windowId: '42', bundleId: 'com.apple.Notes' })
    expect(outcome.status).toBe('needs_permission')
  })

  it('clicks one fresh snapshot point and skips OCR when the window already has text', async () => {
    const long = 'A'.repeat(90)
    const run = runner([
      ok({
        data: {
          snapshot_id: 'snap-2',
          window_id: '7',
          app_name: 'Maps',
          ui_elements: [{ id: 'map', role: 'AXGroup', label: long, enabled: true }]
        }
      }),
      ok({})
    ])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    await port.observe({ windowId: '7' })
    const clicked = await port.clickPoint({ snapshotId: 'snap-2', windowId: '7', x: 12.4, y: 8.2 })
    expect(clicked.status).toBe('changed_but_unverified')
    expect(run.calls).toEqual([
      ['see', '--json', '--window-id', '7'],
      ['click', '--at', '12,8', '--snapshot', 'snap-2', '--window-id', '7', '--global']
    ])
  })

  it('reads a current Peekaboo snapshot and reports the command error', async () => {
    const run = runner([
      ok({
        success: true,
        data: {
          snapshot_id: 'ps1_abc',
          application_name: 'Notes',
          window_title: 'Untitled',
          coordinate_context: { window: { window_id: 244379, title: 'Untitled' } },
          observation: {
            state_snapshot: { frontmost_bundle_identifier: 'com.apple.Notes' }
          },
          ui_elements: [
            {
              id: 'elem_1',
              role: 'text area',
              ax_role: 'AXTextArea',
              label: 'Note body',
              bounds: { x: 1, y: 2, width: 3, height: 4 },
              is_enabled: true
            }
          ]
        }
      })
    ])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    const seen = await port.observe({})
    expect(seen.observation?.app).toMatchObject({ name: 'Notes', bundleId: 'com.apple.Notes' })
    expect(seen.observation?.window.id).toBe('244379')
    expect(seen.observation?.targets[0]).toMatchObject({
      role: 'AXTextArea',
      bounds: { x: 1, y: 2, width: 3, height: 4 }
    })
    const failedRun = runner([
      {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          data: null,
          error: { message: '--no-screenshot requires --tree' }
        }),
        stderr: '',
        aborted: false
      }
    ])
    const failed = await createPeekabooDesktop({ run: failedRun, now: () => 1_000 }).port.observe(
      {}
    )
    expect(failed.summary).toBe('--no-screenshot requires --tree')
  })

  it('reads a Chrome window whose title Peekaboo will not compare', async () => {
    const run = runner([
      {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          data: null,
          error: {
            message:
              'The desktop observation provider returned inconsistent response evidence: window-context window title.'
          }
        }),
        stderr: '',
        aborted: false
      },
      ok({
        data: {
          snapshot_id: 'ps1_tree',
          application_name: 'Google Chrome for Testing',
          window_title: 'San Diego - Wikipedia',
          ui_elements: [{ id: 'elem_1', role: 'AXGroup', label: 'A'.repeat(90), enabled: true }]
        }
      }),
      ok({
        data: {
          windows: [
            {
              window_id: '77',
              title: 'San Diego - Wikipedia',
              app_name: 'Google Chrome for Testing',
              bundle_id: 'com.google.Chrome',
              pid: 55
            }
          ]
        }
      })
    ])
    const { port } = createPeekabooDesktop({ run, now: () => 1_000 })
    const seen = await port.observe({})
    expect(seen.status).toBe('success_verified')
    expect(seen.observation?.app.name).toBe('Google Chrome for Testing')
    expect(seen.observation?.window.id).toBe('77')
    expect(run.calls).toEqual([
      ['see', '--json'],
      ['see', '--json', '--tree', '--no-screenshot'],
      ['window', 'list', '--json']
    ])
  })

  it('looks again when the reading expired during confirmation', async () => {
    let clock = 1_000
    const body = {
      id: 'note-body',
      role: 'AXTextArea',
      label: 'A'.repeat(90),
      enabled: true
    }
    const run = runner([
      ok({
        data: { snapshot_id: 'snap-old', window_id: '42', app_name: 'Notes', ui_elements: [body] }
      }),
      ok({
        data: { snapshot_id: 'snap-new', window_id: '42', app_name: 'Notes', ui_elements: [body] }
      }),
      ok({})
    ])
    const { port } = createPeekabooDesktop({ run, now: () => clock, ttlMs: 3_000 })
    await port.observe({})
    clock = 6_000
    const typed = await port.setText({
      snapshotId: 'snap-old',
      targetId: 'note-body',
      windowId: '42',
      bundleId: 'com.apple.Notes',
      name: 'A'.repeat(90),
      role: 'AXTextArea',
      text: 'San Diego is a city.'
    })
    expect(typed.status).toBe('success_verified')
    expect(run.calls[1]).toEqual(['see', '--json', '--window-id', '42'])
    expect(run.calls[2]?.[0]).toBe('set-value')
  })
})

describe('page text for the model', () => {
  it('keeps the first lines of a page in the browser summary', () => {
    expect(pageObservationSummary('San Diego', 'The city sits on the coast.')).toBe(
      'I am looking at San Diego. First sentences: The city sits on the coast.'
    )
  })

  it('keeps enough page text for the first sentences', () => {
    const long = 'San Diego is a city. '.repeat(40)
    expect(pageObservationSummary('San Diego', long)).toContain('First sentences:')
    expect(pageObservationSummary('San Diego', long)).toContain('San Diego is a city.')
  })

  it('asks Peekaboo for text when the page is a map or nearly empty', async () => {
    const calls: string[] = []
    const read = async (): Promise<string> => {
      calls.push('ocr')
      return 'Head north on North Harbor Drive.'
    }
    const maps = await pageTextWithOcr('Google', 'https://www.google.com/maps/dir/a/b', read)
    const article = await pageTextWithOcr(
      'A'.repeat(500),
      'https://en.wikipedia.org/wiki/San_Diego',
      read
    )
    expect(maps).toContain('North Harbor Drive')
    expect(article).not.toContain('North Harbor Drive')
    expect(calls).toEqual(['ocr'])
  })
})
