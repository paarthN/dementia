import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentApprovalGate } from '../src/main/agent/AgentApprovalGate'
import { AgentSessionController } from '../src/main/agent/AgentSessionController'
import { readLiveTarget } from '../src/main/agent/AgentEvents'
import { FakeAgentProvider, runFakeAgent } from '../src/main/agent/AgentRunner'
import { AuthorizedToolExecutor } from '../src/main/agent/AuthorizedToolExecutor'
import type { ToolContext } from '../src/main/services/toolRegistry'
import { createToolRegistry } from '../src/main/services/toolRegistry'
import { openDatabase } from '../src/main/storage/database'
import { AgentProgress } from '../src/renderer/panel/AgentProgress'
import { companionIpcChannels } from '../src/shared/channels'
import {
  acceptAgentStatusEvent,
  agentBusy,
  agentStatusSchema,
  approvalWhat,
  chatSubmitEffect,
  confirmLabelFor,
  confirmationFromSpeech,
  describeToolAction
} from '../src/shared/agentStatus'
import type { AgentStatus } from '../src/shared/agentStatus'
import { parseCompanionIpcArgs } from '../src/shared/ipcSchemas'
import type { TargetIdentity } from '../src/main/agent/security/ActionApproval'

function database(): DatabaseSync {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-progress-')), 'test.sqlite'))
}

function context(signal: AbortSignal): ToolContext {
  return {
    db: database(),
    run: async () => 0,
    now: () => new Date('2026-11-05T20:00:00.000Z'),
    timeZone: 'UTC',
    screenPermission: true,
    allowedBundleIds: () => [],
    signal
  }
}

function target(name: string): TargetIdentity {
  return {
    name,
    role: 'AXButton',
    appName: 'TextEdit',
    windowId: '42',
    observationId: 'snap-1'
  }
}

const running: AgentStatus = {
  taskId: 'task-1',
  goal: 'Open TextEdit and type a note',
  state: 'executing',
  current: 'Opening TextEdit.',
  completed: null,
  step: 1,
  verified: false,
  approval: null,
  permissionReason: null,
  observing: false
}

describe('agent progress copy', () => {
  it('describes a step in plain language and leaves typed text out', () => {
    expect(
      describeToolAction('apps.open', { displayName: 'TextEdit', bundleId: 'com.apple.TextEdit' })
    ).toBe('Opening TextEdit.')
    expect(describeToolAction('desktop.setText', { name: 'Note', text: 'password hunter2' })).toBe(
      'Typing into Note.'
    )
    expect(
      describeToolAction('desktop.setText', { name: 'Note', text: 'password hunter2' })
    ).not.toMatch(/hunter2|password|desktop\.setText/)
    expect(describeToolAction('widgets.spin', {})).toBe('Working on the next step.')
  })

  it('names the confirmation after the control and never offers a bare OK', () => {
    expect(confirmLabelFor('desktop.clickElement', { name: 'Save' })).toBe('Press Save')
    expect(confirmLabelFor('ui.press', { name: 'OK' })).toBe('Press OK')
    expect(confirmLabelFor('desktop.setText', { name: 'Note', text: 'secret' })).toBe(
      'Type into Note'
    )
    expect(confirmLabelFor('test.note', {})).toBe('Continue')
    expect(approvalWhat('ui.press', { name: 'Note', text: 'hunter2', appName: 'TextEdit' })).toBe(
      'Type into Note in TextEdit.'
    )
    expect(approvalWhat('ui.press', { name: 'Note', text: 'hunter2' })).not.toContain('hunter2')
  })

  it('drops a status event that carries a picture or an extra field', () => {
    expect(acceptAgentStatusEvent(null)).toBeNull()
    expect(acceptAgentStatusEvent({ ...running, imageBase64: 'abc' })).toBeUndefined()
    expect(
      acceptAgentStatusEvent({
        ...running,
        current: 'data:image/png;base64,aaaa'
      })
    ).toBeUndefined()
    expect(agentStatusSchema.safeParse({ ...running, confirmLabel: 'OK' }).success).toBe(false)
  })

  it('does not treat speech or Send as a confirmation', () => {
    expect(confirmationFromSpeech('yes')).toBeNull()
    expect(confirmationFromSpeech('okay continue')).toBeNull()
    expect(confirmationFromSpeech('Press Save')).toBeNull()
    expect(chatSubmitEffect({ agentBusy: false, approvalVisible: true })).toBe('hold-approval')
    expect(chatSubmitEffect({ agentBusy: true, approvalVisible: false })).toBe('hold-busy')
    expect(chatSubmitEffect({ agentBusy: false, approvalVisible: false })).toBe('send')
    expect(agentBusy(running)).toBe(true)
    expect(agentBusy({ ...running, state: 'completed', verified: true })).toBe(false)
  })

  it('rejects an agent confirmation that adds a command', () => {
    expect(
      parseCompanionIpcArgs(companionIpcChannels.confirmAgent, [
        { taskId: 'task-1', approvalId: 'approval-1' }
      ])
    ).toEqual({ taskId: 'task-1', approvalId: 'approval-1' })
    expect(() =>
      parseCompanionIpcArgs(companionIpcChannels.confirmAgent, [
        { taskId: 'task-1', approvalId: 'approval-1', command: 'sh' }
      ])
    ).toThrow()
    expect(() => parseCompanionIpcArgs(companionIpcChannels.stopAgent, [{}])).toThrow()
  })
})

describe('AgentProgress', () => {
  it('shows the goal, the current step, and Pause and Stop', () => {
    const html = renderToStaticMarkup(
      createElement(AgentProgress, {
        status: running,
        onPause: () => undefined,
        onResume: () => undefined,
        onStop: () => undefined,
        onConfirm: () => undefined,
        onAllowScreen: () => undefined,
        onGuide: () => undefined
      })
    )
    expect(html).toContain('Open TextEdit and type a note')
    expect(html).toContain('Opening TextEdit.')
    expect(html).toContain('Step 1')
    expect(html).toContain('>Pause<')
    expect(html).toContain('>Stop<')
    expect(html.toLowerCase()).not.toContain('succeeded')
    expect(html).not.toContain('desktop.')
  })

  it('shows one approval card and keeps Stop on the page', () => {
    const html = renderToStaticMarkup(
      createElement(AgentProgress, {
        status: {
          ...running,
          state: 'awaiting_confirmation',
          current: 'Waiting for you.',
          approval: {
            approvalId: 'approval-1',
            what: 'I am about to press Save in TextEdit.',
            confirmLabel: 'Press Save'
          }
        },
        onPause: () => undefined,
        onResume: () => undefined,
        onStop: () => undefined,
        onConfirm: () => undefined,
        onAllowScreen: () => undefined,
        onGuide: () => undefined
      })
    )
    expect(html).toContain('I am about to press Save in TextEdit.')
    expect(html).toContain('>Press Save<')
    expect(html).not.toContain('>OK<')
    expect(html).toContain('aria-label="Approval"')
    expect(html).toContain('>Stop<')
    expect(html.match(/class="primary"/g)).toHaveLength(1)
  })

  it('offers screen access once and a way to do it yourself', () => {
    const html = renderToStaticMarkup(
      createElement(AgentProgress, {
        status: {
          ...running,
          state: 'awaiting_permission',
          current: 'Waiting for you.',
          permissionReason:
            'Companion needs screen access to look at the other app. You can allow it, or do this yourself.'
        },
        onPause: () => undefined,
        onResume: () => undefined,
        onStop: () => undefined,
        onConfirm: () => undefined,
        onAllowScreen: () => undefined,
        onGuide: () => undefined
      })
    )
    const reason =
      'Companion needs screen access to look at the other app. You can allow it, or do this yourself.'
    expect(html.split(reason)).toHaveLength(2)
    expect(html).toContain('>Allow screen access<')
    expect(html).toContain('>Do it myself<')
    expect(html).toContain('>Stop<')
  })

  it('shows a finished step only after it was verified', () => {
    const unverified = renderToStaticMarkup(
      createElement(AgentProgress, {
        status: { ...running, completed: 'Opened TextEdit.', verified: false },
        onPause: () => undefined,
        onResume: () => undefined,
        onStop: () => undefined,
        onConfirm: () => undefined,
        onAllowScreen: () => undefined,
        onGuide: () => undefined
      })
    )
    expect(unverified).not.toContain('Opened TextEdit.')
    const verified = renderToStaticMarkup(
      createElement(AgentProgress, {
        status: {
          ...running,
          state: 'observing',
          verified: true,
          completed: 'Opened TextEdit.',
          observing: true
        },
        onPause: () => undefined,
        onResume: () => undefined,
        onStop: () => undefined,
        onConfirm: () => undefined,
        onAllowScreen: () => undefined,
        onGuide: () => undefined
      })
    )
    expect(verified).toContain('Opened TextEdit.')
    expect(verified).toContain('Companion is looking at this screen.')
  })
})

describe('agent approval gate', () => {
  it('accepts one matching confirmation and ignores a second one', async () => {
    const gate = new AgentApprovalGate()
    const signal = new AbortController().signal
    const held = {
      approvalId: 'approval-1',
      taskId: 'task-1',
      stepId: 'step-1',
      tool: 'desktop.clickElement',
      payloadJson: '{}',
      target: target('Save'),
      observationId: 'snap-1',
      expiresAtUtc: '2026-11-05T20:10:00.000Z',
      used: false
    }
    const pending = gate.wait(held, signal)
    expect(gate.confirm('task-1', 'other', target('Save'))).toBe(false)
    expect(gate.confirm('task-1', 'approval-1', target('Save'))).toBe(true)
    expect(gate.confirm('task-1', 'approval-1', target('Save'))).toBe(false)
    await expect(pending).resolves.toMatchObject({ approved: true, liveTarget: target('Save') })
  })

  it('refuses the press when the live control is no longer Save', async () => {
    const seen = await readLiveTarget(
      {
        approvalId: 'approval-1',
        taskId: 'task-1',
        stepId: 'step-1',
        tool: 'desktop.clickElement',
        payloadJson: '{}',
        target: target('Save'),
        observationId: 'snap-1',
        expiresAtUtc: '2026-11-05T20:10:00.000Z',
        used: false
      },
      {
        desktop: {
          listWindows: async () => ({ status: 'failed', summary: 'no' }),
          focusWindow: async () => ({ status: 'failed', summary: 'no' }),
          observe: async () => ({
            status: 'success_verified',
            summary: 'Looked.',
            observation: {
              snapshotId: 'snap-2',
              capturedAtUtc: '2026-11-05T20:01:00.000Z',
              app: { name: 'TextEdit' },
              window: { id: '42' },
              targets: [
                { id: 'delete', role: 'AXButton', name: 'Delete', enabled: true },
                { id: 'save', role: 'AXButton', name: 'Save copy', enabled: true }
              ],
              protected: false,
              truncated: false,
              imageIncluded: false
            }
          }),
          clickElement: async () => ({ status: 'failed', summary: 'no' }),
          setText: async () => ({ status: 'failed', summary: 'no' }),
          keyPress: async () => ({ status: 'failed', summary: 'no' }),
          scroll: async () => ({ status: 'failed', summary: 'no' })
        }
      }
    )
    expect(seen).toBeNull()
  })
})

describe('runner status', () => {
  it('publishes a human step and does not call it done before verification', async () => {
    const seen: AgentStatus[] = []
    const session = new AgentSessionController()
    await runFakeAgent({
      goal: 'Open TextEdit',
      provider: new FakeAgentProvider([
        {
          type: 'tool_call',
          tool: 'apps.open',
          args: { displayName: 'TextEdit', bundleId: 'com.apple.TextEdit' }
        },
        { type: 'final', text: 'TextEdit is open.' }
      ]),
      session,
      executor: new AuthorizedToolExecutor(createToolRegistry()),
      context,
      now: () => new Date('2026-11-05T20:00:00.000Z'),
      onStatus: (status) => seen.push(status)
    })
    expect(seen.some((status) => status.current === 'Opening TextEdit.')).toBe(true)
    expect(seen.some((status) => status.current.includes('apps.open'))).toBe(false)
    const beforeDone = seen.filter((status) => status.state !== 'completed')
    expect(beforeDone.every((status) => !/succeed|finished/i.test(status.current))).toBe(true)
    expect(seen.at(-1)?.verified).toBe(true)
    expect(seen.at(-1)?.completed).toBe('Opened TextEdit.')
  })

  it('shows the approval card and does not press until that card is confirmed', async () => {
    const seen: AgentStatus[] = []
    const presses: string[] = []
    const session = new AgentSessionController()
    const gate = new AgentApprovalGate()
    const outcome = runFakeAgent({
      goal: 'Press Save',
      provider: new FakeAgentProvider([
        {
          type: 'tool_call',
          tool: 'test.save',
          args: { name: 'Save', role: 'AXButton', appName: 'TextEdit', windowId: '42' }
        },
        { type: 'final', text: 'Save was pressed.' }
      ]),
      session,
      executor: new AuthorizedToolExecutor(
        createToolRegistry([
          {
            name: 'test.save',
            risk: 'R2',
            async execute(input) {
              presses.push(String(input.name))
              return {
                status: 'succeeded',
                summary: 'Pressed Save.',
                verification: { method: 'local_state', passed: true }
              }
            }
          }
        ])
      ),
      context,
      now: () => new Date('2026-11-05T20:00:00.000Z'),
      onStatus: (status) => seen.push(status),
      waitForApproval: (approval, signal) => gate.wait(approval, signal)
    })
    await waitUntil(() => seen.some((status) => status.approval?.confirmLabel === 'Press Save'))
    expect(presses).toEqual([])
    expect(confirmationFromSpeech('yes')).toBeNull()
    const pending = seen.find((status) => status.approval)
    expect(pending?.approval?.what).not.toMatch(/test\.save/)
    gate.confirm('task-1', 'wrong', target('Save'))
    expect(presses).toEqual([])
    const approvalId = pending?.approval?.approvalId ?? ''
    const taskId = pending?.taskId ?? ''
    gate.confirm(taskId, approvalId, target('Save'))
    const result = await outcome
    expect(presses).toEqual(['Save'])
    expect(result.actionOutcome).toBe('success_verified')
  })
})

async function waitUntil(ready: () => boolean): Promise<void> {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > 1000) {
      throw new Error('timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
