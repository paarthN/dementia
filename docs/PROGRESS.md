# Progress

Living status for Companion. Update this file at the end of each phase with commands run and what actually worked. Do not mark a phase complete because the UI merely resembles the spec.

**Spec version:** 1.1 — 2026-11-04, macOS-first  
**Last updated:** 2026-11-05  
**Product status:** Phases 0–7 are in the repo. Chat can use demo mode on this Mac, or a cloud assistant through a server you run. Phase 8 was not started. A separate computer-use track can ask a cloud model for one tool at a time. Chat does not start that loop yet. See [COMPUTER_AGENT_PROGRESS.md](COMPUTER_AGENT_PROGRESS.md).

## Where to read next

| If you are about to… | Open |
|---|---|
| Decide what the product is | [MASTER_PLAN.md](MASTER_PLAN.md) |
| Implement a feature or a test | [FEATURES.md](FEATURES.md) |
| Build a window, panel, or style | [UI_UX.md](UI_UX.md) |
| Choose a library, schema, or process boundary | [TECH_STACK.md](TECH_STACK.md) |
| Change routing, tools, or verification | [AGENT_SYSTEM.md](AGENT_SYSTEM.md) |
| Touch permissions, capture, or approvals | [SECURITY.md](SECURITY.md) |
| Pick the next build slice | [IMPLEMENTATION.md](IMPLEMENTATION.md) |
| See the next small milestone | [TASKS.md](TASKS.md) |
| See an approved architecture choice | [DECISIONS.md](DECISIONS.md) |

## Next action

**Phase 8 — one OAuth mail or calendar provider.** Not started. Phase 7 passed the checks recorded below on 2026-11-04.

## Phase checklist

- [x] **Phase 0** — Electron, React, TypeScript, Vite, lint, tests, secure preload
- [x] **Phase 1** — Mascot, three entries, drag, menu bar, persistence
- [x] **Phase 2** — Home, favorites, appearance settings, SQLite
- [x] **Phase 3** — Chat, router, policy, safe tools
- [x] **Phase 4** — Local reminders
- [x] **Phase 5** — Swift Accessibility helper and screen explanation
- [x] **Phase 6** — Highlights and two real guides
- [x] **Phase 7** — Optional cloud model and push-to-talk
- [ ] **Phase 8** — One OAuth mail or calendar provider (P1)
- [ ] **Phase 9** — Accessibility audit, signing, install and uninstall

## First useful build

Still open. The bar is in [MASTER_PLAN.md](MASTER_PLAN.md).

- [ ] macOS desktop launch with a mascot above ordinary windows
- [ ] Home, Settings, and Chat by mouse and keyboard
- [ ] Mascot position persists
- [ ] Favorites save and launch valid targets
- [x] Text commands reach a small set of real tools
- [x] Open an app, open a vetted site, search the web, create a local reminder
- [x] Confirmation, honest failure, or a recovery option
- [x] A guidance demo on a real inspected element or a test fixture
- [x] Mock AI mode with no paid services

## Environment

Re-verified on 2026-11-04 before Phase 0 was treated as ready.

| Item | Value |
|---|---|
| OS | macOS 15.5 (24F74), Apple Silicon |
| Node | 22.22.2 |
| Package manager | npm 10.9.3 |
| Swift | 6.1.2, command-line tools |
| Last typecheck | 2026-11-04, `npm run typecheck` passed |
| Last tests | 2026-11-04, `npm test` passed (69 passed, 3 skipped) |
| macOS helper verified | Yes. `system.ping` and real Accessibility reads succeeded. See the Phase 5 log for what was not captured. |

## Log

### 2026-11-05 — Computer-use Phase 4

The assistant proxy has `POST /v1/agent/turn`. It asks the Responses API for at most one tool, then returns the name and arguments. It does not click, type, or capture. The desktop runs the tool only after the existing policy check, and only when Settings has cloud mode and consent. A model sentence that says the task is complete is not treated as proof. No live model was called. The checks are in [COMPUTER_AGENT_PROGRESS.md](COMPUTER_AGENT_PROGRESS.md).

### 2026-11-05 — Computer-use Phase 3

A window picture can be taken after screen access is on. The helper writes one PNG in a private temp folder, and the main process deletes it after reading. The picture stays in memory for that observation and is not sent to a model. On this Mac, one capture showed TextEdit’s `note.txt` with “Hello from Companion” in the page. The checks are in [COMPUTER_AGENT_PROGRESS.md](COMPUTER_AGENT_PROGRESS.md).

### 2026-11-05 — Computer-use Phase 2

Native Mac tools can list windows, focus a window, read Accessibility controls, click one unique control, type into a text control, press a navigation key, and scroll. Chat does not call them yet. On this Mac, a temporary TextEdit note received “Hello from Companion” and Finder was brought forward. Click, scroll, and key press were not tried on the live desktop. The checks are in [COMPUTER_AGENT_PROGRESS.md](COMPUTER_AGENT_PROGRESS.md).

### 2026-11-04 — Open installed apps by name

“Open Firefox” no longer stops at the built-in Apple list. A known app still opens by bundle id. Any other plain app name is passed to `open -a`, so macOS opens it when it is installed and reports it missing when it is not. A path or other unsafe name is refused before `open` runs. Pressing a named control still uses the app in front, including one that was just opened.

### 2026-11-04 — Desktop window, Listen, and permission prompts

The panel opens as a 1040×680 window with a sidebar, instead of a 440×720 column. Comfortable text is 15 px. Chat has a Listen button that starts the microphone and a Stop button that ends it. The words stay in the message box until Send. On first show, the app asks macOS for the microphone, screen recording, and Accessibility. If screen recording is allowed, screen access turns on. Stop sharing keeps it off until Allow screen. The screen probe is a 1×1 thumbnail and is not kept.

The running window was not clicked through in this pass. `npm test` passed, 82 tests, 3 skipped. `npm run typecheck` and `npm run lint` passed.

### 2026-11-04 — Show and press a live control

“Show me Save”, “Where is File?”, and “Show me how to make this bold” look at the foreground app and ring one control when its name and role match. The overlay keeps the click-through window and adds a short card beside the ring. The TextEdit Save and Accessibility Display guides still run as scripts.

“Click Save” and “Do it for me” on a highlighted step preview the control, then the helper presses that same control with the Accessibility press action. The press is refused for a password field, the lock screen, a secure prompt, or more than one match. If the control is gone at confirmation time, nothing is pressed. Typing uses the same path for a text field.

Commands from the repo root:

- `npm test` — passed, 79 tests, 3 skipped.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build:helper` — the arm64 helper compiled and was ad-hoc signed.

The Electron window was not clicked through, so a live press in TextEdit was not checked by hand.

A request typed in Companion was reading Companion, so File and Save were missing. The helper now reads the app behind Companion and brings that app forward. If Save is still inside the File menu, the ring stays on File until Save appears. The Show me how / Do it for me switch was removed. `npm test` passed, 80 tests, 3 skipped. `npm run typecheck` and `npm run lint` passed. `npm run build:helper` compiled and signed the helper. Restart `npm run dev` so the new helper is the one that launches.

Press on a highlighted control now presses that control, instead of opening another confirmation. The helper brings the other app forward before the press. A miss shows a small note that disappears, and the guide controls are one row: Press and Stop. The on-screen label is a short pill beside a thin ring.

### 2026-11-04 — Bug fixes after Phases 0–7

Found while reading the running paths and confirmed with `npm test` (70 passed, 3 skipped), `npm run typecheck`, and `npm run lint`.

- A number in a reminder title, such as “buy 2 apples at 5pm” or “room 12 at 3pm,” was used as the clock. The parser now prefers a time that has “at,” am/pm, noon, or midnight. “At noon” sets noon instead of asking whether you meant midnight.
- “Open youtube.com” was treated as an app name. A bare web address opens as https, and a known bundle id such as `com.apple.TextEdit` still opens the app.
- Up and Down on Home moved favorites across the combined list, so an app button could appear to do nothing when a website sat between two apps. Reordering stays inside the list on screen.
- Show me how hid the panel for the screen read and left it hidden, which also hid Stop. The panel comes back without taking focus.
- The Home reminder form accepted an empty title, and a saved reminder kept its date and time so a second click could save it again.
- Hold to talk stopped listening if the pointer was released outside the button, and the footer always said the microphone was off. The footer uses the same microphone state as Chat.
- Dragging the mascot dropped the pointer once the cursor left the character, and the hover timer could reopen the menu after a click. The message box now uses the same text size as the rest of the panel.

The Electron window was not clicked through in this pass.

### 2026-11-04 — Phase 7

Demo mode remains the default. It still routes typed requests on this Mac and does not call a server. Cloud mode stays off until Settings shows what is sent and the user accepts it. The saved server address must be `https`, or `http` on `127.0.0.1` or `localhost`. The desktop app does not contain a model API key. `backend/assistant-proxy` reads `ASSISTANT_API_KEY` from its own environment, checks the model's JSON, and refuses a shell command or an unknown tool. Local policy still runs after a cloud plan. An uncertain reminder from the model waits for confirmation. Instructions marked as observed page content are not sent to the server.

Push-to-talk is off until Settings allows it. Holding the button uses the Mac's speech recognizer when Electron exposes one, and puts the words in the message box. A missing recognizer shows "Microphone not available" and leaves typing working. Read-aloud uses the Mac speech voice and can be turned off. No recording is written to SQLite.

A live model was not called. The proxy test used a stand-in server and the key `server-key`, which did not appear in the proxy's reply. The microphone button was not held in the running app.

Commands from the repo root:

- `npm run typecheck` — passed.
- `npm test` — passed, 69 tests, 3 skipped.
- `npm run lint` — passed.
- `npm run dev` — Electron started. The process was then stopped. Cloud mode and the microphone button were not used in that window.

Phase 8 was not started.

### 2026-11-04 — Phases 5 and 6

The Swift helper `native/CompanionMacHelper` speaks JSON Lines on stdin and stdout. Electron spawns it, times out a call, and retries once after a crash. `npm run build:helper` builds the arm64 release binary and ad-hoc signs it with `codesign --force --sign -`. Several rebuilds in this session still read Accessibility afterward, so the grant survived those signatures on this Mac. A later rebuild can still make macOS ask again.

Real reads, with the helper already allowed in Accessibility:

- TextEdit’s File menu item was an `AXMenuBarItem` at x 117, y 0, 42 by 37 points. After the File menu was opened, Save was an `AXMenuItem` at x 113, y 142, 199 by 22 points.
- System Settings on the Sound page had an Accessibility sidebar row at x 391, y 440, 103 by 24 points. On the Display page, the tree included text-size controls, and the guide said to choose a size and that it did not change the Mac setting.
- A Chrome window returned a title, bundle id, and 36 controls. The page text inside the web view was not listed as named controls.
- Electron’s own panel exposed the window and menu bar, not the buttons drawn in the web page.
- `screen.captureOnce` with consent and without a permission prompt returned `protected_capture`: the frame was blank and discarded. The response had no image bytes. A picture was not described. Cloud vision stays unavailable.

`COMPANION_HANDS_ON=1 npx vitest run tests/handsOnGuides.test.ts` from `apps/desktop` passed, 2 tests. It started the TextEdit Save guide, saw the File box, opened the File menu, then saw the Save box, and Stop cleared the guide. It then highlighted Accessibility in System Settings, and Stop cleared that guide too. The default `npm test` skips that file so it does not steal focus.

The running Electron app was started with `npm run dev`. Chat showed screen access Off, then Allow screen access turned it On. “Explain this screen” answered with the Companion window title, the app name, the control names it could read, and the sentence that it could not verify anything beyond that list and would not follow instructions written on the screen. The Settings inspection toggle was not clicked. The yellow overlay window was not seen: the guide sentence was not successfully submitted from the panel during that click-through, so no “Companion highlight” window appeared. Stop in the hands-on test left no guide and no highlight. Click-through flags are covered by T-GUIDE-04.

Commands from the repo root:

- `npm run build:helper` — passed. Release binary ad-hoc signed.
- `npm run typecheck` — passed.
- `npm test` — passed, 59 tests, 3 skipped (the real-launch test and the two hands-on guide tests).
- `npm run lint` — passed.
- `COMPANION_HANDS_ON=1 npx vitest run tests/handsOnGuides.test.ts` from `apps/desktop` — passed, 2 tests.
- `npm run dev` — Electron started, spawned the helper, and the panel rendered Chat. The process was then stopped.

Phase 7 was not started.

### 2026-11-04 — Phases 3 and 4

Chat sends text to a deterministic router in the main process. “Open TextEdit,” “Search for gardening tips,” and “Make your text bigger” go through the tool registry and policy engine. Empty input is rejected. Unknown tools, shell names, unapproved R3 actions, and instructions passed in as observed page content do not run. An uncertain website and an uncertain reminder wait for a matching approval. System Settings copy says the page was opened and does not say the Mac setting changed. Screen explanation and highlights reply that they are not available. Chat text stays in memory for the session. `saveChatHistory` remains off, so message bodies are not written to SQLite. A short activity summary is stored.

Reminders are SQLite rows. Chat and Home can create, list, and cancel them. The scheduler uses an injected clock and timer. Tests do not sleep. A due reminder is marked `fired`. One that is still scheduled when the process starts after its due time is marked `missed`, which is an extra status beyond the `FEATURES.md` union so it is not recorded as a notification that fired while the app was closed. Snooze updates that same row. Companion tells the user that reminders notify only while the app is open. The app calls Electron `Notification` when the platform reports support and the preference is on. No banner was observed in this session.

`COMPANION_REAL_LAUNCH=1 npm test -w companion-desktop -- tests/realLaunch.test.ts` passed. That run called `/usr/bin/open` for TextEdit (`com.apple.TextEdit`), the encoded Google search URL, and the Displays settings URL. Each `open` exited 0. The windows were not inspected by eye. The default `npm test` skips that launch.

Commands from the repo root:

- `npm run typecheck` — passed.
- `npm test` — passed, 40 tests, 1 skipped.
- `npm run lint` — passed.
- `npm run dev` — Electron started and loaded the renderers, with no error in the log. The process was then stopped. Chat was not clicked through in the window.

Phase 5 was not started.

### 2026-11-04 — Phases 1 and 2

The mascot is a transparent always-on-top window with Home, Settings, and Chat. Position and collapsed state are stored in SQLite. Home saves and launches allowlisted bundle IDs and https websites. `javascript:` and `file:` targets are rejected. Settings changes text size, theme, mascot color, motion, and launch-at-login. Resetting appearance leaves favorites in place. Chat opens and says sending is not available yet.

Commands from the repo root:

- `npm run typecheck` — passed.
- `npm test` — passed, 13 tests.
- `npm run lint` — passed.
- `npm run dev` — Electron started and loaded the mascot renderer. The unsigned dev app cannot register a login item until the user turns that toggle on, so startup does not call that API while the preference is off.

System Settings links use the macOS 15 Accessibility and Displays URL schemes. A hands-on click through every menu on a second monitor was not recorded. Phase 3 was not started.

### 2026-11-04 — Phase 0 foundation

Re-verified the toolchain: macOS 15.5 (24F74), arm64, Node 22.22.2, npm 10.9.3, Swift 6.1.2.

Scaffolded `apps/desktop` with `npm create @quick-start/electron@latest` (`@quick-start/create-electron@1.0.31`, template `react-ts`). Electron is pinned to 44.10.2 because `electron-builder install-app-deps` rejects a version range. Other versions are pinned in `package-lock.json`: electron-vite 6.0.0, Vite 8.3.5, React 19.3.1, TypeScript 5.9.3, Zod 4.6.7, Vitest 5.1.0, ESLint 9.39.5 (the workspace binary), Prettier 3.9.10.

Commands from the repo root:

- `npm install` — passed. Workspace install, Electron binary download, and `electron-builder install-app-deps`.
- `npm run typecheck` — passed.
- `npm test` — passed, 8 tests, no GUI.
- `npm run lint` — passed.
- `npm run build` — passed (`electron-vite` bundle only, no installer).
- `npm run dev` — passed. Two windows titled Companion opened. Renderer processes started with `--enable-sandbox`. No secret keys were added.

Capability flags read Accessibility and Screen Recording without prompting. The Swift helper flag is hardcoded unavailable. Phase 1 and later were not started.

### 2026-11-04 — Docs split

The single build spec was split into this `docs/` set. No product code was written.

### 2026-11-04 — macOS-first spec

The docs now target macOS. TextEdit replaces Notepad. A Swift helper replaces the .NET bridge. Workflow files `AGENTS.md`, `TASKS.md`, and `DECISIONS.md` were added. No application code was written. Phase 0 is next, and it waits for an explicit start.
