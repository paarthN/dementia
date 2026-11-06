# Computer-use agent progress

Audit and implementation log for [AGENT_EXPANSION_SPEC.md](AGENT_EXPANSION_SPEC.md).

**Phase:** 5 — managed browser.  
**Date:** 2026-11-05  
**Next step:** Wait for approval. Then Phase 6 only.

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

## Phase 1

Legacy chat still enters through `TaskOrchestrator`. Every tool call from that path and from `runFakeAgent` goes through `AuthorizedToolExecutor`, which calls the existing `decidePolicy` before `toolRegistry`. There is no second policy.

Cancellation now aborts the task's `AbortSignal`. If the tool promise settles with a result, that result is used and no later step starts. If the wait ends by timeout or abort while the promise is still pending, or the helper rejects with its own timeout or abort, the result is `uncertain_after_timeout`. The executor then refuses another tool call. A `Promise.race` timeout is not reported as proof that the native action stopped.

The fake walkthrough in `tests/computerAgent.test.ts` is:

1. The script asks for `apps.open` of TextEdit. The executor runs the existing open path against a fake command runner. The recorded command is `open -b com.apple.TextEdit`. No real `/usr/bin/open` runs.
2. The runner inserts a fixture observation (`snapshotId: fixture-snapshot`). It does not capture the screen.
3. The script asks for one allowed `test.note` action. The executor allows it because the tool is registered as R1 and the task id matches.
4. The tool result includes `verification.passed: true`. The runner records that check.
5. The script says the note is ready. The run is `completed` with `success_verified` only because step 4 passed. A final line with no verified action stays `changed_but_unverified`.

No real autonomous Mac action exists yet. The fake provider never calls OpenAI. Playwright is not installed.

### Checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passed after the report-summary type fix. |
| `npm run lint` | Passed. |
| `npm test` | Passed. 93 tests, 3 skipped. The skips are the same unset `COMPANION_REAL_LAUNCH` and `COMPANION_HANDS_ON` files. |
| `npm run build` | Passed. Production bundle only. |

### Phase 1 report

**Implemented:** Shared executor, state machine, one-run session, budget stops, and the scripted fake agent.  
**Verified:** Unit tests for unknown tools, R4, stale and mismatched approvals, wrong task id, cancel before a call, abort and timeout during a hanging tool, one in-flight action, action budget, repeated identical failures, and the fake TextEdit sequence. Existing chat tests still pass.  
**Not verified:** A live TextEdit press, a fresh screenshot, and Stop during a real helper call.  
**Blockers:** None for a review of Phase 1.  
**Next phase:** Phase 2 after approval.

## Phase 2

The new desktop tools are `desktop.listWindows`, `desktop.focusWindow`, `desktop.observe`, `desktop.clickElement`, `desktop.setText`, `desktop.keyPress`, and `desktop.scroll`. They go through `NativeMacAdapter` and the existing helper. Chat still does not plan these tools. `apps.open` is unchanged. There is no model and no Playwright.

A snapshot expires after 3 seconds. A click or text edit must name one control from that snapshot, then the adapter looks again and the helper finds the control before acting. Two controls with the same name are not used. A disabled, protected, or mismatched control is not used. Text is limited to 500 characters and is accepted only in a text field, text area, or combo box. A text control with no name is accepted only when it is the only control of that role. Keys are limited to tab, shift+tab, escape, the arrow keys, page up, page down, home, and end. Scroll is 1 to 5 steps on an Accessibility scrollbar. `includeImage` does not capture a picture.

If a mutating helper call times out or the helper crashes after the request was sent, the result is uncertain and that call is not repeated. Stop before the request is sent does not count as uncertain. `ui.invokeElement` is in the same no-retry set.

### Live Mac, 2026-11-05

`COMPANION_DESKTOP_SMOKE=1 npx vitest run tests/desktopSmoke.test.ts` from `apps/desktop`, after `npm run build:helper`:

- Window list succeeded. A later check found TextEdit by bundle id.
- Observing that TextEdit window succeeded and reported 7 controls, including one text area. No picture was taken.
- Typing “Hello from Companion” into that text area returned `success_verified`. The note was a new empty file in a temporary directory. It was not saved.
- Focusing Finder returned `success_verified`.
- Click, scroll, and key press were not run on the live Mac.

An earlier smoke looked at the front app when TextEdit was not front. That read was not a typing action. The smoke test no longer prints control names.

### Checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | Passed. 107 tests, 4 skipped. The extra skip is `tests/desktopSmoke.test.ts` unless `COMPANION_DESKTOP_SMOKE=1`. The other skips are unchanged. |
| `npm run build` | Passed. Production bundle only. |
| `npm run build:helper` | Passed. Release binary linked and ad-hoc signed. |
| `COMPANION_DESKTOP_SMOKE=1 npx vitest run tests/desktopSmoke.test.ts` from `apps/desktop` | Passed. 1 test. See the live notes above. |

### Phase 2 report

**Implemented:** Native window list, focus, Accessibility observation, unique click, text entry, a navigation-key allowlist, and bounded scroll. Snapshot expiry, duplicate and disabled targets, protected windows, and abort-without-retry are covered by unit tests and a mock JSONL helper.  
**Verified:** The commands above. On this Mac, TextEdit observation, typing into its text area, and focusing Finder.  
**Not verified:** A live click, scroll, or key press. Saving the TextEdit note. A live Stop during a helper call. Screenshot capture, which remains Phase 3.  
**Blockers:** None for a review of Phase 2.  
**Next phase:** Phase 3 after approval. Do not start it in this session.

## Phase 3

A picture is optional on `desktop.observe` when screen access is on. The helper writes one PNG in a private temp folder (`0700` directory, `0600` file) and the main process reads it, checks the window and the screen scale, then deletes it. The bytes stay in memory for that observation. `observationForModel` removes them. Nothing in this phase sends a picture to a model.

The old capture treated a dark frame as protected because it sampled raw bitmap bytes. TextEdit in dark mode is mostly dark, so that check discarded a real window. A frame is now discarded only when a drawn sample is uniformly dark. If the single-window capture is dark, the helper tries once more by capturing that same window on its own display. Screen Recording is requested at most once per helper process. The Chat and sidebar banners already say when the screen is being used; they follow `captureActive`.

### Live Mac, 2026-11-05

`COMPANION_CAPTURE_SMOKE=1 npx vitest run tests/captureSmoke.test.ts` from `apps/desktop`, after `npm run build:helper`, passed once. The picture was TextEdit’s `note.txt`, with the words “Hello from Companion” in the page. The PNG was 41,743 bytes. The test’s pixel sample required a light pixel and contrast, and that check passed. I looked at the picture. It was not sent anywhere. The temp capture folder was empty afterward.

An earlier call in the same session returned `capture_unavailable` and did not keep a picture. A later run did not see a TextEdit window before Vitest’s 5 second limit. That run was not a successful capture.

### Checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | Passed. 115 tests, 5 skipped. The extra skip is `tests/captureSmoke.test.ts` unless `COMPANION_CAPTURE_SMOKE=1`. |
| `npm run build` | Passed. Production bundle only. |
| `npm run build:helper` | Passed. Release binary linked and ad-hoc signed. |
| `COMPANION_CAPTURE_SMOKE=1 npx vitest run tests/captureSmoke.test.ts` from `apps/desktop` | Passed once. See the live note above. |

### Phase 3 report

**Implemented:** Window capture through ScreenCaptureKit, a one-shot PNG file that is deleted after it is read, scale and window checks, redaction of password fields, and a screen-use flag while a picture is taken.  
**Verified:** The commands above. On this Mac, one TextEdit picture showed `note.txt` and “Hello from Companion.” Unit tests covered the wrong window, a blank helper result, a protected window, an expired snapshot, file deletion, the size limit, and Stop sharing.  
**Not verified:** The running Electron window was not opened, so the banner was not seen by eye. The screen-use flag was checked in a unit test. A second live capture after the successful one did not find TextEdit before the test timed out.  
**Blockers:** None for a review of Phase 3.  
**Next phase:** Phase 4 after approval. Do not start it in this session. No picture has been sent to a model.

## Phase 4

`POST /v1/agent/turn` is on the same local proxy as `/v1/interpret`. The desktop does not contain the OpenAI key or the `openai` package. The proxy uses `openai` 7.52.0 and `client.responses.create`. The model id comes from `COMPANION_AGENT_MODEL`. There is no default model. One model turn may return one function call or a final sentence. `parallel_tool_calls` is false. A second function call, a shell call, or a name outside the registry is rejected and not run. The next turn sends `previous_response_id` and a `function_call_output` with the same `call_id`.

The main process asks the proxy only when cloud mode, a saved consent time, and a server address are all set. Demo chat still uses the local router. Cloud chat still uses `/v1/interpret`. `Desktop.runComputerAgent` is the new loop. The chat box does not call it yet. The loop observes, asks for one step, checks policy, runs the tool locally, then observes again. A final sentence is `success_verified` only after a tool result already verified. Screen text is sent inside `<untrusted_screen>`. A page that says to call `payments.transfer` does not run that tool.

A picture is attached as `input_image` with `detail: "low"` only when cloud screen analysis is on, screen access is on, Stop sharing is off, the picture is under 180,000 base64 characters, and the window has no password or protected control. Otherwise the picture is left out. Password-like text is replaced with `[redacted]` before it leaves the machine. OpenAI keeps the response for at least 30 days because continuation uses `previous_response_id`. The proxy does not write the picture to disk.

The action budget remains 20. The model-turn budget remains 30. The task deadline remains 5 minutes. A session that passes its deadline does not start another tool. Stop during the model request aborts the wait, and a tool call that arrives after that is ignored.

### Checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | Passed. 128 tests, 6 skipped. The new skip is the paid model smoke test unless `COMPANION_AGENT_SMOKE=1`, `ASSISTANT_API_KEY`, and `COMPANION_AGENT_MODEL` are all set. The other skips are unchanged. |
| `npm run build` | Passed. Production bundle only. |
| Paid model smoke | Not run. Those three environment values were unset. |

### Cost and privacy

No paid call was made, so there is no measured token cost. A task can make at most 30 model requests and 20 actions. Pictures use low detail and are capped. The key stays in the proxy process. The desktop source does not import `openai` and does not read `ASSISTANT_API_KEY`.

### Phase 4 report

**Implemented:** Authenticated `/v1/agent/turn`, one serialized tool request, call-id continuation, the desktop client, and the consent gate. Legacy `/v1/interpret` still answers.  
**Verified:** The commands above. Unit tests covered a 3-action mock conversation, call-id continuity, a forbidden tool, secret and image redaction, a fake page instruction, an expired session, Stop during the model wait, the 20-action budget, and `/v1/interpret`.  
**Not verified:** A live model. Whether the configured model accepts an image and a function tool. The chat box does not start this loop. No picture was sent to a model.  
**Blockers:** None for a review of Phase 4. A live check needs an explicit model id, a proxy key, and `COMPANION_AGENT_SMOKE=1`.  
**Next phase:** Phase 5 after approval. Do not start it in this session.

## Phase 5

Agent Browser is a separate Chromium window. `playwright` 1.65.0 is a dependency of `companion-desktop`. The desktop launches Playwright's Chromium with `launchPersistentContext`. The profile directory is `agent-browser` under the app's user data, mode `0700`. The window is headed. The launch options do not set `channel` and the code does not call `connectOverCDP`, so this does not attach to Safari or the user's Chrome profile. Downloads are off. There is no `page.evaluate` tool.

The tools are `browser.launch`, `browser.open`, `browser.observe`, `browser.click`, `browser.fill`, `browser.press`, `browser.scroll`, `browser.back`, `browser.listTabs`, `browser.selectTab`, and `browser.close`. They go through `AuthorizedToolExecutor` and `decidePolicy`. Reading the page is R0. Opening a page, scrolling, going back, and switching a tab in this browser are R1. Click, fill, and key press are R2 and wait for approval. A password, passcode, or one-time-code field is denied. A button named Submit, Send, Buy, Delete, Pay, or Transfer asks with a warning. Fill types into the field and does not submit the form. Two controls with the same name are not used. A snapshot expires after 3 seconds. Page text is untrusted. A picture is taken only when that call sets `consent`, and the tool result keeps `imageIncluded` without the bytes.

Addresses must be `http` or `https`. Loopback, private, and link-local addresses are refused, including a name that resolves to one. A redirect is checked from the `Location` header before Chromium follows it. Tests may allow one exact `http://127.0.0.1:port` or `http://localhost:port` origin. That exception does not cover a public site or a different port. Development needs `npx playwright install chromium`. Packaging that binary is still Phase 8. Chat still does not start this loop.

### Checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passed. |
| `npm run lint` | Passed. |
| `npm test` | Passed. 142 tests, 7 skipped. The new skip is `tests/browserSmoke.test.ts` unless `COMPANION_BROWSER_SMOKE=1`. The other skips are unchanged. |
| `npm run build` | Passed. Production bundle only. Playwright stays an external import. |
| `COMPANION_BROWSER_SMOKE=1 npx vitest run tests/browserSmoke.test.ts` from `apps/desktop` | Passed. 1 test. Headed Chromium opened the local fixture, the page was marked Agent Browser, and the window was closed. I did not watch the window. |

### Phase 5 report

**Implemented:** A headed Agent Browser with its own profile, page reading, role and label actions, navigation checks, and cleanup.  
**Verified:** The commands above. Unit tests covered a library search filled without submit, one named control, two Save buttons with no click, a password field left empty, a private redirect, an external tab, Stop during a hanging navigation, screenshot consent, and a stale snapshot.  
**Not verified:** The chat box does not start this loop. A live model was not asked to use these tools. The Chromium binary is not packaged in the app. I did not look at the headed window.  
**Blockers:** None for a review of Phase 5. A machine needs `npx playwright install chromium` before Agent Browser can open.  
**Next phase:** Phase 6 after approval. Do not start it in this session. Approval still uses the name sent with the action. The adapter then refuses a password field it can see. A later pass should recheck the live control when the approval is accepted.

