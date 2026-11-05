# Companion

macOS desktop assistant. Phases 0–7 are in the repo: a mascot, Home, Settings, Chat, local reminders, screen explanation, two highlighted guides, and an optional cloud assistant. Demo mode stays on this Mac. The model key, if you use one, stays in `backend/assistant-proxy`.

## Requirements

- macOS
- Node.js 22.12 or newer (verified with 22.22.2)
- npm 10 (verified with 10.9.3)

## Setup

From the repository root:

```bash
npm install
npm run build:helper
```

That installs the workspace, downloads Electron, and writes `package-lock.json`. `npm run build:helper` compiles the Swift helper and gives it an ad-hoc signature. macOS may ask you to allow that helper in Accessibility and Screen Recording. Those grants are separate from Electron's. A new signature can make macOS ask again.

## Commands

```bash
npm run dev
npm run typecheck
npm test
npm run lint
npm run build
```

`npm run dev` opens the mascot. Click it for Home, Settings, and Chat. Home can save and launch an app or an https website, and it can save a local reminder. Chat can open a known app, search the web, change Companion's text, open a System Settings page, set a reminder, and explain the front window after you allow screen access. Ask it to show you how to save in TextEdit, or how to open Mac text-size settings, and it highlights one control at a time. Settings can turn on push-to-talk and spoken replies. Cloud mode is off until you accept the disclosure and enter your assistant server. `npm run assistant-proxy` starts that server; it reads `ASSISTANT_API_KEY` from the environment and the desktop app does not. Demo mode does not contact the server. Settings changes Companion only. The inspection details toggle stays off until you turn it on. Reminders notify only while the app is running. The renderer has no Node.js access. DevTools stay off unless the app is running from the electron-vite dev server.

`npm run build` typechecks and bundles the app with electron-vite. It does not produce a signed installer.
