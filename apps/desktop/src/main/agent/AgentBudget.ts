export { maxModelImageChars } from '../../shared/computerAgent'

export interface AgentBudget {
  maxActions: number
  maxModelTurns: number
  deadlineMs: number
  maxIdenticalFailures: number
}

export const defaultAgentBudget: AgentBudget = {
  maxActions: 20,
  maxModelTurns: 30,
  deadlineMs: 5 * 60_000,
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
