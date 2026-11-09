/**
 * One approval for one task on one surface, instead of a card per click.
 *
 * A real task is five to fifteen mutations. Asking the person to confirm each one meant
 * the agent could never finish anything on its own. This narrows the question to: "may
 * Companion click and type in this app for this task?" and then holds that answer for
 * the rest of the run.
 *
 * What a scope deliberately does NOT cover, so the existing refusals keep their force:
 *  - anything classifyControlLabel calls sensitive or consequential (send, buy, delete,
 *    upload, pay, submit, passwords, permission prompts) — denied or carded as before
 *  - an ambiguous label such as Continue, OK, or Allow — still its own card
 *  - desktop.clickPoint, which has no named control to re-find
 *  - ui.press, whose input carries no app identity to check against the scope
 *  - R3 tools, which still need an approval bound to their exact payload
 *  - a different app than the one the scope was granted for
 */

export type TaskScopeSurface = 'browser' | 'desktop'

export interface TaskScopeRequest {
  surface: TaskScopeSurface
  /** Bundle id of the app the scope applies to. Absent for the browser surface. */
  bundleId?: string
  /** Recorded for the approval copy only; a task may legitimately open a new window. */
  appName?: string
}

export interface TaskScope extends TaskScopeRequest {
  taskId: string
  grantedAtUtc: string
  expiresAtUtc: string
}

export const taskScopeTtlMs = 10 * 60 * 1000

const scopedBrowserTools = new Set(['browser.click', 'browser.fill', 'browser.press'])

const scopedDesktopTools = new Set(['desktop.clickElement', 'desktop.setText', 'desktop.keyPress'])

/** True when one approval for the whole task could stand in for this tool's own card. */
export function scopeableTool(tool: string): boolean {
  return scopedBrowserTools.has(tool) || scopedDesktopTools.has(tool)
}

/**
 * Key for storing one grant per surface a task actually touches. A task that opens
 * Agent Browser and then switches to Notes needs its own grant for each — one card per
 * surface, not one card for the whole task that only ever covers the first app.
 */
export function taskScopeKey(request: Pick<TaskScopeRequest, 'surface' | 'bundleId'>): string {
  return request.surface === 'browser' ? 'browser' : `desktop:${request.bundleId ?? ''}`
}

/** What a person would be agreeing to if they allowed this call for the whole task. */
export function scopeRequestFor(
  tool: string,
  input: Record<string, unknown>
): TaskScopeRequest | null {
  if (scopedBrowserTools.has(tool)) {
    return { surface: 'browser', appName: 'Agent Browser' }
  }
  if (!scopedDesktopTools.has(tool)) {
    return null
  }
  const bundleId = typeof input.bundleId === 'string' ? input.bundleId.trim() : ''
  if (!bundleId) {
    return null
  }
  const appName = typeof input.appName === 'string' ? input.appName.trim() : ''
  return { surface: 'desktop', bundleId, ...(appName ? { appName } : {}) }
}

export function createTaskScope(input: {
  taskId: string
  request: TaskScopeRequest
  now: Date
  ttlMs?: number
}): TaskScope {
  return {
    ...input.request,
    taskId: input.taskId,
    grantedAtUtc: input.now.toISOString(),
    expiresAtUtc: new Date(input.now.getTime() + (input.ttlMs ?? taskScopeTtlMs)).toISOString()
  }
}

export function scopeCovers(
  scope: TaskScope | null | undefined,
  call: { taskId: string; tool: string; input: Record<string, unknown>; now: Date }
): boolean {
  if (!scope || scope.taskId !== call.taskId) {
    return false
  }
  const expiresAt = Date.parse(scope.expiresAtUtc)
  if (!Number.isFinite(expiresAt) || expiresAt <= call.now.getTime()) {
    return false
  }
  if (scope.surface === 'browser') {
    return scopedBrowserTools.has(call.tool)
  }
  if (!scopedDesktopTools.has(call.tool)) {
    return false
  }
  // Containment: a scope for Notes never authorizes a click in Mail.
  const bundleId = typeof call.input.bundleId === 'string' ? call.input.bundleId.trim() : ''
  return Boolean(scope.bundleId) && bundleId === scope.bundleId
}

/**
 * A scope card authorizes a surface for a task, not one control, so there is no live
 * control to re-find. Identity rechecking still happens per action inside the adapters.
 */
export function consumeScopeGrant(
  grant: { approvalId: string; expiresAtUtc: string; used: boolean },
  attempt: { approvalId: string; now: Date }
): { ok: true } | { ok: false; reason: string } {
  if (grant.used || attempt.approvalId !== grant.approvalId) {
    return { ok: false, reason: "That confirmation doesn't match the action." }
  }
  if (Date.parse(grant.expiresAtUtc) <= attempt.now.getTime()) {
    grant.used = true
    return { ok: false, reason: 'That confirmation expired. Ask me again if you still want it.' }
  }
  grant.used = true
  return { ok: true }
}
