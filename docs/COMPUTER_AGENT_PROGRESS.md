# Computer-use agent progress

Audit for the expansion in [AGENT_EXPANSION_SPEC.md](AGENT_EXPANSION_SPEC.md). This file does not mean the agent is implemented.

**Phase:** 0 — baseline audit. No product code was changed.  
**Date:** 2026-11-05  
**Next step:** Phase 1, only after approval. Shared executor, task state, and a fake agent. No OpenAI SDK and no Playwright.

## Baseline

| Item | Value | How known |
|---|---|---|
| Branch | `main` | Observed. A feature branch was not created. The worktree was not clean: untracked `docs/AGENT_EXPANSION_SPEC.md`, `docs/CURSOR_PHASE_PROMPTS.md`, and `.cursor/`. |
| Commit | `8a72ce34fe9c2014b6b628a2760080bf25e9ed77` | Observed. Matches the spec's reference commit. |
| OS | macOS 15.5 (24F74), arm64 | Observed. |
| Node | 22.22.2 | Observed. |
| npm | 10.9.3 | Observed. `node_modules` was already present, so `npm install` was not run. |
| Swift | 6.1.2 (swiftlang-6.1.2.1.2), target arm64-apple-macosx15.0 | Observed. |
| Xcode | Command Line Tools at `/Library/Developer/CommandLineTools` | Observed. Full Xcode was not checked. |

Root scripts: `dev`, `build`, `typecheck`, `test`, `lint`, `format`, `build:helper`, `assistant-proxy`. Desktop dependencies are Electron 44.10.2, React 19.3.0, TypeScript 5.9.3, Zod 4.6.7, Vitest 5.1.0, electron-vite 6.0.0. No `openai` or `playwright` package is installed.

## Checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | Passed. 82 tests, 3 skipped. |
| `npm run build` | Passed. `electron-vite` production bundle only. No installer. |
| `npm run build:helper` | Passed outside the sandbox. Release binary linked and ad-hoc signed. The first attempt failed inside the sandbox (`sandbox-exec: sandbox_apply: Operation not permitted`). That failure was the sandbox, not the Swift package. |

The 3 skipped tests are inferred from the test files, not printed by name in this run. `tests/realLaunch.test.ts` skips unless `COMPANION_REAL_LAUNCH=1`. `tests/handsOnGuides.test.ts` skips unless `COMPANION_HANDS_ON=1` and the helper binary exists. Neither flag was set. Those skips were not run.

## What already exists

**Open an app.** `apps.open` in `apps/desktop/src/main/services/toolRegistry.ts` launches a known bundle with `open -b`, or another plain app name with `open -a` through `launcher.ts`. Covered by `tests/phase3.test.ts` (`T-CHAT-02`), including a refusal of a path. A real `/usr/bin/open` was not run in this audit.

**Windows and Accessibility.** The Swift helper in `native/CompanionMacHelper/Sources/CompanionMacHelper/HelperMain.swift` implements `system.ping`, `ui.inspectForeground`, `ui.findElement`, `ui.readElementState`, and `ui.invokeElement`. Inspection walks the app behind Companion. Press and type re-find one enabled control by name and role, refuse a secure field, and refuse more than one match. `screenCoordinator.ts` is the Electron adapter. Guides and highlights are in `shared/guides.ts`, `shared/controls.ts`, and `tests/controls.test.ts`, `tests/phase6.test.ts`. A live TextEdit press was not repeated in this audit.

**Screenshot.** `screen.captureOnce` in the helper uses ScreenCaptureKit (`SCScreenshotManager.captureImage`). A mostly black frame returns `protected_capture` and no image bytes. A usable result returns width, height, and byte length only, not pixels. `screenCoordinator.captureOnce` then discards that metadata and does not describe the picture. `docs/PROGRESS.md` records an earlier manual run where the frame was blank and discarded. That blank result was **not re-run** today. Status: previously observed, not re-verified.

**Approvals.** `policyEngine.ts` confirms every `ui.press`, uncertain reminders, untrusted URLs, and other R2 cases. R3 without a matching payload is denied. R4 and unknown tools are denied. `taskOrchestrator.ts` binds the approval to one task, tool, and canonical payload for 10 minutes. Tests: `phase3.test.ts` (`T-CHAT-07`, `T-CHAT-08`, `T-CHAT-09`) and `controls.test.ts` (press only after confirmation).

**Cancellation.** `TaskOrchestrator.cancel` marks the task cancelled and blocks a later call (`T-CHAT-05`). `runWithTimeout` in `taskOrchestrator.ts` uses `Promise.race`. When the timer wins, the underlying promise keeps running. The `AbortController` in `context()` is aborted only if the task was already cancelled when the context was created. A cancel that arrives during a tool does not abort that controller. `osBridge` abort or timeout drops the pending JSONL entry and ignores a late line. It does not tell the Swift helper to stop the in-flight Accessibility or capture call. Status: **observed in code**. Not exercised against a live helper in this audit. `phase3.test.ts` only checks that a hanging mock tool stops the wait.

**Cloud intent.** Demo mode routes one sentence locally in `shared/router.ts`. Cloud mode, after consent, calls `POST /v1/interpret` through `providers/assistant.ts` and `backend/assistant-proxy/server.mjs`. The proxy allows one intent, rejects a shell tool, and limits itself to 30 requests a minute. Tests: `phase7.test.ts`. The model key stays in the proxy environment. No agent turn endpoint exists.

## Risks

- A timeout or Stop can report failure while the helper is still pressing or capturing. Inferred from the code paths above. Not shown on a live Mac in this audit.
- Capture can succeed as metadata and still be thrown away, so vision has nothing to read. Observed in `screenCoordinator.ts`. The earlier blank frame is a separate, previously recorded result.
- Text field values are not returned for `AXTextField` or `AXTextArea`, so a later agent cannot yet prove typed text from the snapshot. Observed in `labelOf` in `HelperMain.swift`.
- One press still requires its own confirmation. A multi-step task cannot finish under the current policy without a new goal approval. Observed in `policyEngine.ts`.

## Phase 1 file plan

No product code in Phase 0. Phase 1, after approval, stays inside these files:

| File | Change |
|---|---|
| `apps/desktop/src/shared/computerAgent.ts` | New Zod types for agent state, step, and events. |
| `apps/desktop/src/main/agent/AgentStateMachine.ts` | Pure transitions. Unit tests only. |
| `apps/desktop/src/main/agent/AuthorizedToolExecutor.ts` | Call the existing `decidePolicy` and tool registry. Do not copy a second policy. |
| `apps/desktop/src/main/services/taskOrchestrator.ts` | Route current tool execution through that executor. Keep `submit`, `confirm`, and `cancel` behavior. Store the abort controller and abort it on cancel. If the native call cannot be stopped, return an uncertain result and do not start another action. |
| `apps/desktop/src/main/agent/AgentSessionController.ts` | One active run. No UI yet. |
| `apps/desktop/src/main/agent/AgentRunner.ts` | Scripted fake provider only: open, mock observation, one allowed action, verify, stop. |
| `apps/desktop/tests/` | Unknown tool, R4, stale approval, cancel before and after an await, wrong task id, budget cutoff. Existing tests stay green. |

Do not add `openai`, Playwright, new Swift methods, or `/v1/agent/turn` in Phase 1.

## Phase 0 report

**Implemented:** This audit and the decision that the agent extends the existing executor.  
**Verified:** Typecheck, lint, tests, Electron bundle, and helper compile plus ad-hoc sign.  
**Not verified:** Live TextEdit control, a fresh screenshot, Stop during a real helper call, and the three skipped macOS tests.  
**Blockers:** None for Phase 1. The helper command must be run outside a sandbox that blocks `sandbox-exec`.  
**Next phase:** Wait for approval. Then Phase 1 only.
