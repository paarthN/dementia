export interface CapabilityFlag {
  available: boolean
  reason: string
}

export interface CompanionCapabilities {
  platform: string
  accessibility: CapabilityFlag
  screenRecording: CapabilityFlag
  swiftHelper: CapabilityFlag
  helperAccessibility: CapabilityFlag
  helperScreenCapture: CapabilityFlag
}

const screenRecordingReasons: Record<string, string> = {
  granted: 'Screen Recording permission is granted.',
  denied: 'Screen Recording permission is denied.',
  restricted: 'Screen Recording permission is restricted.',
  'not-determined': 'Screen Recording permission has not been requested.',
  unknown: 'Screen Recording permission could not be read.'
}

function helperFlag(
  trusted: boolean | null | undefined,
  granted: string,
  missing: string
): CapabilityFlag {
  if (trusted === true) {
    return { available: true, reason: granted }
  }
  if (trusted === false) {
    return { available: false, reason: missing }
  }
  return { available: false, reason: 'The Companion helper has not reported this permission yet.' }
}

export function describeCapabilities(input: {
  platform: string
  accessibilityTrusted: boolean
  screenRecordingStatus: string
  swiftHelperRunning?: boolean
  helperAccessibilityTrusted?: boolean | null
  helperScreenCaptureAllowed?: boolean | null
}): CompanionCapabilities {
  const onMac = input.platform === 'darwin'

  const accessibility: CapabilityFlag = !onMac
    ? {
        available: false,
        reason: 'Accessibility is only checked on macOS.'
      }
    : input.accessibilityTrusted
      ? {
          available: true,
          reason: 'Accessibility trust is granted for this app.'
        }
      : {
          available: false,
          reason: 'Accessibility trust is not granted.'
        }

  const screenRecording: CapabilityFlag = !onMac
    ? {
        available: false,
        reason: 'Screen Recording is only checked on macOS.'
      }
    : {
        available: input.screenRecordingStatus === 'granted',
        reason:
          screenRecordingReasons[input.screenRecordingStatus] ??
          'Screen Recording permission could not be read.'
      }

  return {
    platform: input.platform,
    accessibility,
    screenRecording,
    swiftHelper: !onMac
      ? {
          available: false,
          reason: 'The Swift helper only runs on macOS.'
        }
      : input.swiftHelperRunning
        ? {
            available: true,
            reason: 'The Swift helper answered system.ping.'
          }
        : {
            available: false,
            reason: 'The Swift helper is not running.'
          },
    helperAccessibility: helperFlag(
      onMac ? input.helperAccessibilityTrusted : false,
      'Accessibility is granted for the Companion helper.',
      'Accessibility is not granted for the Companion helper. The Electron grant does not cover it.'
    ),
    helperScreenCapture: helperFlag(
      onMac ? input.helperScreenCaptureAllowed : false,
      'Screen Recording is granted for the Companion helper.',
      'Screen Recording is not granted for the Companion helper. The Electron grant does not cover it.'
    )
  }
}
