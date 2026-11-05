export type MicStatus = 'off' | 'listening' | 'unavailable'

export function micStatus(
  enabled: boolean,
  listening: boolean,
  recognizerAvailable: boolean
): MicStatus {
  if (!enabled) {
    return 'off'
  }
  if (!recognizerAvailable) {
    return 'unavailable'
  }
  if (listening) {
    return 'listening'
  }
  return 'off'
}

export function browserSpeechAvailable(host: {
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
}): boolean {
  return Boolean(host.SpeechRecognition ?? host.webkitSpeechRecognition)
}

export function micLabel(status: MicStatus): string {
  if (status === 'listening') {
    return 'Listening now'
  }
  if (status === 'unavailable') {
    return 'Microphone not available'
  }
  return 'Microphone off'
}
