# Decisions

Approved on 2026-11-04. These choices are the macOS-first baseline. A later change updates this file and the doc it affects.

## OS floor

Develop and verify on this Mac (macOS 15, Apple Silicon). Claim support for macOS 14 and newer only after the manual script passes on that version. Intel Macs are not an MVP target.

**If this is wrong:** an older Mac the pilot needs will not run, or we will have spent time on versions nobody uses.

## Native helper

A Swift executable, spawned by Electron main, speaks JSON Lines over stdio. There is no XPC service and no listening port. The helper has no model logic. Electron main owns an `OsBridge` interface. Only the macOS implementation is in scope. The Windows adapter is a documented empty slot, not code.

**If this is wrong:** stdio is clumsier than XPC for a long-running Mac service, and a later Windows port must match this wire protocol.

## Accessibility and capture

macOS Accessibility (`AXUIElement`) is the inspection API. Screen capture uses the system Screen Recording permission plus the app's own consent. Password dialogs, the lock screen, and TCC-denied windows are out of reach.

**If this is wrong:** some apps expose a better API we are not using, and highlights will miss those controls until the helper grows a second source.

## Demo app and guides

TextEdit (`com.apple.TextEdit`) is the first app. The first guided flow is TextEdit Save. The second is System Settings, Accessibility, Display. Automated tests use fixtures. Hands-on tests use the real apps.

**If this is wrong:** TextEdit's menus differ across macOS versions, and the guide will need a new target app.

## Settings and appearance

Companion appearance stays separate from the Mac. The theme value is `Follow system`. Deep links use System Settings URL schemes, verified on the target macOS version, and fall back to the Accessibility or Displays pane. Zoom is the Magnifier equivalent. The assistant opens the page and does not claim the OS value changed.

Tool names are `open_system_settings` and `settings.openSystemPage`. Window identity is an ephemeral `windowId`, not a persisted native handle.

**If this is wrong:** a deep link that works on macOS 15 may open the wrong pane on macOS 14, and the copy must say so.

## Reminders

Reminders stay in local SQLite with the app's own notifications. EventKit and the Reminders app are out of the MVP.

**If this is wrong:** reminders die when the app quits, which the spec already requires us to say out loud.

## Secrets, login, and the menu bar

Provider tokens use the macOS Keychain through Electron `safeStorage`. Launch at login uses Electron's login-item API. The menu-bar status item replaces a Windows tray icon.

**If this is wrong:** `safeStorage` availability differs between dev and packaged builds, and token storage has to move before Phase 8.

## Signing

Local builds use a stable ad-hoc signature so Accessibility permission survives rebuilds. Developer ID, notarization, and the installer format wait until Phase 9. No paid Apple Developer account is required to write the spec or to start Phase 0.

**If this is wrong:** ad-hoc signatures still reset TCC on some macOS versions, and developers will re-grant Accessibility after every rebuild until Phase 9.

## Panel styling

The panel uses Tailwind CSS 4.3.4 (`@tailwindcss/vite` 4.3.4) and four Radix packages: switch 1.4.1, radio group 1.5.1, slider 1.6.1, and separator 1.2.0. Themes, text size, and spacing stay in `panel.css`. Controls are normal desktop size: 32px buttons, a 22px switch, a 16px slider thumb. No other component kit.

**If this is wrong:** a later pass that wants the 44px targets back has to change those sizes in `panel.css` without dropping the text-size setting.

## Computer-use agent

The new multi-step agent extends the existing orchestrator, tool registry, and policy engine through one shared authorized executor. It does not get a second, weaker policy. Legacy chat and `/v1/interpret` stay. Model calls remain behind the existing proxy. Recorded 2026-11-05 during the expansion audit, before any agent code.

**If this is wrong:** a parallel executor will drift from the current approval and cancellation rules, and a press that legacy chat still confirms could run from the new loop without that check.
