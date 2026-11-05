import type { ComputerAgentEvent, ComputerAgentState } from '../../shared/computerAgent'

const transitions: Record<
  ComputerAgentState,
  Partial<Record<ComputerAgentEvent, ComputerAgentState>>
> = {
  idle: { start: 'observing' },
  observing: {
    observed: 'planning',
    pause: 'paused',
    stop: 'cancelled',
    fail: 'failed',
    uncertain: 'uncertain',
    interrupt: 'interrupted',
    limit: 'partial'
  },
  planning: {
    begin_execution: 'executing',
    need_permission: 'awaiting_permission',
    need_confirmation: 'awaiting_confirmation',
    verified_done: 'completed',
    pause: 'paused',
    stop: 'cancelled',
    fail: 'failed',
    uncertain: 'uncertain',
    interrupt: 'interrupted',
    limit: 'partial'
  },
  awaiting_permission: {
    approved: 'observing',
    stop: 'cancelled',
    fail: 'failed',
    interrupt: 'interrupted'
  },
  awaiting_confirmation: {
    approved: 'executing',
    stop: 'cancelled',
    fail: 'failed',
    interrupt: 'interrupted'
  },
  executing: {
    executed: 'verifying',
    uncertain: 'uncertain',
    known_stop: 'cancelled',
    fail: 'failed'
  },
  verifying: {
    verified_continue: 'observing',
    verified_done: 'completed',
    fail: 'failed',
    uncertain: 'uncertain',
    known_stop: 'cancelled',
    limit: 'partial',
    step_failed: 'observing'
  },
  paused: {
    resume: 'observing',
    stop: 'cancelled',
    interrupt: 'interrupted'
  },
  completed: {},
  partial: {},
  failed: {},
  cancelled: {},
  uncertain: {},
  interrupted: {}
}

export function transitionAgentState(
  state: ComputerAgentState,
  event: ComputerAgentEvent
):
  | { ok: true; state: ComputerAgentState }
  | { ok: false; state: ComputerAgentState; reason: string } {
  const next = transitions[state][event]
  if (!next) {
    return { ok: false, state, reason: `Cannot ${event} from ${state}.` }
  }
  return { ok: true, state: next }
}

export function isTerminalAgentState(state: ComputerAgentState): boolean {
  return (
    state === 'completed' ||
    state === 'partial' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'uncertain' ||
    state === 'interrupted'
  )
}
