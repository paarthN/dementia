# Implementation plan

Build in this order. Start the next phase only after the previous one is stable and its done-when checks pass. Requirements are in [FEATURES.md](FEATURES.md). Track evidence in [PROGRESS.md](PROGRESS.md).

Each phase ends with something you can demonstrate. Prefer a coherent milestone over incomplete scaffolds for every feature.

## Session instructions

First implementation session, after these docs are in the repo:

```text
Read docs/MASTER_PLAN.md, then the doc for the area you are changing.
Treat docs/ as the engineering source of truth. The primary platform is
macOS. The native helper is Swift, over stdio. Check docs/PROGRESS.md
for the last completed phase and docs/DECISIONS.md before choosing an API.

Inspect the repository and runtime environment. Implement the next incomplete
phase completely. Use Electron, React, and TypeScript, strong IPC isolation,
and an original SVG mascot.

Create README.md with exact install, run, and build commands, plus
docs/DECISIONS.md if it does not exist yet. Use a mock provider when native
or cloud capabilities are unavailable. Never present a mock result as a real
action.

Run typecheck, tests, and a smoke test. Fix errors. Report files changed,
commands run, tests passed or failed, platform limits, and the next phase.
Do not start the following phase until this phase's acceptance checks pass.
Do not commit secrets or add an arbitrary-shell tool.
```

Later sessions:

```text
Continue from the last completed phase in docs/PROGRESS.md. Implement the
next phase's requirements and tests. Preserve the security and permission
architecture in docs/SECURITY.md and docs/AGENT_SYSTEM.md. Verify real
behavior, not only appearance. Update PROGRESS.md with evidence and anything
still blocked.
```

On this Mac, verify native behavior with the Swift helper. Mocks are for tests and for missing permissions. Do not claim the helper works from mocks alone.

## Phase 0 — Foundation and tooling

1. Initialize Electron, React, TypeScript, and Vite from a maintained scaffold.
2. Add lint, format, typecheck, Vitest, and a baseline test.
3. Configure renderer entry points for separate mascot and panel windows, or one app that opens both.
4. Add a secure preload IPC API and basic main-to-renderer window control.
5. Add environment checks and macOS capability flags for Accessibility, Screen Recording, and the Swift helper.
6. Create `.env.example`, `.gitignore`, README setup commands, and keep [PROGRESS.md](PROGRESS.md) current.
7. Clean install, build, and restart work.

**Done when:** A desktop window runs, `npm run typecheck` and the test command pass, and the tree has no secret keys and no unsafe renderer Node access.

## Phase 1 — Mascot and navigation

1. Original SVG and CSS mascot.
2. States and accessible labels from [UI_UX.md](UI_UX.md).
3. A small transparent always-on-top window and bounded dragging.
4. Hover, click, and keyboard menu: Home, Settings, Chat.
5. Panel window with close, back, and focus handling.
6. Menu-bar Restore and Quit, optional hotkey, launch-at-login toggle.
7. Persist display-relative location and collapsed state.
8. Test 100% and 200% scaling, a primary-monitor change, and screen-edge clamping.

**Done when:** All three entries work with mouse and keyboard, the mascot does not block unrelated clicks, and position persists. Tests: T-MAS-01 through T-MAS-07 as far as the environment allows.

## Phase 2 — Home and appearance

1. Large tile and card components.
2. SQLite and migrations for preferences and favorites.
3. Favorites create, read, update, delete, and reorder.
4. Known-app lookup and launch, and safe HTTPS launch.
5. Quick actions and local settings navigation.
6. Text size, theme, content scale, and reduced motion.
7. Mascot and panel colors, and reset appearance.
8. Tests for invalid targets and persistence.

**Done when:** Favorites launch verified targets, preferences survive restart, and large type stays usable. Tests: T-HOME-01 through T-HOME-03, T-SET-01 through T-SET-03.

## Phase 3 — Chat and the deterministic task engine

1. Chat panel: composer, messages, suggestions, status.
2. Zod schemas for `RoutedRequest`, planned tool calls, and tool results.
3. Deterministic routing for simple commands.
4. Tool registry and policy engine, R0 through R4.
5. Browser search, app launch, open URL, and settings deep-link tools.
6. Task states, cancellation, timeouts, and error recovery.
7. Result, approval, and error UI.
8. Tests that no action runs without required permission or confirmation.

**Done when:** “Open TextEdit,” “Search for gardening tips,” and “Make your text bigger” perform real, verifiable actions. Failures are useful. Tests: T-CHAT-01 through T-CHAT-09, T-SET-04.

## Phase 4 — Reminders

1. Repository, scheduler, status transitions, and settings.
2. Date and time parsing with a clarification step.
3. Create, list, and cancel from Chat and Home.
4. Notify while running. Rehydrate on startup.
5. Missed reminders, snooze, DST and timezone, restart.
6. Tests use a fake clock. Do not sleep for hours.

**Done when:** A test reminder appears, survives restart, cancels, and reports missed items honestly. Tests: T-REM-01 through T-REM-05.

## Phase 5 — macOS helper and screen understanding

1. Swift helper with `system.ping` and JSONL RPC over stdio.
2. Spawn, timeout, and crash recovery from Electron main.
3. Foreground-window inspection and a bounded Accessibility tree.
4. Access denied, missing metadata, and protected contexts, including the lock screen and password dialogs.
5. Accessibility and Screen Recording permission prompts, plus a visible access indicator.
6. Optional one-shot screenshot with explicit consent.
7. “Explain this screen” using Accessibility text heuristics and the mock provider first.
8. A cloud vision hook may be stubbed. Do not fake vision.
9. Test TextEdit, System Settings, a browser, and an inaccessible custom UI.

**Done when:** Real Accessibility data from a foreground app shows in a developer inspection view that is off by default, and the user-facing explanation separates known facts from unknowns. Tests: T-SCR-01 through T-SCR-04.

## Phase 6 — Guidance and highlights

1. Click-through per-monitor overlay.
2. Coordinate conversion that tracks window movement and DPI.
3. Guide definitions for TextEdit Save and one macOS Accessibility settings flow.
4. Locate targets with the Accessibility API. Show one step and a highlight.
5. Advance on a state change or an explicit “I did it.”
6. Repeat, Can't find, Switch to manual, and Stop.
7. Clear stale overlays and re-inspect on layout changes.
8. Unit tests plus hands-on macOS guide tests.

**Done when:** A user completes at least one real multi-step task in an external app with accurate highlights. Failures leave no stray overlays. Tests: T-GUIDE-01 through T-GUIDE-06.

## Phase 7 — Optional remote AI and voice

1. A secure backend proxy, or an equivalent user-controlled server, holds model secrets.
2. Provider interface, rate limits, timeouts, and tool-call schema checks.
3. The model returns typed intents and tool requests, never raw shell commands.
4. Local policy and confirmation apply to every tool request.
5. Push-to-talk recognition and optional speech output.
6. A clear cloud-mode consent screen that explains the data transfer.
7. Switching between mock and production. Demo mode always still works.
8. Tests for prompt injection and hallucinated actions.

**Done when:** A cloud model interprets natural language inside the same safe tool registry, and no API key is embedded in the desktop build. The backend folder may be created in this phase. It is not required before then.

## Phase 8 — Email and calendar (P1, separate gate)

1. One provider only: Google or Microsoft.
2. Authorization code with PKCE and least-privilege scopes.
3. Refresh tokens in OS-protected storage. Disconnect removes them.
4. Read and search mail, and list calendar events, before any write.
5. Drafts first. Send is a separate action behind an exact preview and approval.
6. Create events with date, timezone, attendees, and confirmation.
7. Expired consent, offline failure, retries, and revoked permissions.
8. Sandbox or test accounts only. Never a real sensitive mailbox in automated tests.

**Done when:** The provider API returns verified results, and sending or creating an event is impossible without a matching explicit approval.

## Phase 9 — Quality and packaging

1. Keyboard, screen-reader labels, large text, contrast, and reduced motion.
2. Multi-monitor and DPI matrix.
3. Sleep, restart, power, and reminder recovery.
4. Clean install, update, uninstall, and menu-bar behavior.
5. Sign and notarize release builds, and verify the installer before any public distribution. Local development may use a stable ad-hoc signature so Accessibility permission survives rebuilds.
6. Crash reporting only with privacy consent and redacted diagnostics.
7. Usability sessions. Revise confusing wording and interactions.
8. Onboarding states real capabilities and real limits.

**Done when:** Someone unfamiliar with the project can install it, complete the core flows, and uninstall it without leftover intrusive background processes. Tests: T-ACC-01 through T-ACC-04 and T-SEC-01 through T-SEC-05, plus the pilot gate in [MASTER_PLAN.md](MASTER_PLAN.md).

## Verification habit

After every phase:

- Typecheck, lint, the relevant automated tests, and an app smoke test.
- Write what genuinely works and what is blocked in [PROGRESS.md](PROGRESS.md).
- On macOS, run the manual cases that the phase claims. If the helper cannot run, record that native cases are unverified.
