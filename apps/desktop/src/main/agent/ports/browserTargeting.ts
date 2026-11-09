import type {
  BrowserAncestor,
  BrowserRole,
  BrowserTarget,
  BrowserTargetQuery,
  BrowserWithin
} from './BrowserAutomationPort'

export function targetIdentityKey(
  target: Pick<BrowserTarget, 'role' | 'name' | 'ancestors'>
): string {
  const chain = target.ancestors
    .map((item) => `${item.role}:${(item.name ?? '').toLowerCase()}`)
    .join('>')
  return `${target.role}|${target.name.toLowerCase()}|${chain}`
}

export function targetsMatchingIdentity(
  targets: readonly BrowserTarget[],
  identityKey: string
): BrowserTarget[] {
  return targets.filter((item) => targetIdentityKey(item) === identityKey)
}

/**
 * The shape this resolver actually reads. Keeping it structural lets the runner reuse it
 * on the model-facing observation targets, which carry optional ancestors.
 */
export interface QueryableTarget {
  role: string
  name: string
  ancestors?: BrowserAncestor[]
  inListIndex?: number
}

export function resolveTargetQuery<T extends QueryableTarget>(
  targets: readonly T[],
  query: BrowserTargetQuery
): { ok: true; target: T } | { ok: false; reason: 'missing' | 'ambiguous' | 'unsupported' } {
  if (typeof query.ordinal === 'number') {
    return { ok: false, reason: 'unsupported' }
  }
  let scoped = [...targets]
  if (query.within) {
    scoped = filterWithin(scoped, query.within)
  }
  scoped = scoped.filter((item) => item.role === query.role)
  if (query.name !== undefined) {
    scoped = scoped.filter((item) => item.name === query.name)
  }
  if (query.nameIncludes) {
    const needle = query.nameIncludes.toLowerCase()
    scoped = scoped.filter((item) => item.name.toLowerCase().includes(needle))
  }
  if (scoped.length === 0) {
    return { ok: false, reason: 'missing' }
  }
  if (scoped.length > 1) {
    return { ok: false, reason: 'ambiguous' }
  }
  return { ok: true, target: scoped[0]! }
}

export function preferTargets(
  candidates: readonly BrowserTarget[],
  limit: number
): { targets: BrowserTarget[]; truncated: boolean } {
  if (candidates.length <= limit) {
    return { targets: [...candidates], truncated: false }
  }
  const scored = candidates.map((item, index) => ({
    item,
    index,
    score: preferenceScore(item)
  }))
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  const chosen = scored.slice(0, limit).sort((left, right) => left.index - right.index)
  return { targets: chosen.map((entry) => entry.item), truncated: true }
}

export function actionExpectationMet(input: {
  beforeText: string
  afterText: string
  beforeUrl: string
  afterUrl: string
  expectTextIncludes?: string
  expectUrlIncludes?: string
}): boolean {
  const textNeedle = input.expectTextIncludes?.trim()
  const urlNeedle = input.expectUrlIncludes?.trim()
  if (!textNeedle && !urlNeedle) {
    return false
  }
  let ok = true
  if (textNeedle) {
    const beforeHas = input.beforeText.toLowerCase().includes(textNeedle.toLowerCase())
    const afterHas = input.afterText.toLowerCase().includes(textNeedle.toLowerCase())
    ok = ok && afterHas && !beforeHas
  }
  if (urlNeedle) {
    const beforeHas = input.beforeUrl.toLowerCase().includes(urlNeedle.toLowerCase())
    const afterHas = input.afterUrl.toLowerCase().includes(urlNeedle.toLowerCase())
    ok = ok && afterHas && !beforeHas
  }
  return ok
}

export function meaningfulPageChange(input: {
  beforeText: string
  afterText: string
  beforeUrl: string
  afterUrl: string
}): boolean {
  return input.beforeUrl !== input.afterUrl || input.beforeText !== input.afterText
}

function filterWithin<T extends QueryableTarget>(targets: T[], within: BrowserWithin): T[] {
  return targets.filter((item) => {
    const ancestor = (item.ancestors ?? []).find((entry) => ancestorMatches(entry, within))
    if (!ancestor) {
      return false
    }
    if (within.itemOrdinal === undefined) {
      return true
    }
    return item.inListIndex === within.itemOrdinal
  })
}

function ancestorMatches(ancestor: BrowserAncestor, within: BrowserWithin): boolean {
  if (ancestor.role !== within.role) {
    return false
  }
  if (within.name !== undefined && ancestor.name !== within.name) {
    return false
  }
  if (
    within.nameIncludes &&
    !(ancestor.name ?? '').toLowerCase().includes(within.nameIncludes.toLowerCase())
  ) {
    return false
  }
  return true
}

function preferenceScore(target: BrowserTarget): number {
  let score = 0
  if (target.role === 'textbox' || target.role === 'searchbox') {
    score += 40
  }
  if (target.role === 'button' || target.role === 'link') {
    score += 10
  }
  if (target.ancestors.some((item) => item.role === 'main' || item.role === 'dialog')) {
    score += 30
  }
  if (target.ancestors.some((item) => item.role === 'navigation')) {
    score += 5
  }
  if (target.enabled) {
    score += 5
  }
  return score
}

export function assignObservationIds(targets: readonly BrowserTarget[]): BrowserTarget[] {
  return targets.map((item, index) => ({
    ...item,
    id: `t${index + 1}`
  }))
}

/** When several controls share a name, prefer the one matching wanted ancestors (e.g. dialog). */
export function preferUniqueTarget(
  matches: readonly BrowserTarget[],
  wanted: Pick<BrowserTarget, 'ancestors'>
): BrowserTarget | null {
  if (matches.length === 1) {
    return matches[0] ?? null
  }
  if (matches.length === 0) {
    return null
  }
  if (wanted.ancestors.length > 0) {
    const aligned = matches.filter((item) =>
      wanted.ancestors.every((ancestor) =>
        item.ancestors.some(
          (entry) =>
            entry.role === ancestor.role && (!ancestor.name || (entry.name ?? '') === ancestor.name)
        )
      )
    )
    if (aligned.length === 1) {
      return aligned[0] ?? null
    }
  }
  const inDialog = matches.filter((item) =>
    item.ancestors.some((entry) => entry.role === 'dialog' || entry.role === 'alertdialog')
  )
  if (inDialog.length === 1) {
    return inDialog[0] ?? null
  }
  return null
}

export type { BrowserRole }
