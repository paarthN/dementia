export const onboardingCan = [
  'You can type every request. The microphone is optional.',
  'Companion can open an app, search the web, set a reminder, and change its own text.',
  'Companion can highlight one step for saving in TextEdit, or for Mac text size.',
  'After you allow screen access, Companion can describe the front window.',
  'Agent Browser is a separate window. It is not Safari or your Chrome.'
] as const

export const onboardingCannot = [
  'Companion cannot place a phone call.',
  'Mail and Calendar are not connected.',
  'Companion does not send, buy, delete, upload, or type a password or one-time code.',
  'This copy is not notarized. Another Mac may refuse to open it.'
] as const

export const removalSteps = [
  'Quit Companion from the menu bar.',
  'Turn off Launch at login in Settings before you delete the app.',
  'Delete Companion.app. Quitting stops the helper and Agent Browser.',
  'Your reminders and the Agent Browser profile stay in ~/Library/Application Support/Companion until you delete that folder yourself.'
] as const

export const diagnosticConsentLabel = 'Save a redacted crash note on this Mac'

export const diagnosticConsentDetail =
  'Off by default. The note stays on this Mac and is not sent anywhere. It does not include your messages, recordings, or screenshots.'
