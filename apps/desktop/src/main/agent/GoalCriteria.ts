import { z } from 'zod'
import type { SafeObservation, SafeToolResult } from '../../shared/computerAgent'

export const goalCriterionSchema = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(160),
    allTools: z.array(z.string().min(1).max(80)).max(8).optional(),
    anyTools: z.array(z.string().min(1).max(80)).max(8).optional(),
    textIncludes: z.string().min(1).max(120).optional(),
    appNameIncludes: z.string().min(1).max(80).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !value.allTools?.length &&
      !value.anyTools?.length &&
      !value.textIncludes &&
      !value.appNameIncludes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A goal check needs at least one evidence rule.'
      })
    }
  })

export const goalCriteriaSchema = z.array(goalCriterionSchema).min(1).max(8)

export type GoalCriterion = z.infer<typeof goalCriterionSchema>

export interface GoalEvidence {
  doneTools: ReadonlySet<string>
  toolResults: readonly SafeToolResult[]
  observation: SafeObservation
}

export interface GoalCheckReport {
  complete: boolean
  satisfied: string[]
  missing: string[]
}

export const maxGoalKeepGoing = 5

export function parseGoalCriteria(input: unknown): GoalCriterion[] | null {
  const normalized = normalizeGoalCriteriaInput(input)
  const parsed = goalCriteriaSchema.safeParse(normalized)
  return parsed.success ? parsed.data : null
}

/** Accept common model spellings before the strict Zod schema. */
export function normalizeGoalCriteriaInput(input: unknown): unknown {
  const root =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null
  const raw = root ? (root.checks ?? root.goals ?? root.criteria ?? input) : input
  if (!Array.isArray(raw)) {
    return raw
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item
    }
    const row = item as Record<string, unknown>
    const label = firstText(row.label, row.description, row.name) || `check-${index + 1}`
    const id =
      firstText(row.id) ||
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) ||
      `c${index + 1}`
    const anyTools = stringList(row.anyTools ?? row.any_tools)
    const allTools = stringList(row.allTools ?? row.all_tools)
    const textIncludes = firstText(row.textIncludes, row.text_includes, row.includes, row.text)
    const appNameIncludes = firstText(
      row.appNameIncludes,
      row.app_name_includes,
      row.appName,
      row.app
    )
    return {
      id: id.slice(0, 40),
      label: label.slice(0, 160),
      ...(anyTools ? { anyTools } : {}),
      ...(allTools ? { allTools } : {}),
      ...(textIncludes ? { textIncludes: textIncludes.slice(0, 120) } : {}),
      ...(appNameIncludes ? { appNameIncludes: appNameIncludes.slice(0, 80) } : {})
    }
  })
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8)
  return items.length > 0 ? items : undefined
}

export function evaluateGoalCriteria(
  criteria: readonly GoalCriterion[] | null | undefined,
  evidence: GoalEvidence
): GoalCheckReport {
  if (!criteria || criteria.length === 0) {
    return {
      complete: false,
      satisfied: [],
      missing: ['a checkable plan for the request']
    }
  }
  const haystack = [
    evidence.observation.untrustedText ?? '',
    ...evidence.toolResults.map((item) => item.summary)
  ]
    .join('\n')
    .toLowerCase()
  const appName = evidence.observation.appName.toLowerCase()
  const satisfied: string[] = []
  const missing: string[] = []
  for (const item of criteria) {
    if (criterionMet(item, evidence.doneTools, haystack, appName)) {
      satisfied.push(item.label)
    } else {
      missing.push(item.label)
    }
  }
  return { complete: missing.length === 0, satisfied, missing }
}

export function keepGoingMessage(missing: readonly string[]): string {
  const list = missing
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 5)
  if (list.length === 0) {
    return 'Keep going. The request is not finished yet.'
  }
  return `Keep going. Still needed: ${list.join('; ')}.`.slice(0, 500)
}

export function unfinishedGoalMessage(missing: readonly string[]): string {
  const list = missing
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 5)
  if (list.length === 0) {
    return 'I could not verify that the task was finished.'
  }
  return `I could not finish. Still needed: ${list.join('; ')}.`.slice(0, 500)
}

/**
 * The model calls tools by their underscore form (browser_click) but doneTools is keyed
 * by the registry's dot form (browser.click). A check written against either spelling of
 * the tool it just called should still match.
 */
function sameTool(written: string, done: string): boolean {
  return written === done || written.replace(/[._]/g, '') === done.replace(/[._]/g, '')
}

function criterionMet(
  item: GoalCriterion,
  doneTools: ReadonlySet<string>,
  haystack: string,
  appName: string
): boolean {
  const done = [...doneTools]
  if (
    item.allTools?.length &&
    !item.allTools.every((tool) => done.some((entry) => sameTool(tool, entry)))
  ) {
    return false
  }
  if (
    item.anyTools?.length &&
    !item.anyTools.some((tool) => done.some((entry) => sameTool(tool, entry)))
  ) {
    return false
  }
  if (item.textIncludes && !haystack.includes(item.textIncludes.toLowerCase())) {
    return false
  }
  if (item.appNameIncludes && !appName.includes(item.appNameIncludes.toLowerCase())) {
    return false
  }
  return true
}
