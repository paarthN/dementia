import type { UiControl, UiSnapshot } from './inspection'

const structuralRoles = new Set([
  'AXWindow',
  'AXMenuBar',
  'AXApplication',
  'AXGroup',
  'AXScrollArea',
  'AXSplitGroup',
  'AXLayoutArea',
  'AXList',
  'AXOutline',
  'AXScrollBar',
  'AXSplitter',
  'AXToolbar',
  'AXWebArea'
])

const pressableRoles = new Set([
  'AXButton',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXLink',
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXIncrementor',
  'AXSlider',
  'AXDisclosureTriangle',
  'AXCell'
])

const secureRoles = new Set(['AXSecureTextField', 'AXPasswordField'])

const protectedCopy =
  "I can't work with that secure screen. If this is a password or lock screen, you should decide. I won't press Continue."

export interface ControlLookup {
  matchCount: number
  summary: string
  name?: string
  role?: string
  appName?: string
  blocked?: boolean
  match?: UiControl
}

export function normalizeControlName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.…]+$/u, '')
    .trim()
}

export function cleanControlName(value: string): string {
  return value
    .trim()
    .replace(/[.?!]+$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+(?:button|menu|item|control|field)$/i, '')
    .trim()
}

export function sensitiveControlName(value: string): boolean {
  return /\b(password|passcode|pin)\b/i.test(value)
}

const menuForControl: Record<string, string> = {
  save: 'File',
  'save as': 'File',
  open: 'File',
  print: 'File',
  close: 'File',
  copy: 'Edit',
  paste: 'Edit',
  cut: 'Edit',
  undo: 'Edit',
  redo: 'Edit',
  find: 'Edit',
  bold: 'Format',
  italic: 'Format',
  underline: 'Format'
}

export function menuFor(name: string): string | null {
  return menuForControl[normalizeControlName(name)] ?? null
}

export function findVisibleControls(
  snapshot: UiSnapshot | null,
  name: string,
  role?: string
): UiControl[] {
  return namedControls(snapshot, name, role).filter((control) => control.enabled)
}

export function findPressableControls(
  snapshot: UiSnapshot | null,
  name: string,
  role?: string
): UiControl[] {
  return findVisibleControls(snapshot, name, role).filter((control) =>
    pressableRoles.has(control.role)
  )
}

export function describeControlMatch(
  snapshot: UiSnapshot | null,
  name: string,
  role?: string
): ControlLookup {
  const appName = snapshot?.processName || snapshot?.bundleId
  const app = appName ? { appName } : {}
  if (!normalizeControlName(name)) {
    return { matchCount: 0, summary: 'What should I press?', ...app }
  }
  if (sensitiveControlName(name)) {
    return { matchCount: 0, blocked: true, summary: "I won't press a password field.", ...app }
  }
  if (!snapshot) {
    return { matchCount: 0, summary: missingControlCopy(name), ...app }
  }
  if (snapshot.protected || snapshot.controls.some((control) => secureRoles.has(control.role))) {
    return { matchCount: 0, blocked: true, summary: protectedCopy, ...app }
  }
  const visible = findVisibleControls(snapshot, name, role)
  const pressable = visible.filter((control) => pressableRoles.has(control.role))
  if (pressable.length === 1) {
    const match = pressable[0]!
    return {
      matchCount: 1,
      summary: appName ? `Click ${match.name} in ${appName}.` : `Click ${match.name}.`,
      name: match.name,
      role: match.role,
      match,
      ...app
    }
  }
  if (pressable.length > 1) {
    return { matchCount: pressable.length, summary: whichControlQuestion(pressable), ...app }
  }
  if (visible.length === 1) {
    return {
      matchCount: 0,
      summary: `I can point at ${visible[0]!.name}, but I can't press it.`,
      ...app
    }
  }
  const disabled = namedControls(snapshot, name, role).filter((control) => !control.enabled)
  if (disabled.length > 0) {
    return {
      matchCount: 0,
      summary: `${disabled[0]!.name} is on the screen, but it isn't available.`,
      ...app
    }
  }
  return { matchCount: 0, summary: missingControlCopy(name), ...app }
}

export function missingControlCopy(name: string): string {
  const shown = name.trim() || 'that'
  const hint = keyboardHint(shown)
  const base = `I can't find ${shown} on this screen.`
  return hint ? `${base} ${hint}` : base
}

export function whichControlQuestion(matches: UiControl[]): string {
  const names = matches
    .slice(0, 4)
    .map((control) => `${control.name} (${controlNoun(control.role)})`)
  return `Which one should I use? ${names.join(', ')}.`
}

export function pressPreview(input: Record<string, unknown>): string {
  const name =
    typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'that control'
  const app = typeof input.appName === 'string' && input.appName.trim() ? input.appName.trim() : ''
  const where = app ? `${name} in ${app}` : name
  if (typeof input.text === 'string' && input.text) {
    return `I'll type “${input.text}” into ${where}.`
  }
  return `I'll click ${where}.`
}

export function controlSignature(snapshot: UiSnapshot | null): string {
  if (!snapshot) {
    return ''
  }
  const controls = snapshot.controls
    .map((control) => `${control.role}:${normalizeControlName(control.name)}:${control.enabled}`)
    .join('|')
  return `${snapshot.title}\n${snapshot.bundleId ?? ''}\n${controls}`
}

export function controlNoun(role: string): string {
  switch (role) {
    case 'AXButton':
      return 'button'
    case 'AXMenuItem':
      return 'menu item'
    case 'AXMenuBarItem':
      return 'menu'
    case 'AXCheckBox':
      return 'checkbox'
    case 'AXRadioButton':
      return 'radio button'
    case 'AXTextField':
    case 'AXTextArea':
    case 'AXComboBox':
      return 'text field'
    case 'AXPopUpButton':
    case 'AXMenuButton':
      return 'menu'
    case 'AXLink':
      return 'link'
    default:
      return 'control'
  }
}

function keyboardHint(name: string): string | null {
  const hints: Record<string, string> = {
    save: 'Press Command-S.',
    bold: 'Press Command-B.',
    italic: 'Press Command-I.',
    copy: 'Press Command-C.',
    paste: 'Press Command-V.',
    cut: 'Press Command-X.',
    undo: 'Press Command-Z.',
    find: 'Press Command-F.'
  }
  return hints[normalizeControlName(name)] ?? null
}

function namedControls(snapshot: UiSnapshot | null, name: string, role?: string): UiControl[] {
  if (!snapshot || snapshot.protected || sensitiveControlName(name)) {
    return []
  }
  if (snapshot.controls.some((control) => secureRoles.has(control.role))) {
    return []
  }
  const expected = normalizeControlName(name)
  if (!expected) {
    return []
  }
  return snapshot.controls.filter((control) => {
    if (structuralRoles.has(control.role) || secureRoles.has(control.role)) {
      return false
    }
    if (role && control.role !== role) {
      return false
    }
    if (
      !control.bounds ||
      control.bounds.width <= 0 ||
      control.bounds.height <= 0 ||
      control.offscreen
    ) {
      return false
    }
    return normalizeControlName(control.name) === expected
  })
}
