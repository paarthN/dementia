import type { UiControl, UiSnapshot } from './inspection'
import { placeHighlight, type DisplaySpace, type PlacedHighlight } from './highlightGeometry'

export const guideIds = ['textedit.save', 'accessibility.display'] as const
export type GuideId = (typeof guideIds)[number]
export type GuideStatus = 'showing' | 'manual' | 'completed' | 'stopped' | 'missing'

export interface GuideView {
  guideId: GuideId
  stepIndex: number
  stepCount: number
  stepLabel: string
  status: GuideStatus
  instruction: string
  highlight: PlacedHighlight | null
}

export interface GuideState {
  guideId: GuideId
  stepIndex: number
  status: GuideStatus
}

export type GuideAction = 'did_it' | 'repeat' | 'cant_find' | 'manual' | 'stop' | 'refresh'

export function isGuideId(value: string): value is GuideId {
  return (guideIds as readonly string[]).includes(value)
}

export function guideUtterance(text: string): GuideAction | null {
  const lower = text.trim().toLowerCase()
  if (/^(i did it|done|next)$/.test(lower)) {
    return 'did_it'
  }
  if (/^repeat/.test(lower)) {
    return 'repeat'
  }
  if (/can'?t find|cannot find/.test(lower)) {
    return 'cant_find'
  }
  if (/^manual$|switch to manual/.test(lower)) {
    return 'manual'
  }
  if (/^stop$/.test(lower)) {
    return 'stop'
  }
  return null
}

export function startGuide(
  guideId: string,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): { state: GuideState; view: GuideView } | null {
  if (!isGuideId(guideId)) {
    return null
  }
  let state: GuideState = { guideId, stepIndex: 0, status: 'showing' }
  if (openingNeedsManual(state, snapshot)) {
    state = { ...state, status: 'manual' }
  }
  return { state, view: presentGuide(state, snapshot, displays) }
}

export function reduceGuide(
  state: GuideState,
  action: GuideAction,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): { state: GuideState; view: GuideView } {
  if (action === 'stop') {
    const next = { ...state, status: 'stopped' as const }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  if (action === 'manual' || action === 'cant_find') {
    const next = {
      ...state,
      status: action === 'cant_find' ? ('missing' as const) : ('manual' as const)
    }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  if (action === 'did_it') {
    return advance(state, snapshot, displays)
  }
  if (action === 'refresh') {
    return refresh(state, snapshot, displays)
  }
  return { state, view: presentGuide(state, snapshot, displays) }
}

function advance(
  state: GuideState,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): { state: GuideState; view: GuideView } {
  if (state.status === 'stopped' || state.status === 'completed') {
    return { state, view: presentGuide(state, snapshot, displays) }
  }
  if (state.guideId === 'textedit.save' && saveDialogOpen(snapshot)) {
    const next = { ...state, status: 'completed' as const }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  if (state.guideId === 'textedit.save' && state.stepIndex === 0 && state.status === 'showing') {
    const next = { ...state, stepIndex: 1, status: 'showing' as const }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  if (
    state.guideId === 'accessibility.display' &&
    state.stepIndex === 0 &&
    state.status === 'showing'
  ) {
    const next = { ...state, stepIndex: 1, status: 'showing' as const }
    const view = presentGuide(next, snapshot, displays)
    if (view.status === 'completed') {
      return { state: { ...next, status: 'completed' }, view }
    }
    return { state: next, view }
  }
  const next = { ...state, status: 'manual' as const }
  return { state: next, view: presentGuide(next, snapshot, displays) }
}

function refresh(
  state: GuideState,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): { state: GuideState; view: GuideView } {
  if (state.status !== 'showing') {
    return { state, view: presentGuide(state, snapshot, displays) }
  }
  if (state.guideId === 'textedit.save' && saveDialogOpen(snapshot)) {
    const next = { ...state, status: 'completed' as const }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  if (
    state.guideId === 'textedit.save' &&
    state.stepIndex === 0 &&
    findControl(snapshot, 'Save', 'AXMenuItem')?.bounds
  ) {
    const next = { ...state, stepIndex: 1, status: 'showing' as const }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  if (targetMissing(state, snapshot)) {
    const next = { ...state, status: 'missing' as const }
    return { state: next, view: presentGuide(next, snapshot, displays) }
  }
  return { state, view: presentGuide(state, snapshot, displays) }
}

function presentGuide(
  state: GuideState,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): GuideView {
  if (state.guideId === 'accessibility.display') {
    return presentAccessibility(state, snapshot, displays)
  }
  return presentTextEdit(state, snapshot, displays)
}

function presentTextEdit(
  state: GuideState,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): GuideView {
  const base = {
    guideId: 'textedit.save' as const,
    stepIndex: state.stepIndex,
    stepCount: 2,
    stepLabel: `Step ${Math.min(state.stepIndex + 1, 2)} of 2`
  }
  if (state.status === 'stopped') {
    return {
      ...base,
      status: 'stopped',
      instruction: 'I stopped. The highlight is gone.',
      highlight: null
    }
  }
  if (state.status === 'completed' || saveDialogOpen(snapshot)) {
    return {
      ...base,
      status: 'completed',
      instruction: "You've opened the Save dialog.",
      highlight: null
    }
  }
  if (state.status === 'missing') {
    return {
      ...base,
      status: 'missing',
      instruction: "I can't reliably find that button. Press Command-S to save.",
      highlight: null
    }
  }
  if (state.status === 'manual') {
    return {
      ...base,
      status: 'manual',
      instruction:
        state.stepIndex === 0
          ? 'Press Command-S to save.'
          : "I couldn't confirm the Save dialog opened. Press Command-S if you still need it.",
      highlight: null
    }
  }
  if (snapshot?.bundleId !== 'com.apple.TextEdit') {
    return {
      ...base,
      stepIndex: 0,
      stepLabel: 'Step 1 of 2',
      status: 'showing',
      instruction: 'Bring TextEdit to the front, then I can point at File.',
      highlight: null
    }
  }
  if (state.stepIndex === 0) {
    const file = findControl(snapshot, 'File', 'AXMenuBarItem')
    if (!file?.bounds) {
      return {
        ...base,
        status: 'manual',
        instruction: 'Press Command-S to save.',
        highlight: null
      }
    }
    return {
      ...base,
      status: 'showing',
      instruction: 'Click File at the top of the window.',
      highlight: placeHighlight(file.bounds, displays)
    }
  }
  const save = findControl(snapshot, 'Save', 'AXMenuItem')
  if (!save?.bounds) {
    return {
      ...base,
      status: 'manual',
      instruction: 'Press Command-S to save.',
      highlight: null
    }
  }
  return {
    ...base,
    status: 'showing',
    instruction: 'Click Save.',
    highlight: placeHighlight(save.bounds, displays)
  }
}

function presentAccessibility(
  state: GuideState,
  snapshot: UiSnapshot | null,
  displays: DisplaySpace[]
): GuideView {
  const base = {
    guideId: 'accessibility.display' as const,
    stepIndex: state.stepIndex,
    stepCount: 2,
    stepLabel: `Step ${Math.min(state.stepIndex + 1, 2)} of 2`
  }
  if (state.status === 'stopped') {
    return {
      ...base,
      status: 'stopped',
      instruction: 'I stopped. The highlight is gone.',
      highlight: null
    }
  }
  if (state.status === 'missing') {
    return {
      ...base,
      status: 'missing',
      instruction:
        "I can't reliably find that button. Choose the Apple menu, System Settings, Accessibility, then Display.",
      highlight: null
    }
  }
  if (state.status === 'completed' || displayPageOpen(snapshot)) {
    return {
      ...base,
      status: 'completed',
      instruction:
        "You're in Display settings. Choose the size you want. I did not change the Mac setting.",
      highlight: null
    }
  }
  if (state.status === 'manual') {
    return {
      ...base,
      status: 'manual',
      instruction:
        'In the sidebar, choose Accessibility, then Display. I did not change the Mac setting.',
      highlight: null
    }
  }
  if (snapshot?.bundleId !== 'com.apple.systempreferences') {
    return {
      ...base,
      stepIndex: 0,
      stepLabel: 'Step 1 of 2',
      status: 'showing',
      instruction:
        "Open System Settings and choose Accessibility. I haven't highlighted anything yet.",
      highlight: null
    }
  }
  const display = findControl(snapshot, 'Display')
  if (display?.bounds) {
    return {
      ...base,
      status: 'showing',
      instruction: 'Click Display in the Accessibility list.',
      highlight: placeHighlight(display.bounds, displays)
    }
  }
  const accessibility = findControl(snapshot, 'Accessibility')
  if (accessibility?.bounds && state.stepIndex === 0) {
    return {
      ...base,
      status: 'showing',
      instruction: 'Click Accessibility in the System Settings sidebar.',
      highlight: placeHighlight(accessibility.bounds, displays)
    }
  }
  return {
    ...base,
    status: 'manual',
    instruction:
      'In the sidebar, choose Accessibility, then Display. I did not change the Mac setting.',
    highlight: null
  }
}

function openingNeedsManual(state: GuideState, snapshot: UiSnapshot | null): boolean {
  if (state.guideId === 'textedit.save') {
    return (
      snapshot?.bundleId === 'com.apple.TextEdit' &&
      !findControl(snapshot, 'File', 'AXMenuBarItem')?.bounds
    )
  }
  return (
    snapshot?.bundleId === 'com.apple.systempreferences' &&
    !findControl(snapshot, 'Display')?.bounds &&
    !findControl(snapshot, 'Accessibility')?.bounds &&
    !displayPageOpen(snapshot)
  )
}

function targetMissing(state: GuideState, snapshot: UiSnapshot | null): boolean {
  if (state.guideId === 'textedit.save') {
    if (snapshot?.bundleId !== 'com.apple.TextEdit') {
      return false
    }
    if (state.stepIndex === 0) {
      return !findControl(snapshot, 'File', 'AXMenuBarItem')?.bounds
    }
    return !findControl(snapshot, 'Save', 'AXMenuItem')?.bounds
  }
  if (snapshot?.bundleId !== 'com.apple.systempreferences') {
    return false
  }
  if (displayPageOpen(snapshot) || findControl(snapshot, 'Display')?.bounds) {
    return false
  }
  if (state.stepIndex === 0 && findControl(snapshot, 'Accessibility')?.bounds) {
    return false
  }
  return true
}

function saveDialogOpen(snapshot: UiSnapshot | null): boolean {
  return Boolean(snapshot && /save/i.test(snapshot.title))
}

function displayPageOpen(snapshot: UiSnapshot | null): boolean {
  if (snapshot?.bundleId !== 'com.apple.systempreferences') {
    return false
  }
  return snapshot.controls.some((control) => /text size|larger text|bold text/i.test(control.name))
}

function findControl(snapshot: UiSnapshot | null, name: string, role?: string): UiControl | null {
  if (!snapshot || snapshot.protected) {
    return null
  }
  const expected = name.toLowerCase()
  return (
    snapshot.controls.find((control) => {
      const actual = control.name
        .trim()
        .toLowerCase()
        .replace(/[.…]+$/u, '')
      return (
        actual === expected &&
        control.role !== 'AXWindow' &&
        control.role !== 'AXMenuBar' &&
        (role === undefined || control.role === role)
      )
    }) ?? null
  )
}
