import { z } from 'zod'
import type { DisplaySpace } from '../../shared/highlightGeometry'
import { HelperCallError, type OsBridge } from '../services/osBridge'
import {
  desktopSnapshotTtlMs,
  type DesktopAutomationPort,
  type DesktopObservation,
  type DesktopOutcome
} from './ports/DesktopAutomationPort'
import { CaptureFileError, readOwnedCapture, safeUnlink } from './security/CaptureFile'
import {
  observationForModel,
  observationHasSecret,
  validateCaptureGeometry,
  type CaptureGeometry
} from './security/ObservationRedaction'

const captureSchema = z
  .object({
    windowId: z.string().min(1).max(80),
    processId: z.number().int(),
    bundleId: z.string().min(1).max(200),
    title: z.string().max(80),
    displayId: z.string().min(1).max(40),
    scale: z.number().finite(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pointWidth: z.number().finite().positive(),
    pointHeight: z.number().finite().positive(),
    byteLength: z.number().int().positive(),
    filePath: z.string().min(1).max(1024),
    directory: z.string().min(1).max(1024),
    blank: z.literal(false),
    protected: z.literal(false)
  })
  .strict()

export interface ObservationScreen {
  status: () => { access: 'off' | 'on'; captureActive: boolean }
  beginCapture: () => AbortSignal | null
  finishCapture: () => void
}

export function createObservationService(options: {
  desktop: DesktopAutomationPort
  bridge: OsBridge
  screen: ObservationScreen
  displays?: () => DisplaySpace[]
  now?: () => number
  ttlMs?: number
  onActivity?: () => void
}): {
  observe: DesktopAutomationPort['observe']
} {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? desktopSnapshotTtlMs

  return {
    async observe(input, callOptions) {
      const seen = await options.desktop.observe(
        { ...(input.windowId ? { windowId: input.windowId } : {}), includeImage: false },
        callOptions
      )
      if (!input.includeImage || seen.status !== 'success_verified' || !seen.observation) {
        return seen
      }
      if (observationHasSecret(seen.observation)) {
        return blocked(seen.observation)
      }
      const identity = seen.observation
      if (!identity.app.bundleId || identity.app.processId === undefined) {
        return {
          ...seen,
          summary: `${seen.summary} I did not take a picture.`
        }
      }
      if (options.screen.status().access !== 'on') {
        return {
          ...seen,
          summary: `${seen.summary} I did not take a picture.`
        }
      }
      const capturedAt = Date.parse(identity.capturedAtUtc)
      if (!Number.isFinite(capturedAt) || now() - capturedAt > ttlMs) {
        return {
          status: 'unsupported',
          summary: 'That look at the window is out of date. I need to look again.',
          errorCode: 'stale_snapshot',
          observation: { ...identity, imageIncluded: false, image: undefined }
        }
      }
      const captureSignal = options.screen.beginCapture()
      if (!captureSignal) {
        return {
          status: 'failed',
          summary: "I'm already looking at the screen.",
          errorCode: 'capture_busy',
          observation: { ...identity, imageIncluded: false, image: undefined }
        }
      }
      options.onActivity?.()
      const linked = linkSignals(captureSignal, callOptions?.signal)
      try {
        if (linked.signal.aborted || options.screen.status().access !== 'on') {
          return stopped(identity)
        }
        let raw: unknown
        try {
          raw = await options.bridge.request(
            'desktop.captureWindow',
            {
              consent: true,
              prompt: false,
              windowId: identity.window.id,
              bundleId: identity.app.bundleId,
              processId: identity.app.processId
            },
            { timeoutMs: 15_000, signal: linked.signal }
          )
        } catch (error) {
          return fromCaptureError(error, identity)
        }
        if (linked.signal.aborted || options.screen.status().access !== 'on') {
          cleanupClaim(raw)
          return stopped(identity)
        }
        const parsed = captureSchema.safeParse(raw)
        if (!parsed.success) {
          cleanupClaim(raw)
          return {
            status: 'failed',
            summary: "I couldn't use that picture, so I discarded it.",
            errorCode: 'bad_observation',
            observation: { ...identity, imageIncluded: false, image: undefined }
          }
        }
        const geometry: CaptureGeometry = parsed.data
        const rejection = validateCaptureGeometry({
          expected: {
            windowId: identity.window.id,
            processId: identity.app.processId,
            bundleId: identity.app.bundleId
          },
          capture: geometry,
          displays: options.displays?.() ?? []
        })
        if (rejection) {
          safeUnlink(parsed.data.filePath, parsed.data.directory)
          return rejected(identity, rejection)
        }
        try {
          const bytes = readOwnedCapture({
            filePath: parsed.data.filePath,
            directory: parsed.data.directory
          })
          if (bytes.length !== parsed.data.byteLength) {
            return rejected(identity, 'too_large')
          }
          return pictured(seen, identity, bytes, parsed.data)
        } catch (error) {
          if (error instanceof CaptureFileError && error.code === 'too_large') {
            return rejected(identity, 'too_large')
          }
          if (error instanceof CaptureFileError && error.code === 'permissions') {
            return {
              status: 'failed',
              summary: "I couldn't use that picture, so I discarded it.",
              errorCode: 'capture_permissions',
              observation: { ...identity, imageIncluded: false, image: undefined }
            }
          }
          return {
            status: 'failed',
            summary: "I couldn't use that picture, so I discarded it.",
            errorCode: 'bad_observation',
            observation: { ...identity, imageIncluded: false, image: undefined }
          }
        } finally {
          safeUnlink(parsed.data.filePath, parsed.data.directory)
        }
      } finally {
        options.screen.finishCapture()
        options.onActivity?.()
      }
    }
  }
}

export function createObservingDesktopPort(
  desktop: DesktopAutomationPort,
  observations: { observe: DesktopAutomationPort['observe'] }
): DesktopAutomationPort {
  return {
    ...desktop,
    observe(input, callOptions) {
      if (input.includeImage) {
        return observations.observe(input, callOptions)
      }
      return desktop.observe(input, callOptions)
    }
  }
}

export { observationForModel }

function pictured(
  seen: DesktopOutcome,
  identity: DesktopObservation,
  bytes: Buffer,
  capture: z.infer<typeof captureSchema>
): DesktopOutcome {
  return {
    status: 'success_verified',
    summary: `${seen.summary} I kept a picture of that window on this Mac. I did not send it anywhere.`,
    observation: {
      ...identity,
      imageIncluded: true,
      image: {
        mime: 'image/png',
        bytes: Uint8Array.from(bytes),
        width: capture.width,
        height: capture.height,
        displayId: capture.displayId,
        scale: capture.scale
      }
    }
  }
}

function blocked(observation: DesktopObservation): DesktopOutcome {
  return {
    status: 'blocked_sensitive',
    summary: "I can't work with that secure screen.",
    errorCode: 'protected_context',
    observation: {
      ...observation,
      protected: true,
      targets: [],
      imageIncluded: false,
      image: undefined
    }
  }
}

function stopped(observation: DesktopObservation): DesktopOutcome {
  return {
    status: 'cancelled',
    summary: 'Screen access has stopped.',
    errorCode: 'capture_revoked',
    observation: { ...observation, imageIncluded: false, image: undefined }
  }
}

function rejected(observation: DesktopObservation, rejection: string): DesktopOutcome {
  if (rejection === 'wrong_window') {
    return {
      status: 'failed',
      summary: 'That picture was of a different window, so I discarded it.',
      errorCode: 'wrong_window',
      observation: { ...observation, imageIncluded: false, image: undefined }
    }
  }
  if (rejection === 'blank' || rejection === 'protected') {
    return {
      status: 'failed',
      summary: 'The picture was blank, so I discarded it.',
      errorCode: rejection === 'protected' ? 'protected_context' : 'protected_capture',
      observation: { ...observation, imageIncluded: false, image: undefined }
    }
  }
  if (rejection === 'too_large') {
    return {
      status: 'failed',
      summary: 'That picture was too large, so I discarded it.',
      errorCode: 'capture_too_large',
      observation: { ...observation, imageIncluded: false, image: undefined }
    }
  }
  return {
    status: 'failed',
    summary: "I couldn't match that picture to the window, so I discarded it.",
    errorCode: 'bad_scale',
    observation: { ...observation, imageIncluded: false, image: undefined }
  }
}

function fromCaptureError(error: unknown, observation: DesktopObservation): DesktopOutcome {
  if (error instanceof HelperCallError) {
    if (error.code === 'aborted' || error.code === 'timeout') {
      return error.code === 'aborted'
        ? stopped(observation)
        : {
            status: 'failed',
            summary: "I couldn't take a picture, so I did not send one.",
            errorCode: 'capture_unavailable',
            observation: { ...observation, imageIncluded: false, image: undefined }
          }
    }
    if (error.code === 'protected_capture') {
      return rejected(observation, 'blank')
    }
    if (error.code === 'protected_context') {
      return blocked(observation)
    }
    if (error.code === 'capture_refused' || error.code === 'access_denied') {
      return {
        status: 'needs_permission',
        summary: "I won't look at your screen.",
        errorCode: 'capture_refused',
        observation: { ...observation, imageIncluded: false, image: undefined }
      }
    }
    return {
      status: 'failed',
      summary: error.message,
      errorCode: error.code,
      observation: { ...observation, imageIncluded: false, image: undefined }
    }
  }
  return {
    status: 'failed',
    summary: "I couldn't take a picture, so I did not send one.",
    errorCode: 'capture_unavailable',
    observation: { ...observation, imageIncluded: false, image: undefined }
  }
}

function cleanupClaim(value: unknown): void {
  if (!value || typeof value !== 'object') {
    return
  }
  const record = value as { filePath?: unknown; directory?: unknown }
  if (typeof record.filePath === 'string' && typeof record.directory === 'string') {
    safeUnlink(record.filePath, record.directory)
  }
}

function linkSignals(capture: AbortSignal, caller: AbortSignal | undefined): AbortController {
  const linked = new AbortController()
  const stop = (): void => {
    linked.abort()
  }
  if (capture.aborted || caller?.aborted) {
    linked.abort()
  }
  capture.addEventListener('abort', stop, { once: true })
  caller?.addEventListener('abort', stop, { once: true })
  return linked
}
