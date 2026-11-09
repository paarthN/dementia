import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startProxy } from '../../../backend/assistant-proxy/server.mjs'
import { FakeAgentProvider, runAgent } from '../src/main/agent/AgentRunner'
import { createAgentProviderClient } from '../src/main/agent/AgentProviderClient'
import { browserObservationForAgent, prepareModelObservation } from '../src/main/agent/AgentPrompt'
import { AgentSessionController } from '../src/main/agent/AgentSessionController'
import { AuthorizedToolExecutor } from '../src/main/agent/AuthorizedToolExecutor'
import { createPlaywrightAdapter } from '../src/main/agent/ports/PlaywrightAdapter'
import { createToolRegistry, type ToolContext } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'
import { benchmarkOutcome, type BenchmarkMark } from '../src/shared/releaseBenchmark'

const live =
  process.env.COMPANION_BROWSER_LLM_BENCHMARK === '1' &&
  Boolean(process.env.ASSISTANT_API_KEY) &&
  Boolean(process.env.COMPANION_AGENT_MODEL)

const fixtureHtml = `<!doctype html>
<html>
<head><title>Library desk</title></head>
<body>
  <main>
    <h1>Library desk</h1>
    <form id="search" action="/results" method="get">
      <label for="q">Search</label>
      <input id="q" name="q" />
      <button type="submit">Search the catalog</button>
    </form>
    <p id="filled">empty</p>
    <p id="sent">form waiting</p>
    <label for="note">Short note</label>
    <textarea id="note" rows="4" cols="40"></textarea>
    <p id="note-echo">note empty</p>
    <button type="button" id="reveal">Show the note</button>
    <p id="reveal-text" hidden>The nearest library is on Oak Street.</p>
    <ul aria-label="Search results">
      <li><a href="/one" id="a1">City Library</a></li>
      <li><a href="/two" id="a2">County Library</a></li>
      <li><a href="/three" id="a3">State Library</a></li>
    </ul>
    <p id="picked">none</p>
    <button type="button" id="save-main">Save</button>
    <div role="dialog" aria-label="Confirm save">
      <p>Save this draft?</p>
      <button type="button" id="save-dialog">Save</button>
    </div>
    <p id="saved">unsaved</p>
    <a href="/results">Results page</a>
  </main>
  <script>
    document.getElementById('search').addEventListener('submit', (event) => {
      event.preventDefault()
      document.getElementById('sent').textContent = 'form sent'
    })
    document.getElementById('q').addEventListener('input', (event) => {
      document.getElementById('filled').textContent = event.target.value
    })
    document.getElementById('note').addEventListener('input', (event) => {
      document.getElementById('note-echo').textContent = event.target.value
    })
    document.getElementById('reveal').addEventListener('click', () => {
      document.getElementById('reveal-text').hidden = false
    })
    for (const id of ['a1', 'a2', 'a3']) {
      document.getElementById(id).addEventListener('click', (event) => {
        event.preventDefault()
        document.getElementById('picked').textContent = id
      })
    }
    document.getElementById('save-main').addEventListener('click', () => {
      document.getElementById('saved').textContent = 'main save'
    })
    document.getElementById('save-dialog').addEventListener('click', () => {
      document.getElementById('saved').textContent = 'dialog save'
    })
  </script>
</body>
</html>`

interface BenchmarkTask {
  id: string
  goal: string
  evidence: (text: string, url: string) => boolean
}

interface BenchmarkRow {
  task: string
  mark: BenchmarkMark
  status: string
  summary: string
  latencyMs: number
  evidence: boolean
  progress: string[]
}

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-browser-llm-')), 'test.sqlite'))
}

const tasks: BenchmarkTask[] = [
  {
    id: 'fill-search',
    goal: 'In Agent Browser, open the library desk page, type oak into the Search field, and do not submit the form.',
    evidence: (text) => /\boak\b/i.test(text) && !/form sent/i.test(text)
  },
  {
    id: 'reveal-note',
    goal: 'In Agent Browser, press Show the note so the Oak Street sentence appears.',
    evidence: (text) => /Oak Street/i.test(text)
  },
  {
    id: 'second-result',
    goal: 'In Agent Browser, open the second item in the Search results list (County Library).',
    evidence: (text) => /\ba2\b/.test(text)
  },
  {
    id: 'dialog-save',
    goal: 'In Agent Browser, press the Save button inside the Confirm save dialog (role dialog). Do not press the other Save outside the dialog.',
    evidence: (text) => /dialog save/i.test(text)
  },
  {
    id: 'open-results',
    goal: 'In Agent Browser, open the Results page link and confirm the results page text is visible.',
    evidence: (text, url) => /\/results/.test(url) || /One library is on Oak Street/i.test(text)
  }
]

describe('browser LLM benchmark harness', () => {
  let origin = ''
  let profileDir = ''
  let closeServer: () => Promise<void> = async () => undefined

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'companion-browser-llm-harness-'))
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if ((request.url ?? '').startsWith('/results')) {
        response.end(
          '<!doctype html><title>Results</title><body><p>One library is on Oak Street.</p></body>'
        )
        return
      }
      response.end(fixtureHtml)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }, 20_000)

  afterAll(async () => {
    await closeServer()
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('runs one fixture task through AuthorizedToolExecutor without a paid model', async () => {
    const browser = createPlaywrightAdapter({
      profileDir,
      headed: false,
      fixtureOrigins: [origin],
      snapshotTtlMs: 60_000
    })
    try {
      expect((await browser.launch({})).status).toBe('success_verified')
      const opened = await browser.open({ url: `${origin}/` })
      expect(opened.status).toBe('success_verified')
      const seen = await browser.observe({})
      const search = seen.observation?.targets.find(
        (item) => item.role === 'textbox' && item.name === 'Search'
      )
      expect(search?.id).toBeTruthy()
      const outcome = await runAgent({
        goal: tasks[0]!.goal,
        provider: new FakeAgentProvider([
          {
            type: 'tool_call',
            tool: 'task.setGoalChecks',
            args: {
              checks: [
                {
                  id: 'typed',
                  label: 'Search field contains oak',
                  anyTools: ['browser.fill'],
                  textIncludes: 'oak'
                }
              ]
            }
          },
          {
            type: 'tool_call',
            tool: 'browser.fill',
            args: {
              snapshotId: seen.observation?.snapshotId ?? '',
              targetId: search?.id ?? '',
              text: 'oak'
            }
          },
          { type: 'final', text: 'Typed oak into Search.' }
        ]),
        executor: new AuthorizedToolExecutor(createToolRegistry()),
        session: new AgentSessionController(),
        context: (signal) => toolContext(signal, browser),
        observe: (signal) => observeBrowser(browser, signal),
        waitForApproval: async (approval) => ({ approved: true, liveTarget: approval.target })
      })
      const page = await browser.observe({})
      const text = page.observation?.untrustedText ?? ''
      expect(outcome.summary).toMatch(/oak|typed|Search|done|finished/i)
      expect(outcome.actionOutcome).toBe('success_verified')
      expect(tasks[0]!.evidence(text, page.observation?.url ?? '')).toBe(true)
    } finally {
      await browser.close()
    }
  }, 60_000)
})

describe.skipIf(!live)('browser LLM benchmark', () => {
  let origin = ''
  let profileDir = ''
  let proxyOrigin = ''
  let closeServer: () => Promise<void> = async () => undefined
  let closeProxy: () => Promise<void> = async () => undefined

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'companion-browser-llm-live-'))
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if ((request.url ?? '').startsWith('/results')) {
        response.end(
          '<!doctype html><title>Results</title><body><p>One library is on Oak Street.</p></body>'
        )
        return
      }
      response.end(fixtureHtml)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })

    const proxy = startProxy({
      apiKey: process.env.ASSISTANT_API_KEY,
      agentModel: process.env.COMPANION_AGENT_MODEL,
      maxPerMinute: 120,
      timeoutMs: 60_000
    })
    const proxyAddress = (await proxy.listen(0)) as AddressInfo
    proxyOrigin = `http://127.0.0.1:${proxyAddress.port}`
    closeProxy = () => proxy.close()
  }, 30_000)

  afterAll(async () => {
    await closeProxy()
    await closeServer()
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it(
    'completes several different browser tasks with the configured model',
    async () => {
      const rows: BenchmarkRow[] = []
      const provider = createAgentProviderClient({
        origin: () => proxyOrigin,
        timeoutMs: 60_000
      })

      for (const task of tasks) {
        const browser = createPlaywrightAdapter({
          profileDir: await mkdtemp(join(profileDir, `${task.id}-`)),
          headed: false,
          fixtureOrigins: [origin],
          snapshotTtlMs: 60_000
        })
        const started = Date.now()
        try {
          await browser.launch({})
          await browser.open({ url: `${origin}/` })
          const outcome = await runAgent({
            goal: `${task.goal} The page is already open at ${origin}/ in Agent Browser. Use browser tools only. Call task.setGoalChecks early.`,
            provider,
            executor: new AuthorizedToolExecutor(createToolRegistry()),
            session: new AgentSessionController(),
            context: (signal) => toolContext(signal, browser),
            observe: (signal) => observeBrowser(browser, signal),
            waitForApproval: async (approval) => ({ approved: true, liveTarget: approval.target }),
            budget: {
              maxActions: 16,
              maxModelTurns: 24,
              deadlineMs: 4 * 60_000,
              maxIdenticalFailures: 2
            }
          })
          const page = await browser.observe({})
          const text = page.observation?.untrustedText ?? ''
          const url = page.observation?.url ?? ''
          const evidence = task.evidence(text, url)
          // A task counts as done only when the page proves the work happened AND the
          // run itself ended verified. Scoring page evidence alone hid that every run
          // was finishing as cancelled or out of budget.
          const mark: BenchmarkMark = !evidence
            ? 'failure'
            : benchmarkOutcome(outcome.actionOutcome) === 'success'
              ? 'success'
              : 'partial'
          rows.push({
            task: task.id,
            mark,
            status: outcome.actionOutcome,
            summary: outcome.summary.slice(0, 240),
            latencyMs: Date.now() - started,
            evidence,
            progress: outcome.progress.map((entry) => entry.summary).slice(0, 20)
          })
        } finally {
          await browser.close()
        }
      }

      const reportPath = join(tmpdir(), 'companion-browser-llm-benchmark.json')
      writeFileSync(reportPath, JSON.stringify({ origin, proxyOrigin, rows }, null, 2))
      const successes = rows.filter((row) => row.mark === 'success').length
      const rate = successes / rows.length
      expect(rows.length).toBe(tasks.length)
      expect(rate).toBeGreaterThanOrEqual(0.8)
    },
    15 * 60_000
  )
})

function toolContext(
  signal: AbortSignal,
  browser: ReturnType<typeof createPlaywrightAdapter>
): ToolContext {
  return {
    db: database(),
    run: async () => 0,
    now: () => new Date(),
    timeZone: 'UTC',
    screenPermission: true,
    allowedBundleIds: () => [],
    signal,
    browser
  }
}

async function observeBrowser(
  browser: ReturnType<typeof createPlaywrightAdapter>,
  signal: AbortSignal
): Promise<ReturnType<typeof browserObservationForAgent>> {
  if (!browser.isOpen()) {
    return prepareModelObservation(
      {
        snapshotId: 'browser-closed',
        appName: 'Agent Browser',
        capturedAtUtc: new Date().toISOString(),
        untrustedText: 'Agent Browser is not open.'
      },
      false
    )
  }
  const page = await browser.observe({}, { signal })
  if (!page.observation) {
    return prepareModelObservation(
      {
        snapshotId: 'browser-unread',
        appName: 'Agent Browser',
        capturedAtUtc: new Date().toISOString(),
        untrustedText: page.summary
      },
      false
    )
  }
  return browserObservationForAgent(page.observation, false)
}
