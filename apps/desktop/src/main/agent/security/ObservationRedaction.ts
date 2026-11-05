import type { DesktopObservation } from '../ports/DesktopAutomationPort'
import type { DisplaySpace } from '../../../shared/highlightGeometry'
import { captureByteLimit, captureEdgeLimit } from './CaptureFile'

const secretRole = /secure|password/i
const secretName = /\b(password|passcode|pin)\b/i

export interface CaptureGeometry {
  windowId: string
  processId: number
  bundleId: string
  displayId: string
  scale: number
  width: number
  height: number
  pointWidth: number
  pointHeight: number
  byteLength: number
  blank: boolean
  protected: boolean
}

export type CaptureRejection = 'wrong_window' | 'blank' | 'protected' | 'bad_scale' | 'too_large'

export function observationHasSecret(observation: DesktopObservation): boolean {
  return (
    observation.protected ||
    observation.targets.some(
      (target) => secretRole.test(target.role) || secretName.test(target.name)
    )
  )
}

export function observationForModel(observation: DesktopObservation): DesktopObservation {
  const secret = observationHasSecret(observation)
  return {
    ...observation,
    protected: secret || observation.protected,
    imageIncluded: false,
    image: undefined,
    targets: secret
      ? []
      : observation.targets.map((target) => {
          const next = { ...target }
          delete next.value
          return next
        })
  }
}

export function validateCaptureGeometry(input: {
  expected: { windowId: string; processId: number; bundleId: string }
  capture: CaptureGeometry
  displays?: DisplaySpace[]
}): CaptureRejection | null {
  const { capture, expected } = input
  if (
    capture.windowId !== expected.windowId ||
    capture.processId !== expected.processId ||
    capture.bundleId !== expected.bundleId
  ) {
    return 'wrong_window'
  }
  if (capture.protected) {
    return 'protected'
  }
  if (capture.blank) {
    return 'blank'
  }
  if (
    capture.width > captureEdgeLimit ||
    capture.height > captureEdgeLimit ||
    capture.byteLength > captureByteLimit ||
    capture.byteLength <= 0
  ) {
    return 'too_large'
  }
  if (!scaleMatches(capture, input.displays ?? [])) {
    return 'bad_scale'
  }
  return null
}

function scaleMatches(capture: CaptureGeometry, displays: DisplaySpace[]): boolean {
  if (!Number.isFinite(capture.scale) || capture.scale < 1 || capture.scale > 4) {
    return false
  }
  if (!Number.isFinite(capture.pointWidth) || !Number.isFinite(capture.pointHeight)) {
    return false
  }
  if (capture.pointWidth <= 0 || capture.pointHeight <= 0) {
    return false
  }
  if (displays.length > 0) {
    const display = displays.find((item) => item.id === capture.displayId)
    if (!display || Math.abs(display.scaleFactor - capture.scale) > 0.01) {
      return false
    }
  }
  const fitted = fittedSize(capture.pointWidth, capture.pointHeight, capture.scale)
  return near(capture.width, fitted.width) && near(capture.height, fitted.height)
}

function fittedSize(
  pointWidth: number,
  pointHeight: number,
  scale: number
): { width: number; height: number } {
  let width = pointWidth * scale
  let height = pointHeight * scale
  const longest = Math.max(width, height)
  if (longest > captureEdgeLimit) {
    const fit = captureEdgeLimit / longest
    width *= fit
    height *= fit
  }
  return { width, height }
}

function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 2
}
