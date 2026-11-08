import { desktopCapturer, systemPreferences } from 'electron'
import { readPermission, shouldRequestOsPermission } from '../../shared/permissionPrompt'
import { classifyMediaAccess, type MediaGrant } from '../../shared/systemPermissions'

export interface SystemMediaPrompt {
  microphone: MediaGrant
  screen: MediaGrant
}

let inflight: Promise<SystemMediaPrompt> | null = null
const asked = { microphone: false, screen: false }

function currentStatus(kind: 'microphone' | 'screen'): string {
  try {
    return systemPreferences.getMediaAccessStatus(kind)
  } catch {
    return 'unknown'
  }
}

function grantFromReading(reading: ReturnType<typeof readPermission>): MediaGrant {
  if (reading === 'granted') {
    return 'granted'
  }
  if (reading === 'denied' || reading === 'restricted') {
    return 'denied'
  }
  return 'unknown'
}

async function microphoneGrant(): Promise<MediaGrant> {
  try {
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
  } catch {
    try {
      return classifyMediaAccess(systemPreferences.getMediaAccessStatus('microphone'))
    } catch {
      return 'unknown'
    }
  }
}

async function screenGrant(): Promise<MediaGrant> {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    })
    return classifyMediaAccess(systemPreferences.getMediaAccessStatus('screen'))
  } catch {
    try {
      return classifyMediaAccess(systemPreferences.getMediaAccessStatus('screen'))
    } catch {
      return 'unknown'
    }
  }
}

async function promptOnce(): Promise<SystemMediaPrompt> {
  if (process.platform !== 'darwin') {
    return { microphone: 'unknown', screen: 'unknown' }
  }

  const microphoneReading = readPermission(currentStatus('microphone'))
  const screenReading = readPermission(currentStatus('screen'))
  const promptMicrophone = shouldRequestOsPermission(microphoneReading, asked.microphone)
  const promptScreen = shouldRequestOsPermission(screenReading, asked.screen)
  if (promptMicrophone) {
    asked.microphone = true
  }
  if (promptScreen) {
    asked.screen = true
  }
  return {
    microphone: promptMicrophone ? await microphoneGrant() : grantFromReading(microphoneReading),
    screen: promptScreen ? await screenGrant() : grantFromReading(screenReading)
  }
}

export function promptSystemMedia(): Promise<SystemMediaPrompt> {
  if (!inflight) {
    inflight = promptOnce().finally(() => {
      inflight = null
    })
  }
  return inflight
}
