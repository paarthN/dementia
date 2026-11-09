import { describe, expect, it } from 'vitest'
import type { BrowserTarget } from '../src/main/agent/ports/BrowserAutomationPort'
import {
  actionExpectationMet,
  preferTargets,
  preferUniqueTarget,
  resolveTargetQuery,
  targetIdentityKey,
  targetsMatchingIdentity
} from '../src/main/agent/ports/browserTargeting'

function target(
  partial: Partial<BrowserTarget> & Pick<BrowserTarget, 'id' | 'role' | 'name'>
): BrowserTarget {
  return {
    enabled: true,
    sensitive: false,
    ancestors: [],
    ...partial
  }
}

const results = [
  target({
    id: 't1',
    role: 'link',
    name: 'City Library',
    ancestors: [
      { role: 'list', name: 'Search results' },
      { role: 'listitem', name: 'City Library' }
    ],
    inListIndex: 1
  }),
  target({
    id: 't2',
    role: 'link',
    name: 'County Library',
    ancestors: [
      { role: 'list', name: 'Search results' },
      { role: 'listitem', name: 'County Library' }
    ],
    inListIndex: 2
  }),
  target({
    id: 't3',
    role: 'link',
    name: 'City Library',
    ancestors: [
      { role: 'list', name: 'Related' },
      { role: 'listitem', name: 'City Library' }
    ],
    inListIndex: 1
  }),
  target({
    id: 't4',
    role: 'button',
    name: 'Save',
    ancestors: [{ role: 'dialog', name: 'Confirm save' }]
  }),
  target({
    id: 't5',
    role: 'button',
    name: 'Save',
    ancestors: [{ role: 'main', name: 'Document' }]
  })
]

describe('browser targeting', () => {
  it('resolves the second list item, not the second matching link globally', () => {
    const resolved = resolveTargetQuery(results, {
      role: 'link',
      within: { role: 'list', name: 'Search results', itemOrdinal: 2 }
    })
    expect(resolved).toEqual({ ok: true, target: results[1] })

    const byGlobalOrdinal = resolveTargetQuery(results, {
      role: 'link',
      ordinal: 2
    })
    expect(byGlobalOrdinal.ok).toBe(false)
  })

  it('resolves Save inside a dialog without clicking the other Save', () => {
    const resolved = resolveTargetQuery(results, {
      role: 'button',
      name: 'Save',
      within: { role: 'dialog', nameIncludes: 'Confirm' }
    })
    expect(resolved).toEqual({ ok: true, target: results[3] })
  })

  it('matches identity after reorder and rejects a different element at the old index', () => {
    const original = results[1]
    const reordered = [
      target({
        id: 'n1',
        role: 'link',
        name: 'County Library',
        ancestors: original.ancestors,
        inListIndex: 1
      }),
      target({
        id: 'n2',
        role: 'link',
        name: 'City Library',
        ancestors: results[0].ancestors,
        inListIndex: 2
      })
    ]
    const key = targetIdentityKey(original)
    const matches = targetsMatchingIdentity(reordered, key)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.name).toBe('County Library')
    expect(matches[0]?.inListIndex).toBe(1)
  })

  it('requires a fresh observation when identity is missing after a change', () => {
    const key = targetIdentityKey(results[1])
    expect(targetsMatchingIdentity([results[0], results[2]], key)).toHaveLength(0)
  })

  it('keeps preferred controls when truncating', () => {
    const many = Array.from({ length: 100 }, (_, index) =>
      target({
        id: `x${index}`,
        role: index === 50 ? 'textbox' : 'link',
        name: index === 50 ? 'Main editor' : `Link ${index}`,
        ancestors: index === 50 ? [{ role: 'main', name: 'Article' }] : []
      })
    )
    const selected = preferTargets(many, 80)
    expect(selected.targets).toHaveLength(80)
    expect(selected.truncated).toBe(true)
    expect(selected.targets.some((item) => item.name === 'Main editor')).toBe(true)
  })

  it('prefers the Save inside a dialog when two Saves match by name', () => {
    const picked = preferUniqueTarget([results[3]!, results[4]!], {
      ancestors: [{ role: 'dialog', name: 'Confirm save' }]
    })
    expect(picked?.id).toBe('t4')
    expect(
      preferUniqueTarget([results[3]!, results[4]!], { ancestors: [] })?.ancestors.some(
        (item) => item.role === 'dialog'
      )
    ).toBe(true)
  })

  it('only counts expectTextIncludes when the text is new after the action', () => {
    expect(
      actionExpectationMet({
        beforeText: 'Oak Street is listed here',
        afterText: 'Oak Street is listed here',
        beforeUrl: 'https://example.com/a',
        afterUrl: 'https://example.com/a',
        expectTextIncludes: 'Oak Street'
      })
    ).toBe(false)
    expect(
      actionExpectationMet({
        beforeText: 'Searching…',
        afterText: 'Oak Street is listed here',
        beforeUrl: 'https://example.com/a',
        afterUrl: 'https://example.com/a',
        expectTextIncludes: 'Oak Street'
      })
    ).toBe(true)
    expect(
      actionExpectationMet({
        beforeText: 'home',
        afterText: 'home',
        beforeUrl: 'https://example.com/',
        afterUrl: 'https://example.com/results',
        expectUrlIncludes: '/results'
      })
    ).toBe(true)
  })
})
