# Cursor execution prompts — Companion Computer-Use Agent

These are **copy-and-paste prompts for Cursor Agent**. Open the repo root in Cursor, place `AGENT_EXPANSION_SPEC.md` under `docs/` (or preserve its exact path and update references), and use exactly **one phase prompt per implementation session**. Don't paste all nine phase prompts into one chat. Each phase should be broken by Cursor into **2–5 small reviewable commits or slices** without changing the high-level scope.

**GLOBAL CONDITIONS FOR EVERY PHASE**

- Read `AGENTS.md`, `docs/AGENT_EXPANSION_SPEC.md`, `docs/COMPUTER_AGENT_PROGRESS.md` if it exists, plus relevant repo docs and source. The specification is a plan; **inspect actual local source before coding**.
- Preserve current app behavior. Do not introduce bypasses around `policyEngine.ts`, typed IPC, or the Swift helper.
- Only change files needed for this phase. Avoid new frameworks or subagent scaffolding.
- Use docs and source-of-truth APIs from official sources; don't invent Mac APIs, model SDK functions or Peekaboo flags.
- One primary builder owns changes. Optionally delegate **read-only** API research or post-change verification to independent agents. Do not let two agents edit the same file simultaneously.
- After each meaningful slice, run relevant tests, record evidence, and commit locally if tests pass. Don't push unless requested.
- If an error persists after 3 focused attempts, STOP and report it. Do not hide failed tests or enter a repair loop.
- End every phase with a succinct **Implemented / Verified / Not Verified / Blockers / Next Phase** report and update `docs/COMPUTER_AGENT_PROGRESS.md`.

## Phase 0 — Baseline audit and setup (run first)

```text
You are working in my EXISTING Companion repository (paarthN/dementia). Your ONLY goal in this session is Phase 0 from docs/AGENT_EXPANSION_SPEC.md: audit the current project and prepare a safe implementation plan. Do not implement model, browser, or desktop tools yet.

Read AGENTS.md; docs/MASTER_PLAN.md, SECURITY.md, AGENT_SYSTEM.md, TECH_STACK.md, DECISIONS.md, PROGRESS.md; docs/AGENT_EXPANSION_SPEC.md. Inspect package.json, apps/desktop/package.json, desktop.ts, taskOrchestrator.ts, toolRegistry.ts, policyEngine.ts, screenCoordinator.ts, osBridge.ts, native/CompanionMacHelper/Sources/CompanionMacHelper/HelperMain.swift, preload/ipc, ChatPanel, and the existing proxy.

1. Record git branch and commit, npm/node/Swift/macOS versions, existing scripts, installed dependencies and current repository status. Create a new feature branch ONLY if worktree is clean; do not discard edits.
2. Run npm install only if dependencies are missing and without unnecessarily upgrading; run npm run typecheck, npm run lint, npm test, npm run build. Run npm run build:helper only on correctly configured Apple Silicon macOS. Record precise pass/fail/skips.
3. Write docs/COMPUTER_AGENT_PROGRESS.md (baseline, risks, test table, next step). Add a short docs/DECISIONS.md entry that the new agent extends existing services via a shared authorized executor.
4. List which existing code paths already control apps, windows, AX, screenshot, approvals, cancellation, and cloud intent routing, citing code paths and existing tests. Specifically audit the blank-screenshot behavior and the timeout-vs-abort problem.
5. Produce a small file-by-file plan for Phase 1. Do not make product code changes in Phase 0.

Done when the baseline is documented and all problems are clearly labeled as observed, inferred, or untested. If something fails, do not treat it as success.
```

## Phase 1 — Shared executor, task state and fake agent (foundation)

```text
Implement Phase 1 ONLY from docs/AGENT_EXPANSION_SPEC.md. Preserve legacy chat and existing tests. No OpenAI API or Playwright yet.

Read the current TaskOrchestrator, toolRegistry, policyEngine, shared/agent.ts, registerIpc, preloadApi, session snapshots and related tests. Make the smallest safe refactor so one AuthorizedToolExecutor verifies policy, permissions, task ownership, exact approval identity, cancellation state, input schema, result schema and verification for BOTH the current deterministic tools and future AI-driven tools. Do not write a second weaker policy engine.

Implement:
A. New agent state type/schemas in apps/desktop/src/shared/computerAgent.ts and a pure, tested AgentStateMachine.
B. AuthorizedToolExecutor extracted or composed from existing orchestration with backwards-compatible old behavior; enforce one active mutating action, deadline/abort checks, and correct unknown/denied tool handling.
C. Minimal AgentSessionController and AgentRunner using a scripted FakeAgentProvider (fixtures only). Support sequence: open known app -> mock observation -> one allowed mock action -> verify -> final status. Expose safe step progress internally.
D. Correct existing cancellation weakness where waiting on a Promise.race is incorrectly treated as stopping native actions. If true cancellation is unsupported, report uncertain outcome and DO NOT dispatch or retry another action. Do not over-promise impossible rollback.
E. Test unknown tools, R4, outdated approvals, cancellation before and after each await, wrong task ID, budget cutoff, repeated action cutoff, and nonregression. Keep every tool call behind the same executor.

Phase gate: npm run typecheck, npm run lint, npm test, npm run build; update docs/COMPUTER_AGENT_PROGRESS.md. Give me a fake-provider walkthrough and explicitly state that no real autonomous Mac action exists yet.
```

## Phase 2 — Native Mac observation, clicking, typing, scrolling

```text
Implement Phase 2 ONLY from docs/AGENT_EXPANSION_SPEC.md. Don't integrate OpenAI or Playwright. Work through the existing helper, not shell scripts or broad exec.

Read native/CompanionMacHelper/Sources/CompanionMacHelper/HelperMain.swift, apps/desktop/src/main/services/osBridge.ts, screenCoordinator.ts, toolRegistry.ts, and shared/inspection.ts. Create DesktopAutomationPort and NativeMacAdapter to add and verify:
  desktop.listWindows
  desktop.focusWindow
  desktop.observe (AX metadata)
  desktop.clickElement (unique, fresh snapshot-bound target; re-resolve immediately before action)
  desktop.setText (recognized nonsecure text controls only)
  desktop.keyPress (explicit safe whitelist of chords)
  desktop.scroll (bounded amount)

Use the existing `apps.open` path. Never add an arbitrary terminal tool. Preserve JSONL method allowlists and request/response size/timeouts. Add optional AbortSignal support end to end; if the OS cannot interrupt one native call, mark uncertain and never silently retry. Keep native actions scoped to expected PID/window/bundle ID, reject protected/disabled/ambiguous targets, and verify state change with a fresh inspection. For missing AX elements, report unsupported rather than inventing a click.

Write deterministic tests for stale snapshots, focus changes, duplicate names, disabled controls, protected window, typing, aborted calls, and a mock JSONL helper. On an actual Mac, manually test Finder and TextEdit after consent. Record exactly which native scenarios were and were not verified. Run standard quality gates and update progress.
```

## Phase 3 — Real screenshot + vision-ready observations

```text
Implement Phase 3 ONLY from docs/AGENT_EXPANSION_SPEC.md. Do NOT claim visual understanding until an actual native capture succeeds.

Read the Swift capture implementation, screenCoordinator.captureOnce, shared/inspection.ts, shared/vision.ts, osBridge.ts and docs/PROGRESS.md. Fix the existing documented blank/protected screenshot problem using a supported modern macOS capture mechanism (investigate ScreenCaptureKit first) and correct TCC permission handling. Make protected surfaces fail closed.

Create ObservationService to combine app/window identity, bounded AX metadata, current snapshot ID, and optionally a captured target-window image. Avoid returning base64 images in the 1MB helper JSONL result. Use secure one-shot temporary image handoff or a clearly tested binary transport; if temp file, enforce user-owned private dir, restrictive permissions, immediate read-and-delete, robust crash cleanup, size/pixel cap, and no logging/persistence. Implement stale-snapshot checks, multi-display scaling validation, and redaction rules. Show a visible screen-use indicator. Capture only with current task permission; stop-sharing must abort the next capture and prevent model upload.

Create tests with fixture images and metadata for wrong-window capture, blank frame, protected window, expiration, deletion after failure, screenshot size limit and permission revocation. On a Mac, capture a known harmless window and inspect the **actual pixels** manually. Report separately: AX verified? Capture verified? Image sent to model? (Last should be NO until Phase 4.) Run standard gates and update progress.
```

## Phase 4 — OpenAI Responses agent loop / backend proxy

```text
Implement Phase 4 ONLY. The new agent must use the existing main-process execution boundary and authenticated backend proxy. Do not expose the OpenAI key in Electron or in React; keep legacy /v1/interpret and demo mode working.

Research current official OpenAI Responses API function calling + image input docs before writing methods. Add the openai Node SDK to backend dependencies and pin the actual installed version in the lockfile. Choose an env-configured Responses model proven by a smoke test to support image input and function tools; do not guess a permanent model ID. Add backend/assistant-proxy/agent.mjs and agentSchemas.mjs plus POST /v1/agent/turn route to the existing server. Authenticate, rate limit, validate payload sizes/shape, and permit at most one serialized tool call per model turn. Return toolName/args/callId/responseId or final text. Preserve matching function-call output across turns; never execute computer tools on the proxy.

Add apps/desktop/src/main/agent/AgentProviderClient.ts, AgentPrompt.ts, AgentBudget.ts and connect AgentRunner to provider in cloud mode only after user consent. Model may request ONLY registered tools; main process validates args, scope, policy and authorization, executes locally, re-observes, sends bounded safe result back. A returned `completed` statement is not sufficient verification. Treat screen/page content as untrusted. Guard model budget, timeout, repeated calls, late responses after cancellation and invalid JSON. Fake provider remains for deterministic tests.

Include tests for a 3-action mocked model conversation, function_call call_id continuity, forbidden tool request, secret/image redaction, prompt injection from a fake page, expired session, user Stop during network wait, max 20 action budget, and legacy /v1/interpret nonregression. Real paid model smoke test runs only with explicitly provided credentials and opt-in. Run quality gates, document cost and privacy behavior, update progress.
```

## Phase 5 — Playwright managed Chromium browser

```text
Implement Phase 5 ONLY. Read the latest official Playwright docs. Use the `playwright` package in apps/desktop, install a compatible Chromium for development, and keep it separate from the user's personal Safari or Chrome. Do not import browser automation directly into a React renderer.

Create BrowserAutomationPort and PlaywrightAdapter. Headed (visible) agent browser profile, one managed context per user session, clear lifecycle and cleanup. Tools: browser.launch, browser.open, browser.observe, browser.click, browser.fill, browser.press, browser.scroll, browser.back, browser.listTabs, browser.selectTab, browser.close. Prefer getByRole/getByLabel or stable locator references derived from current observation; reject stale/ambiguous targets. No general page.eval exposed to the model. Block unsafe protocols/localhost/private IP/metadata host by default, including redirects; local test fixtures may use explicit test-only exception. Disable download, upload and external script execution as model tools by default. Treat all page text as untrusted. All mutations pass existing AuthorizedToolExecutor and policy.

Add a tiny local HTML fixture with labels/buttons/forms and unit/integration tests for search/navigation, fill without submit, role targeting, ambiguous element, redirect rejection, unauthorized external tab, Stop during navigation, screenshot consent, cleanup. Demonstrate in real visible agent-managed Chromium. No claim of controlling the user's existing logged-in Chrome/Safari or sessions. Run quality gates; note browser binary packaging work for Phase 8.
```

## Phase 6 — Approval, cancellation and recovery hardening

```text
Implement Phase 6 ONLY. Review every external-side-effect path, including existing highlighted-control Press and existing TaskOrchestrator; ensure each routes through the SAME policy/approval/executor logic or documented equally strict checks. No model-driven direct Swift or Playwright calls.

Implement task/step/payload/target-bound short-lived approvals with one-time use and fresh UI revalidation. Risk classifications must be code-owned, not LLM-owned. “Continue” or “OK” may be destructive and requires contextual classification. Never automate password/OTP fields, privileged permission prompts, money transfers, or arbitrary shell. Send/purchase/delete/upload are either explicitly supported behind specialized per-action confirmation or unsupported; never generic click-through.

Harden Pause, Resume, Stop and Stop sharing throughout provider fetch, native helper calls, browser navigation, UI events and approvals. Abort signals must propagate; late events from cancelled task are ignored. Do not retry timed-out non-idempotent operations. Add prompt-injection fixtures, replay/race tests, protected screen tests and logs/privacy tests. Default-deny whenever uncertain about user intent, target identity or sensitive action. Run a manual Stop race test on Mac, then normal gates and update progress.
```

## Phase 7 — Chat/voice/guide progress experience

```text
Implement Phase 7 ONLY. Keep the current mascot, Home, Settings, Chat, voice input and Guides. Build an older-adult-friendly agent status UI inside apps/desktop/src/renderer/panel/ChatPanel.tsx, preferably as a compact AgentProgress.tsx component. Add only typed preload/IPC methods/event subscriptions with trusted sender and schema validation.

Show one goal sentence, current action (human language), recent completed action, progress, visible Pause and Stop, and clear approval card showing exactly what will happen. If user needs to grant screen permission, show a single meaningful reason and alternate Guide mode. Expose all buttons via keyboard and screen reader, respect large text/reduced motion/high contrast, keep prompt and feedback short. Avoid repeated model narration and never say a step succeeded unless verified. Stop must remain reachable if panel/overlay is shown. Voice may initiate a user request but must not silently provide sensitive confirmations.

Add React component tests and IPC schema tests plus manual keyboard/voice/accessibility smoke tests. Ensure existing Home/Settings/Guide/Mascot views still work. Run standard gates, update progress and provide screenshots only as evidence of UI, not automation correctness.
```

## Phase 8 — Packaging, benchmark and release readiness

```text
Implement Phase 8 ONLY. This is NOT “build more features”; it is validating and distributing the ones that work. Review docs/PROGRESS.md, docs/COMPUTER_AGENT_PROGRESS.md, electron-builder.yml, entitlements, Swift helper path, codesigning/notarization, Playwright browser binary deployment, permissions and failure recovery.

1. Produce repeatable `npm run build`, helper build, packaging, clean install and uninstall; avoid dev-only PATH and Homebrew dependencies in release. Verify runtime can locate the signed helper and managed browser binary after relocation. Include macOS permission onboarding and detect missing permissions without looping prompts.
2. Run real controlled benchmark tasks in TextEdit, Finder, System Settings, and agent-managed Chromium. Track success/partial/failure, median steps, latency, cost, number of confirmations, and user recovery. Validate accessibility and screen permission revocation mid-run, Stop race, failures, disconnection and restart.
3. Security review: no unrestricted native/JS/shell IPC; user consent before screenshots to cloud; no screenshots or secrets in persistent storage; no browser-profile copying; safe approval/replay protections; no downloaded untrusted binary via runtime installer; release signature and notarization.
4. Update README and docs with installed permissions, system requirements, actual supported apps, privacy policy, billing, user-visible limitations and exact developer instructions. Do not label any untested feature complete.

Output a release checklist with PASS/FAIL/UNTESTED, outstanding blockers, and a list of known limitations. If not ready, state exactly what remains and stop. Keep work in its feature branch unless I request a PR or merge.
```

---

## Optional read-only researcher prompt

```text
You are a READ-ONLY researcher for this specific Companion phase. Do not edit code or write files. Inspect only the affected API/library (OpenAI Responses SDK, ScreenCaptureKit, Playwright or Peekaboo) from official docs/source. Return: verified current API, required versions/OS permissions, minimal working example, likely integration hazards, and URLs. Flag uncertain APIs explicitly. Do not suggest unrelated frameworks.
```

## Optional verifier prompt (run after implementation)

```text
You are the verifier for this completed Companion phase. Do not modify production code. Read the phase definition of done, inspect the diff, run relevant tests/typecheck/lint/build, and perform only safe authorized manual smoke tests. Report each check as PASS/FAIL/NOT RUN, with exact commands/output and file/line-specific defects. Look for cancellation gaps, approval bypass, privileged renderer access, privacy leakage, misleading success claims and regressions. Do not mark a phase complete without evidence.
```

## Compact continuation prompt for a fresh Cursor session

```text
Continue Companion implementation from the last completed phase. First read AGENTS.md, docs/AGENT_EXPANSION_SPEC.md, docs/COMPUTER_AGENT_PROGRESS.md, and only the source files needed for the next unfinished slice. Check the diff/git state before editing. Summarize the current implementation, next smallest task, likely risks and tests. Implement ONLY that task; run the relevant tests; update the progress file. Stop after 3 failed repair attempts and report blockers. No broad rewrites or new frameworks.
```
