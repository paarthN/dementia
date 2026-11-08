import { describe, expect, it } from 'vitest'
import type { ActiveTaskView, PendingApproval } from '../src/shared/agent'
import { agentProgressView, draftFromSpeech } from '../src/shared/agentProgressView'

function task(state: ActiveTaskView['state'], summary: string | null = null): ActiveTaskView {
  return { id: 'task-1', state, summary }
}

function approval(confirmLabel = 'Open website'): PendingApproval {
  return {
    taskId: 'task-1',
    approvalId: 'approval-1',
    summary: 'Open https://example.com',
    confirmLabel,
    expiresAtUtc: '2026-11-05T20:00:00.000Z'
  }
}

describe('agent progress view', () => {
  it('stays hidden when nothing is running', () => {
    expect(
      agentProgressView({
        messages: [{ role: 'assistant', text: 'Opened TextEdit.', kind: 'success' }],
        activeTask: task('completed', 'Opened TextEdit.'),
        pendingApproval: null
      })
    ).toBeNull()
  })

  it('shows the request, the current step, and Stop without calling it finished', () => {
    const view = agentProgressView({
      messages: [
        { role: 'user', text: 'Open TextEdit', kind: 'text' },
        { role: 'assistant', text: 'Opened Finder.', kind: 'success' }
      ],
      activeTask: task('verifying', 'Checking TextEdit.'),
      pendingApproval: null
    })

    expect(view).toMatchObject({
      status: 'Checking what happened',
      goal: 'Open TextEdit',
      now: 'Checking TextEdit.',
      finished: 'Opened Finder.',
      blocksComposer: false,
      stopTaskId: 'task-1',
      approval: null,
      permission: null
    })
    expect(view?.status.toLowerCase()).not.toContain('succeed')
    expect(view?.now?.toLowerCase()).not.toContain('succeed')
  })

  it('does not treat a status message as a finished step', () => {
    const view = agentProgressView({
      messages: [
        { role: 'user', text: 'Explain this screen', kind: 'text' },
        { role: 'assistant', text: 'Looking now.', kind: 'status' }
      ],
      activeTask: task('executing', 'Looking now.'),
      pendingApproval: null
    })

    expect(view?.finished).toBeNull()
    expect(view?.now).toBe('Looking now.')
  })

  it('shows one approval with the exact button label and blocks another send', () => {
    const view = agentProgressView({
      messages: [{ role: 'user', text: 'Open example.com', kind: 'text' }],
      activeTask: task('awaiting_confirmation', 'Open https://example.com'),
      pendingApproval: approval()
    })

    expect(view?.blocksComposer).toBe(true)
    expect(view?.stopTaskId).toBeNull()
    expect(view?.approval).toEqual({
      taskId: 'task-1',
      approvalId: 'approval-1',
      what: 'Open https://example.com',
      change: 'This will open a website in your browser.',
      confirmLabel: 'Open website',
      editText: 'Open example.com'
    })
    expect(view?.approval?.confirmLabel).not.toBe('OK')
  })

  it('asks for screen access once and offers the same request as guidance', () => {
    const view = agentProgressView({
      messages: [{ role: 'user', text: 'Explain this screen', kind: 'text' }],
      activeTask: task(
        'awaiting_permission',
        "I can't see the screen without permission. You can describe the message, or turn on screen access for this request."
      ),
      pendingApproval: null
    })

    expect(view?.status).toBe('Waiting for screen access')
    expect(view?.permission?.reason).toBe(
      "I can't see the screen without permission. You can describe the message, or turn on screen access for this request."
    )
    expect(view?.permission?.goal).toBe('Explain this screen')
    expect(view?.blocksComposer).toBe(true)
    expect(view?.now).toBeNull()
  })

  it('keeps a generic confirmation specific to the summary', () => {
    const view = agentProgressView({
      messages: [],
      activeTask: task('awaiting_confirmation', 'Press Save'),
      pendingApproval: approval('Continue')
    })

    expect(view?.approval?.confirmLabel).toBe('Continue')
    expect(view?.approval?.change).toBe('This will go ahead with the action described above.')
  })

  it('keeps spoken words in the draft', () => {
    expect(draftFromSpeech('Open mail', 'to Sam')).toBe('Open mail to Sam')
    expect(draftFromSpeech('  ', 'Set a reminder')).toBe('Set a reminder')
  })
})
