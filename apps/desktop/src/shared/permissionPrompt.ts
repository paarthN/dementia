export type PermissionReading = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface HelperPermissionStatus {
  accessibilityTrusted: boolean
  screenCaptureAllowed: boolean
}

export interface HelperPromptPlan {
  promptAccessibility: boolean
  promptScreenCapture: boolean
  missing: string[]
}

export function readPermission(status: string): PermissionReading {
  if (
    status === 'granted' ||
    status === 'denied' ||
    status === 'restricted' ||
    status === 'not-determined'
  ) {
    return status
  }
  return 'unknown'
}

export function shouldRequestOsPermission(
  reading: PermissionReading,
  alreadyAsked: boolean
): boolean {
  if (alreadyAsked || reading === 'granted' || reading === 'denied' || reading === 'restricted') {
    return false
  }
  return reading === 'not-determined' || reading === 'unknown'
}

export function planHelperPrompts(input: {
  accessibilityTrusted: boolean | null
  screenCaptureAllowed: boolean | null
  askedAccessibility: boolean
  askedScreenCapture: boolean
  userRequestedScreen: boolean
}): HelperPromptPlan {
  const missing: string[] = []
  if (input.accessibilityTrusted === null) {
    missing.push('The Companion helper is not running, so Accessibility could not be checked.')
  } else if (!input.accessibilityTrusted) {
    missing.push('Accessibility is not granted for the Companion helper.')
  }
  if (input.screenCaptureAllowed === null) {
    missing.push('The Companion helper is not running, so Screen Recording could not be checked.')
  } else if (!input.screenCaptureAllowed) {
    missing.push('Screen Recording is not granted for the Companion helper.')
  }
  return {
    promptAccessibility: input.accessibilityTrusted === false && !input.askedAccessibility,
    promptScreenCapture:
      input.userRequestedScreen &&
      input.screenCaptureAllowed === false &&
      !input.askedScreenCapture,
    missing
  }
}

export function readHelperPermissionStatus(value: unknown): HelperPermissionStatus | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.accessibilityTrusted !== 'boolean' ||
    typeof record.screenCaptureAllowed !== 'boolean'
  ) {
    return null
  }
  return {
    accessibilityTrusted: record.accessibilityTrusted,
    screenCaptureAllowed: record.screenCaptureAllowed
  }
}
