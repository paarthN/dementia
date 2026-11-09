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

## Computer-use agent

The new multi-step agent extends the existing orchestrator, tool registry, and policy engine through one shared authorized executor. It does not get a second, weaker policy. Legacy chat and `/v1/interpret` stay. Model calls remain behind the existing proxy. Recorded 2026-11-05 during the expansion audit, before any agent code.

Desktop actions added in Phase 2 use that same executor. A snapshot is valid for 3 seconds. A click or text change must still match one control in a fresh look, and the helper finds that control again before it acts. A text field with no name is used only when it is the only control of that role. A helper timeout or crash during a click, key, scroll, focus, or text change is not sent again.

**If this is wrong:** a parallel executor will drift from the current approval and cancellation rules, and a press that legacy chat still confirms could run from the new loop without that check. Retrying a helper call after a timeout could also repeat a click or key that already landed.

A screenshot is a file the helper writes in the user temp directory, mode 0700 for the folder and 0600 for the file. The main process reads it once, checks the window and the screen scale, then deletes it. The bytes stay in memory for that task. They are not sent to a model in this phase. A uniformly dark frame is discarded. If a single-window capture is dark, the helper tries once more by capturing that window on its own display. Screen Recording is requested at most once per helper process. Recorded 2026-11-05.

**If this is wrong:** a temp file can outlive a crash for up to two minutes, and a dark app that is actually on screen can be treated as a protected capture.

The cloud agent calls OpenAI through the existing proxy. `openai` 7.52.0 is installed at the repo root and pinned in the lockfile. The model id is `COMPANION_AGENT_MODEL`. It is not written into the app, because the Responses guide treats model ids as something to confirm, and a paid call was not made in this session. Tool names on the model request use underscores (`apps_open`). The proxy maps those back to the registry names (`apps.open`). The desktop still executes only through `AuthorizedToolExecutor`. A picture is included only when cloud mode, cloud consent, screen analysis, and screen access are all on, Stop sharing is off, and the window is not a password or protected surface. The image is a `low` detail `input_image`. Responses continuation uses `previous_response_id`, and the API stores that response for at least 30 days unless a later change sets `store` false. Setting `store` false would break that continuation. Recorded 2026-11-05.

Proxy checks live in `apps/desktop/tests/agentTurn.test.ts` so `npm test` runs them. A separate `agent.test.mjs` runner was not added.

**If this is wrong:** a model id that cannot see images or call functions will fail the opt-in smoke test, and storing responses at OpenAI is more retention than a stateless request. Chat still does not start this loop.

The agent browser uses Playwright 1.65.0 in `companion-desktop`. It launches Playwright's Chromium, headed, with a profile at `agent-browser` inside the app's user data. Launch options omit `channel` and the code does not call `connectOverCDP`. Downloads are off. An address must be `http` or `https`, and a DNS answer that includes a private, loopback, or link-local address is refused. Redirects are decided from the `Location` header before Chromium follows them. A test may pass one exact `http://127.0.0.1:port` or `http://localhost:port` origin. A page picture is included only when that tool call sets consent, and the bytes stay out of the tool result. Recorded 2026-11-05.

**If this is wrong:** Chromium still has to be installed with `npx playwright install chromium` on a development machine, and the app does not yet carry that binary. Chat still does not start this loop.

A generic click is not a way to send, buy, delete, upload, or pay. Those labels are refused, including after a confirmation, because Companion has no separate action for them. Continue, OK, and Allow are not treated as safe. They need a confirmation of that exact control, and a purchase, deletion, or permission prompt in the surrounding words is refused. Password and one-time-code fields stay refused. When a confirmation is accepted, the live control is read again. If Save has become Delete, nothing is pressed. The same approval cannot be used twice. Highlighted Press goes through that same executor. Stop sharing also stops the computer-use session. A model-supplied risk level is ignored. Recorded 2026-11-05.

**If this is wrong:** a person cannot ask Companion to press Submit for them. They press Submit, Send, Buy, Delete, and Upload themselves.

Ordinary launches and reads can run without a card. A click, type, or key in another app still needs the confirmation card for that exact action. Passwords, sending, buying, deleting, uploading, and paying stay refused. Instructions found on a page still do not run. Recorded 2026-11-07; click/type/key confirmations kept after the Peekaboo path.

**If this is wrong:** every ordinary click waits for a card again, or a consequential control runs without one. Stop still ends the task.

Send in Chat still runs the older assistant. **Do this for me** is the opt-in for the computer-use loop, and it runs only after cloud assistant consent. The progress strip shows the goal, the current step, and the last step that was actually verified. Pause, Resume, and Stop are on that strip, and Stop is also in the menu bar. A confirmation button names the control. Saying yes, or pressing Send, does not confirm it. If screen access is missing, the strip offers that permission once and a way to switch to a guide. Recorded 2026-11-05.

**If this is wrong:** a person who expected Send itself to drive the computer would need to press Do this for me.

## Local app package

Computer-use Phase 8 asks for a notarized Mac release. The signing decision above still waits for Developer ID until the product packaging phase, and this project has no Developer ID certificate. The local package is an ad-hoc signed arm64 `.app` from `npm run package:mac`. Gatekeeper rejects it. The helper and Agent Browser Chromium are copied into the app at build time. The running app does not download either one, and it does not look in Homebrew. A packaged run uses only the helper inside the app, not the copy in the repository. Recorded 2026-11-05.

**If this is wrong:** someone who copies the `.app` to another Mac will be stopped by Gatekeeper until the app is Developer ID signed and notarized. An ad-hoc build on this Mac is not that release.

## Phase 9 before OAuth, without notarization

Product Phase 8, one mail or calendar provider, is still not started. Phase 9 was started because it was requested. The stricter release rule stays in force: no Developer ID identity is invented, and `notarize` stays false. Crash notes default off, stay on this Mac, and are redacted. They are not sent to a server. A reminder beyond the JavaScript timer limit is armed in slices. Recorded 2026-11-06.

**If this is wrong:** mail and calendar remain unavailable, and another Mac will still refuse the ad-hoc app.

## Peekaboo drives desktop actions

The computer-use loop still plans one tool at a time, and policy still confirms a click, a type, and a key. Stop still aborts that task. Desktop actions now go through the Peekaboo CLI with a fixed argument list and `shell: false`. The Swift helper still runs guides and screen explanation. Agent Browser is still Companion's own Chromium. Peekaboo's own agent is not called, and it is not pointed at Safari or the user's Chrome.

`desktop.setText` pastes into the named control, including a Notes web area, and reads the window again. Allowed keys stay the navigation keys plus Return, Delete, Command-A, Command-N, and Command-V. `desktop.clickPoint` is only for a fresh snapshot when no named control matches, and it still asks first. If a window has little text, or a Maps page does not include the directions in the page text, Peekaboo OCR adds bounded text. A Wikipedia page's first lines are included in the browser step summary. The saved tree before this change is local branch `snapshot/pre-peekaboo` at `01d0511`. Recorded 2026-11-07.

**If this is wrong:** a Mac without the `peekaboo` command cannot click or type through this path. Install it and grant it Accessibility and Screen Recording.

## Goal checks before “done”

A model claim that the task is finished is not enough. Early in a computer-use run, the model must call `task.setGoalChecks` with 2–5 outcomes. Each outcome names evidence Companion can check locally: tools that must succeed, text that must appear in observations or tool summaries, and/or an app name. When the model returns `final`, the runner evaluates those checks. If any are missing, it keeps going with that list (capped) instead of completing. There is no Notes-only or Wikipedia-only finisher. Recorded 2026-11-08.

**If this is wrong:** a vague check never becomes evidence, or the model skips `task.setGoalChecks` and the run ends unfinished after the keep-going budget.

## Browser LLM benchmark gate

Multi-task Agent Browser evaluation against local fixtures uses the real `AgentRunner`, `AuthorizedToolExecutor`, and configured Responses model through the existing proxy. It is opt-in via `COMPANION_BROWSER_LLM_BENCHMARK=1` plus `ASSISTANT_API_KEY` and `COMPANION_AGENT_MODEL`. Approvals are auto-confirmed in the test only. Recorded 2026-11-08.

**If this is wrong:** CI will skip the live suite and only the scripted harness will guard regressions until keys are provided locally.

## Browser structured targeting (Option B)

Agent Browser keeps the direct `PlaywrightAdapter` (not Playwright MCP). Observations include ancestor landmarks and list-item indexes. Clicks bind to target identity (role, name, ancestor chain), not a live global ordinal. List-relative queries use `within` plus optional `itemOrdinal`. Action verification compares before/after evidence; `expectTextIncludes` / `expectUrlIncludes` must be newly true after the action. Soft target cap is 80, with `browser.observe({ within })` for more controls inside one container. `browser.fill` stays text-only. Task completion remains `task.setGoalChecks`. Recorded 2026-11-08. Spec: `docs/superpowers/specs/2026-11-08-browser-targeting-design.md`.

**If this is wrong:** ordinal clicks will miss after reordering, or the model will claim success when the expected text was already on the page.

## One approval for the task, not one per click

A click, a type, or a key in another app used to need its own confirmation card. An
ordinary task is five to fifteen of those, so the loop could never finish without a person
pressing Confirm at every step. The first action that would ask now raises one card naming
the app — "Let me click and type in Notes to finish this" — and that answer covers ordinary
clicking and typing for the rest of that task.

The grant is a `TaskScope`: one task id, one surface (Agent Browser, or one bundle id on the
desktop), ten minutes, and it dies with the run, so Stop and Stop sharing end it with no
extra teardown. `scopeCovers` is code, not a model claim.

It covers exactly six tools: `browser.click`, `browser.fill`, `browser.press`,
`desktop.clickElement`, `desktop.setText`, `desktop.keyPress`. Everything else is unchanged.
Send, Buy, Delete, Upload, Pay and Submit stay refused. Continue, OK and Allow stay
ambiguous and keep their own card. Password and one-time-code fields stay refused. A
purchase or permission prompt in the surrounding words stays refused. `desktop.clickPoint`
keeps its card because it has no named control to re-find, and `ui.press` keeps its card
because its input carries no app identity to check. R3 still needs an approval bound to its
exact payload, and R4 is still denied. A scope for Notes never authorizes a click in Mail.
Recorded 2026-11-08; supersedes the 2026-11-07 note above for scoped actions only.

**If this is wrong:** a person who wanted to see every click will see one card instead, and
the per-action identity recheck no longer stands between the model and an ordinary control
in the app they named. The adapters still re-find each control by name and role before
acting, so a control that changed under the agent is still not pressed.

## The model cannot end its own task

`tasks.cancel` is no longer offered to the model, and the proxy no longer sets
`tool_choice: "required"` once goal checks exist. Forcing a tool for as long as any check was
unmet left no legal way to answer `final`: the 2026-11-08 live runs ended as `cancelled`
after the real work had already landed, because `tasks.cancel` was the only exit the model
had. Stop stays with the person. A `final` that arrives before the checks are met is still
held by the runner's keep-going counter, and when that counter runs out with real verified
work behind it the run ends `partial` with the unmet checks named, instead of `failed`.
Writing the plan no longer counts as verified work. Recorded 2026-11-08.

**If this is wrong:** the model can answer with prose earlier than it should, and the
keep-going counter is the only thing asking it to carry on.

## Observations name the window, and tools state their arguments

Every tool the model can call now ships a real JSON Schema from the proxy. Before this, one
tool of thirty-five had one, and the rest were advertised as `additionalProperties: true` with
no properties, so the model guessed argument names from a sentence of prose.

`SafeObservation` also carries `windowId`, `bundleId`, `processId` and `truncated`. The five
`desktop.*` mutators require the first three and the adapters reject a call without them, yet
the model was never shown them — which is why desktop tasks only ever passed with
hand-written test arguments. These identifiers are ephemeral and low-sensitivity; no window
handle is persisted. `truncated` tells the model when the 80-target cap hid controls so it
can scope with `within` instead of guessing. Recorded 2026-11-08.

**If this is wrong:** the model sees a window id it should not need, or a schema drifts from
the tool it describes. `apps/desktop/tests/agentTurn.test.ts` holds the mirrored proxy enums
and the instruction text in step with the desktop constants.

## Approvals are per surface a task touches, not one per task

A task can touch more than one app — the project's own target scenario is "open
Wikipedia, then paste into Notes." The first implementation of task-scoped trust
stored one scope in a single variable, so once any scope existed for a task no second
one was ever offered, even for a different app. A Wikipedia→Notes task got one card
for Agent Browser and then silently reverted to a card per click for every action in
Notes — defeating the point of scoping approvals for a multi-step task.

Scopes are now a map keyed by surface identity (`'browser'`, or `desktop:<bundleId>`
per app). Each surface a task actually uses gets its own one-time card the first time
it needs one; all of them still die together on Stop, stop-sharing, or task finish.
Recorded 2026-11-09; refines the 2026-11-08 "one approval for the task" decision.

**If this is wrong:** a task touching three apps gets three cards, which may still
feel like too many for a very chatty multi-app task; the alternative (one card for the
whole task regardless of app) was rejected because it would mean the second app's
every click runs with no per-action recheck at all once the first card is granted.

## Desktop typed text has the same evidence floor as the browser surface

`desktop.setText`'s success summary never echoed the text it had just confirmed
landed, on both the live Peekaboo path and the unwired native-helper path. This is the
exact bug fixed on `browser.fill` the same day: a typed value never appears in a
window's visible text, so a goal check asking whether text landed in Notes had no
evidence to read, no matter how many turns it waited. Unlike the browser case, this one
was never caught because no test has run a real model against the desktop surface.
Fixed the same way: echo the confirmed, redacted text in the summary. Recorded
2026-11-09.

**If this is wrong:** redaction misses something project-specific to the desktop path
that the browser path's `redactSecretText` call didn't need to handle.

## Action and turn budgets sized for a real task

`maxActions` 20→40, `maxModelTurns` 30→60, `deadlineMs` 5→15 minutes.
`maxIdenticalFailures` (2) and the per-tool 15s timeout are unchanged. These were
fixture-sized defaults from before approvals were scoped; once a task stopped waiting
on a human for every click, a real multi-app task needs more room than a 5-click
fixture ever did. Recorded 2026-11-09.

**If this is wrong:** a stuck task now runs twice as long before the budget stops it,
and the deadline check in `AgentRunner` is the only thing bounding real wall-clock time
for a run that's actually looping rather than working.
