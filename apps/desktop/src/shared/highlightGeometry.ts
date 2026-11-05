import type { UiRect } from './inspection'

export interface DisplaySpace {
  id: string
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
}

export interface PlacedHighlight {
  displayId: string
  x: number
  y: number
  width: number
  height: number
  dipWidth: number
  physicalWidth: number
}

export function placeHighlight(
  bounds: UiRect | null,
  displays: DisplaySpace[]
): PlacedHighlight | null {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return null
  }
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  const display = displays.find(
    (item) =>
      centerX >= item.x &&
      centerX < item.x + item.width &&
      centerY >= item.y &&
      centerY < item.y + item.height
  )
  if (!display) {
    return null
  }
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  return {
    displayId: display.id,
    x: bounds.x - display.x,
    y: bounds.y - display.y,
    width: bounds.width,
    height: bounds.height,
    dipWidth: bounds.width,
    physicalWidth: bounds.width * scale
  }
}

export function guidanceOverlayWindowOptions(display: DisplaySpace): {
  x: number
  y: number
  width: number
  height: number
  transparent: true
  frame: false
  focusable: false
  alwaysOnTop: true
  hasShadow: false
  skipTaskbar: true
  roundedCorners: false
  backgroundColor: '#00000000'
  show: false
  type: 'panel'
  ignoreMouseEvents: true
} {
  return {
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
    transparent: true,
    frame: false,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    roundedCorners: false,
    backgroundColor: '#00000000',
    show: false,
    type: 'panel',
    ignoreMouseEvents: true
  }
}

export function applyGuidanceOverlayBehavior(target: {
  setIgnoreMouseEvents: (ignore: boolean) => void
  setFocusable: (focusable: boolean) => void
  setAlwaysOnTop: (flag: boolean, level?: 'floating') => void
  setVisibleOnAllWorkspaces: (visible: boolean, options?: { visibleOnFullScreen?: boolean }) => void
}): void {
  target.setIgnoreMouseEvents(true)
  target.setFocusable(false)
  target.setAlwaysOnTop(true, 'floating')
  target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
}

export function overlayPlacements(
  highlight: PlacedHighlight | null,
  displays: DisplaySpace[]
): { displayId: string; box: PlacedHighlight }[] {
  if (!highlight) {
    return []
  }
  const display = displays.find((item) => item.id === highlight.displayId)
  if (!display) {
    return []
  }
  return [{ displayId: display.id, box: highlight }]
}
