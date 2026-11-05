import { describe, expect, it } from 'vitest'
import { describeCapabilities } from '../src/shared/capabilities'

describe('describeCapabilities', () => {
  it('reports macOS permission flags and never claims the Swift helper is running', () => {
    const capabilities = describeCapabilities({
      platform: 'darwin',
      accessibilityTrusted: true,
      screenRecordingStatus: 'denied'
    })

    expect(capabilities.platform).toBe('darwin')
    expect(capabilities.accessibility).toEqual({
      available: true,
      reason: 'Accessibility trust is granted for this app.'
    })
    expect(capabilities.screenRecording.available).toBe(false)
    expect(capabilities.swiftHelper).toEqual({
      available: false,
      reason: 'The Swift helper is not running.'
    })
  })

  it('reports the helper only after a real ping', () => {
    const capabilities = describeCapabilities({
      platform: 'darwin',
      accessibilityTrusted: false,
      screenRecordingStatus: 'granted',
      swiftHelperRunning: true
    })
    expect(capabilities.swiftHelper).toEqual({
      available: true,
      reason: 'The Swift helper answered system.ping.'
    })
  })

  it('keeps every flag unavailable off macOS', () => {
    const capabilities = describeCapabilities({
      platform: 'linux',
      accessibilityTrusted: true,
      screenRecordingStatus: 'granted'
    })

    expect(capabilities.platform).toBe('linux')
    expect(capabilities.accessibility.available).toBe(false)
    expect(capabilities.screenRecording.available).toBe(false)
    expect(capabilities.swiftHelper.available).toBe(false)
  })
})
