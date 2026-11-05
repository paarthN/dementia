import { systemPreferences } from 'electron'
import { describeCapabilities, type CompanionCapabilities } from '../../shared/capabilities'

function screenRecordingStatus(): string {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }

  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return 'unknown'
  }
}

function accessibilityTrusted(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }

  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

export function readCapabilities(swiftHelperRunning = false): CompanionCapabilities {
  return describeCapabilities({
    platform: process.platform,
    accessibilityTrusted: accessibilityTrusted(),
    screenRecordingStatus: screenRecordingStatus(),
    swiftHelperRunning
  })
}
