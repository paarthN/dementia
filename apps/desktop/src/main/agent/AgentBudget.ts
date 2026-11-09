export { maxModelImageChars } from '../../shared/computerAgent'

export interface AgentBudget {
  maxActions: number
  maxModelTurns: number
  deadlineMs: number
  maxIdenticalFailures: number
}

// Sized for a real multi-app task (open a page, read it, switch apps, type, verify),
// not the 5-click fixture these started at. One approval per surface instead of one
// per click removed the human round-trips that used to bound this.
export const defaultAgentBudget: AgentBudget = {
  maxActions: 40,
  maxModelTurns: 60,
  deadlineMs: 15 * 60_000,
  maxIdenticalFailures: 2
}

export function overActionBudget(budget: AgentBudget, actions: number): boolean {
  return actions >= budget.maxActions
}

export function overTurnBudget(budget: AgentBudget, turns: number): boolean {
  return turns >= budget.maxModelTurns
}

export function overDeadline(budget: AgentBudget, startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs >= budget.deadlineMs
}
