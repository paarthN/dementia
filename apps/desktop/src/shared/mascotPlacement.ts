export interface WorkArea {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface WindowSize {
  width: number
  height: number
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

export function resolveWorkArea(
  areas: readonly WorkArea[],
  monitorId: string | null,
  primaryId: string
): WorkArea {
  if (areas.length === 0) {
    return { id: primaryId, x: 0, y: 0, width: 1280, height: 800 }
  }
  return (
    areas.find((area) => area.id === monitorId) ??
    areas.find((area) => area.id === primaryId) ??
    areas[0]
  )
}

export function unitToScreen(
  area: WorkArea,
  normalizedX: number,
  normalizedY: number,
  size: WindowSize
): { x: number; y: number } {
  const spanX = Math.max(0, area.width - size.width)
  const spanY = Math.max(0, area.height - size.height)
  return {
    x: Math.round(area.x + clampUnit(normalizedX) * spanX),
    y: Math.round(area.y + clampUnit(normalizedY) * spanY)
  }
}

export function screenToUnit(
  area: WorkArea,
  x: number,
  y: number,
  size: WindowSize
): { normalizedX: number; normalizedY: number } {
  const spanX = Math.max(1, area.width - size.width)
  const spanY = Math.max(1, area.height - size.height)
  return {
    normalizedX: clampUnit((x - area.x) / spanX),
    normalizedY: clampUnit((y - area.y) / spanY)
  }
}

export function clampScreenPoint(
  area: WorkArea,
  x: number,
  y: number,
  size: WindowSize
): { x: number; y: number } {
  const minX = area.x
  const minY = area.y
  const maxX = area.x + Math.max(0, area.width - size.width)
  const maxY = area.y + Math.max(0, area.height - size.height)
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, x))),
    y: Math.round(Math.min(maxY, Math.max(minY, y)))
  }
}

export function mascotWindowSize(
  collapsed: boolean,
  mascotSize: 'small' | 'medium' | 'large'
): WindowSize {
  if (collapsed) {
    return { width: 56, height: 88 }
  }
  const character = mascotSize === 'small' ? 72 : mascotSize === 'large' ? 120 : 96
  return { width: Math.max(220, character + 80), height: character + 220 }
}
