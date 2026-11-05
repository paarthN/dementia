export interface CapabilityFlag {
  available: boolean
  reason: string
}

export interface CompanionCapabilities {
  platform: string
  accessibility: CapabilityFlag
  screenRecording: CapabilityFlag
  swiftHelper: CapabilityFlag
}

const screenRecordingReasons: Record<string, string> = {
  granted: 'Screen Recording permission is granted.',
  denied: 'Screen Recording permission is denied.',
  restricted: 'Screen Recording permission is restricted.',
  'not-determined': 'Screen Recording permission has not been requested.',
  unknown: 'Screen Recording permission could not be read.'
}

export function describeCapabilities(input: {
  platform: string
  accessibilityTrusted: boolean
  screenRecordingStatus: string
  swiftHelperRunning?: boolean
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
          }
  }
}
