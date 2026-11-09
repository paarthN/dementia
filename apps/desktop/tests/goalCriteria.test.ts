import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  evaluateGoalCriteria,
  keepGoingMessage,
  parseGoalCriteria,
  unfinishedGoalMessage
} from '../src/main/agent/GoalCriteria'
import { FakeAgentProvider, runFakeAgent } from '../src/main/agent/AgentRunner'
import { AgentSessionController } from '../src/main/agent/AgentSessionController'
import { AuthorizedToolExecutor } from '../src/main/agent/AuthorizedToolExecutor'
import { createToolRegistry, type ToolContext } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-goal-')), 'test.sqlite'))
}

describe('goal criteria evidence', () => {
  it('rejects checks that have no evidence rule', () => {
    expect(parseGoalCriteria([{ id: 'a', label: 'Done somehow' }])).toBeNull()
  })

  it('normalizes common model spellings for goal checks', () => {
    const criteria = parseGoalCriteria({
      checks: [
        {
          description: 'Search shows oak',
          any_tools: ['browser.fill'],
          text_includes: 'oak'
        }
      ]
    })
    expect(criteria).toEqual([
      {
        id: 'search_shows_oak',
        label: 'Search shows oak',
        anyTools: ['browser.fill'],
        textIncludes: 'oak'
      }
    ])
  })

  it('requires every evidence rule on a check', () => {
    const criteria = parseGoalCriteria([
      {
        id: 'open',
        label: 'Page is open',
        anyTools: ['browser.open'],
        textIncludes: 'San Diego'
      },
      {
        id: 'paste',
        label: 'Text is in Notes',
        allTools: ['desktop.setText'],
        appNameIncludes: 'Notes'
      }
    ])
    expect(criteria).toHaveLength(2)
    const early = evaluateGoalCriteria(criteria, {
      doneTools: new Set(['browser.open']),
      toolResults: [
        {
          tool: 'browser.open',
          status: 'succeeded',
          summary: 'First sentences: San Diego is a city.',
          verified: true
        }
      ],
      observation: {
        snapshotId: 's1',
        appName: 'Chromium',
        capturedAtUtc: '2026-11-08T00:00:00.000Z',
        untrustedText: 'San Diego is a city.'
      }
    })
    expect(early.complete).toBe(false)
    expect(early.missing).toContain('Text is in Notes')
    expect(early.satisfied).toContain('Page is open')

    const done = evaluateGoalCriteria(criteria, {
      doneTools: new Set(['browser.open', 'desktop.setText']),
      toolResults: [
        {
          tool: 'browser.open',
          status: 'succeeded',
          summary: 'First sentences: San Diego is a city.',
          verified: true
        },
        {
          tool: 'desktop.setText',
          status: 'succeeded',
          summary: 'I typed into Note.',
          verified: true
        }
      ],
      observation: {
        snapshotId: 's2',
        appName: 'Notes',
        capturedAtUtc: '2026-11-08T00:00:00.000Z',
        untrustedText: 'San Diego is a city.'
      }
    })
    expect(done.complete).toBe(true)
    expect(keepGoingMessage(early.missing)).toContain('Still needed:')
    expect(unfinishedGoalMessage(early.missing)).toContain('Still needed:')
  })
})

describe('goal verify before final', () => {
  it('rejects an early final until goal checks have evidence, for any goal', async () => {
    const typed: string[] = []
    const context = (signal: AbortSignal): ToolContext => ({
      db: database(),
      run: async () => 0,
      now: () => new Date('2026-11-08T00:00:00.000Z'),
      timeZone: 'UTC',
      screenPermission: true,
      allowedBundleIds: () => ['com.apple.TextEdit'],
      signal,
      desktop: {
        async listWindows() {
          return { status: 'success_verified', summary: 'one', windows: [] }
        },
        async focusWindow() {
          return { status: 'success_verified', summary: 'focused' }
        },
        async observe() {
          return {
            status: 'success_verified',
            summary: 'I am looking at TextEdit.',
            observation: {
              snapshotId: 'snap-edit',
              capturedAtUtc: '2026-11-08T00:00:00.000Z',
              app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 1 },
              window: { id: '1', title: 'Untitled' },
              targets: [{ id: 'body', role: 'AXTextArea', name: 'text', enabled: true }],
              protected: false,
              truncated: false,
              imageIncluded: false
            }
          }
        },
        async clickElement() {
          return { status: 'failed', summary: 'unused' }
        },
        async setText(input) {
          typed.push(input.text)
          return { status: 'success_verified', summary: 'I typed into text.' }
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
    })

    const outcome = await runFakeAgent({
      goal: 'Open TextEdit and type hello there',
      provider: new FakeAgentProvider([
        {
          type: 'tool_call',
          tool: 'task.setGoalChecks',
          args: {
            checks: [
              {
                id: 'open',
                label: 'TextEdit is open',
                anyTools: ['apps.open'],
                appNameIncludes: 'TextEdit'
              },
              {
                id: 'type',
                label: 'hello there is typed',
                allTools: ['desktop.setText'],
                textIncludes: 'hello there'
              }
            ]
          }
        },
        {
          type: 'tool_call',
          tool: 'apps.open',
          args: { displayName: 'TextEdit', bundleId: 'com.apple.TextEdit' }
        },
        { type: 'final', text: 'TextEdit is open.' },
        {
          type: 'tool_call',
          tool: 'desktop.setText',
          args: {
            snapshotId: 'snap-edit',
            targetId: 'body',
            windowId: '1',
            bundleId: 'com.apple.TextEdit',
            name: 'text',
            role: 'AXTextArea',
            text: 'hello there'
          }
        },
        { type: 'final', text: 'I typed hello there into TextEdit.' }
      ]),
      executor: new AuthorizedToolExecutor(createToolRegistry()),
      session: new AgentSessionController(),
      context,
      observe: () => ({
        snapshotId: 'snap-loop',
        appName: 'TextEdit',
        capturedAtUtc: '2026-11-08T00:00:00.000Z',
        untrustedText: typed.at(-1) ?? ''
      }),
      waitForApproval: async (approval) => ({ approved: true, liveTarget: approval.target })
    })

    expect(typed).toEqual(['hello there'])
    expect(outcome.actionOutcome).toBe('success_verified')
    expect(outcome.summary).toContain('I typed hello there into TextEdit.')
    expect(
      outcome.progress.some((entry) => /Still needed:.*hello there is typed/i.test(entry.summary))
    ).toBe(true)
  })
})
