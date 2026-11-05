import { desktopCapturer, systemPreferences } from 'electron'
import { classifyMediaAccess, type MediaGrant } from '../../shared/systemPermissions'

export interface SystemMediaPrompt {
  microphone: MediaGrant
  screen: MediaGrant
}

let inflight: Promise<SystemMediaPrompt> | null = null

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

  return {
    microphone: await microphoneGrant(),
    screen: await screenGrant()
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
