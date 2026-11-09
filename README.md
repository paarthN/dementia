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

`npm run dev` opens the mascot. Click it for Home, Settings, and Chat. Home can save and launch an app or an https website, and it can save a local reminder. Chat can open a known app, search the web, change Companion's text, open a System Settings page, set a reminder, and explain the front window after you allow screen access. Ask it to show you how to save in TextEdit, or how to open Mac text-size settings, and it highlights one control at a time. Settings can turn on push-to-talk and spoken replies. Cloud mode is off until you accept the disclosure and enter your assistant server. `npm run assistant-proxy` starts that server; it reads `ASSISTANT_API_KEY` from the environment and the desktop app does not. Desktop clicks and typing use the `peekaboo` command when it is installed and allowed in Accessibility and Screen Recording. Demo mode does not contact the server. Settings changes Companion only. The inspection details toggle stays off until you turn it on. Reminders notify only while the app is running. The renderer has no Node.js access. DevTools stay off unless the app is running from the electron-vite dev server.

`npm run build` typechecks and bundles the app with electron-vite. It does not produce an installer.

## What works on this Mac

Verified on macOS 15.5, Apple Silicon. macOS 14 and Intel Macs were not tested. The packaged app's Info.plist still says the minimum system version is 13.0 because Electron wrote that line. That is not a tested floor.

Chat can open a known app, search the web, change Companion's own text, open a System Settings page, set a reminder, and explain the front window after screen access is allowed. It can highlight TextEdit's Save menu and one Accessibility setting. It does not change the Mac setting for you.

On 2026-11-05 a controlled run typed “Hello from Companion” into a temporary TextEdit note, brought Finder forward, opened the Displays page in System Settings, and opened Companion's own browser on a local page. The note was not saved. No Mac setting was changed. Those steps were reported by the tools. The windows were not watched in that run. Send, Buy, Delete, Upload, and Submit are refused. Passwords and one-time codes are refused.

Companion does not read Mail, Calendar, or your everyday Safari or Chrome. Agent Browser is a separate Chromium window. It is not your browser profile.

## Permissions

The first time the panel opens, Companion may ask for the microphone and for screen recording, and the helper may ask for Accessibility. Each of those is asked at most once per launch. A denial is not asked again until you quit and reopen. Allow screen can ask for the helper's Screen Recording once in that launch. Electron's grant and the helper's grant are separate. A new signature can make macOS ask again.

Screen pictures are taken only while screen access is on. They are not written to the activity log.

## Privacy and cost

Demo mode is the default. It stays on this Mac. Cloud mode stays off until Settings explains what is sent and you accept it. The model key stays in `backend/assistant-proxy`. Companion does not bill you. If you run the proxy with an OpenAI key, OpenAI bills that key. No paid model call was made for the packaging check, so the measured cost of that run is zero. A cloud task can make at most 30 model requests. If a picture is sent, OpenAI keeps the response for at least 30 days.

## Package a local app

From the repository root, after `npm install`, `npm run build:helper`, and `npx playwright install chromium`:

```bash
npm run package:mac
```

That writes `apps/desktop/dist/mac-arm64/Companion.app`. The helper and Agent Browser's Chromium are inside the app. The app does not download them when it runs, and it does not use Homebrew. The signature is ad-hoc. Gatekeeper rejects it. It is not notarized, and it is not a public release. There is no Developer ID certificate in this project yet.

To remove that build, quit Companion from the menu bar, turn off Launch at login in Settings, and delete the `.app`. Quitting stops the helper and Agent Browser. That does not delete Companion's data. Data for a packaged app is under `~/Library/Application Support/Companion`, including the Agent Browser profile and `companion.sqlite`. Delete that folder only when you mean to erase reminders and the browser profile. Deleting the relocated test copy during packaging does not touch that folder.

Help lists what this copy can and cannot do. Mail, Calendar, purchases, and passwords are not available. The first launch shows that same list until you choose Got it.

Settings can save a redacted crash note on this Mac. It is off unless you turn it on. The note is not uploaded, and it does not keep your messages or screenshots.
