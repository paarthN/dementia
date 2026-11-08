# Tasks

Small milestones for Companion. Phase order and done-when checks stay in [IMPLEMENTATION.md](IMPLEMENTATION.md). Do not start a milestone until the one before it is accepted. Phases 0–7 are in the repo. See [PROGRESS.md](PROGRESS.md). Product Phase 8, mail or calendar, is not started. Product Phase 9 has a first slice and is not a public release.

## Milestone 0 — Foundation

Phase 0. No product features.

- Electron, React, TypeScript, and Vite scaffold.
- Lint, typecheck, Vitest, and one passing test.
- Secure preload. The renderer has no Node access and no generic IPC.
- macOS capability flags for Accessibility, Screen Recording, and the Swift helper. Flags may be false in this milestone.
- `.env.example`, `.gitignore`, and README commands that match what actually runs.
- Record the re-verified toolchain in [PROGRESS.md](PROGRESS.md).

**Accept when:** a desktop window runs, typecheck and tests pass, and the tree has no secrets.

## Milestone 1 — First working experience

Phases 1 through 3. This is the first slice.

1. Mascot on screen, draggable, position restored after restart.
2. Home, Settings, and Chat open from mouse and keyboard.
3. Chat accepts “Open TextEdit.”
4. The app launches TextEdit (`com.apple.TextEdit`) through the allowlisted tool.
5. The user sees a confirmation of what happened, or an honest failure.

Search, a vetted website, and “make the assistant text bigger” belong in this milestone after TextEdit launch works. System Settings deep links must say the page was opened, not that the Mac changed.

**Accept when:** T-MAS-01 through T-MAS-03, T-CHAT-02, T-CHAT-04, and T-SET-04 pass as far as this Mac allows. A mock must not be reported as a real launch.

## Milestone 2 — Home and reminders

Phases 2 remainder and Phase 4.

- Favorites persist and launch only validated apps and `https` URLs.
- Appearance presets, including Follow system, survive restart.
- A local reminder is created, listed, cancelled, and reported if missed.
- Reminders are SQLite records, not EventKit.

**Accept when:** T-HOME-01 through T-HOME-03 and T-REM-01 through T-REM-05 pass.

## Milestone 3 — See the screen

Phase 5.

- Swift helper starts over stdio and answers `system.ping`.
- Foreground TextEdit inspection returns a title and exposed controls.
- Capture requires consent and stops when consent is revoked.
- Password dialogs and the lock screen are refused.

**Accept when:** T-SCR-01 through T-SCR-04 pass on this Mac.

## Milestone 4 — Show me how

Phase 6.

- One highlight tracks a real TextEdit control, or it disappears when the target is gone.
- TextEdit Save and one Accessibility settings guide both exist.
- Stop removes every overlay.

**Accept when:** T-GUIDE-01 through T-GUIDE-06 pass, including one hands-on run.

## Later milestones

Do not start these during Milestone 1.

- Phase 7 — optional cloud model and push-to-talk, behind the same tool registry.
- Phase 8 — one OAuth mail or calendar provider.
- Phase 9 — accessibility audit, Developer ID signing, notarization, install and uninstall.
