# Companion — Autonomous Computer-Use Agent Expansion

**Implementation specification for Cursor | v1.0 | 2026-11-05**

**Target repository:** https://github.com/paarthN/dementia  
**Reference commit:** `8a72ce34fe9c2014b6b628a2760080bf25e9ed77` (main, 2026-11-05).  
**Primary platform:** macOS 15+ on Apple Silicon first. Keep interfaces portable to Windows later.  
**Audience:** Nontechnical and older adults who need safe, low-friction assistance with their computer.  
**Status:** Design/specification. This file does not claim the new agent is implemented.

> **Priority instruction:** Extend the actual repository, not a greenfield scaffold. Read `AGENTS.md`, `docs/MASTER_PLAN.md`, `docs/SECURITY.md`, `docs/AGENT_SYSTEM.md`, `docs/TECH_STACK.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`, and the relevant source before modifying code. Existing security requirements remain binding. When this spec and existing docs disagree, flag the conflict, record the proposed resolution in `docs/DECISIONS.md`, and prefer the stricter security behavior. Do not silently overwrite docs or replace existing working flows.

---

## 0. Outcome: exactly what to build

A **user-initiated, interruptible, permission-aware, multi-step desktop agent** inside the existing Companion app. The user talks or types a goal; Companion observes the authorized app or browser, chooses a bounded next action, performs it through trusted tools, observes the result, and repeats until the goal is verified, blocked, or the user stops it.

### Must-do examples

1. “Open TextEdit and write a short note about tomorrow's appointment.” Open the application, find an editable document, type text, and report accurately whether the note was saved.
2. “Find the Downloads folder and show my newest PDF.” Open Finder, navigate to Downloads, locate a PDF without reading unrelated files, and open it; if multiple candidates exist, ask which one.
3. “Open a browser and search for the nearest library.” Launch the **agent-managed** browser, search, inspect visible results, and report what was found with source links; never invent results.
4. “Show me where the Save button is.” Observe and highlight the matching control without automatically pressing it.
5. “Click the Save button.” Find a unique, current matching target; request confirmation when the action is consequential or the existing policy requires it; execute and verify.
6. “Fill this simple form but don't submit it.” Fill authorized non-sensitive fields, stop at review, and do **not** submit.
7. “Stop.” Immediately stop model requests, prohibit further queued actions, attempt to interrupt in-progress cancellable operations, and accurately disclose any action that might already have completed.

### Explicitly *not* promised by v1

- Complete access to every app, website, account, or protected desktop surface; macOS permissions, protected contexts, anti-bot measures, poor Accessibility metadata, and application limitations still apply.
- Handling passwords, passcodes, one-time codes, security prompts, banking transfers, or unrestricted filesystem reads.
- Silent activity, unattended background operation, invisible mouse control, unrestricted shell/code execution, or control without the user's request.
- Arbitrary Safari/Chrome tab takeover. Browser automation v1 uses an isolated, clearly labeled browser session owned by Companion, not the user's everyday profile.
- Automatically sending emails, purchasing, deleting files, submitting irreversible forms, or granting permissions. These are absent or confirmation-gated according to policy; some remain disallowed.

### MVP success criterion

On a real Mac, from Companion's **existing Chat panel**, user enters: “Open TextEdit, type ‘Hello from Companion’, and show me how to save.” Agent launches TextEdit, observes it, types in a safe editable field, highlights File/Save, yields a correct status, and Stop works at every stage. A follow-up, separately approved save operation is tested in a temporary test directory. No generated UI screenshots or fake success assertions are acceptable as substitutes for a working Mac run.

---

## 1. Baseline: what the repository already has

At the reference commit:

| Existing file | Keep / reuse |
| --- | --- |
| `apps/desktop/src/main/desktop.ts` | Central desktop coordinator, Chat submission, approvals, Stop, screen access, windows, settings. Add a thin new agent session adapter; avoid making it a massive agent implementation. |
| `apps/desktop/src/main/services/taskOrchestrator.ts` | Current task states, step execution, confirmations, audit, cancellation. Reuse/refactor shared authorization/execution; retain legacy single-intent routes. |
| `apps/desktop/src/main/services/toolRegistry.ts` | Existing tools and `ToolContext`. Extend with typed computer/browser tools; no arbitrary tool-name passthrough. |
| `apps/desktop/src/main/services/policyEngine.ts` | Existing R0–R4 risk logic and payload-bound approvals. Centralize, do not fork a weaker model-specific policy. |
| `apps/desktop/src/main/services/screenCoordinator.ts` | Accessibility snapshots, guides, press matching, capture consent; extend with observation + native action adapter. |
| `apps/desktop/src/main/services/osBridge.ts` | JSONL stdio IPC to the Swift helper. Preserve protocol safety; improve cancellation and stale-response handling. |
| `native/CompanionMacHelper/Sources/CompanionMacHelper/HelperMain.swift` | Native AX / capture / window functions. Extend narrowly with explicit methods and sanitized structured inputs. |
| `apps/desktop/src/main/providers/assistant.ts` | Existing `/v1/interpret` client. Preserve for legacy/demo; add a **separate** agent-provider contract. |
| `backend/assistant-proxy/server.mjs` | Existing local proxy for single-intent translation. Keep `/v1/interpret` working; add separate `/v1/agent/turn` endpoint. |
| `apps/desktop/src/shared/agent.ts` | Current Zod task statuses and tool-result contracts. Add new types in separate files, only migrate when needed. |
| `apps/desktop/src/shared/channels.ts`, `ipcSchemas.ts`, `preloadApi.ts` | Restricted, validated Electron API. Add **named** agent IPC events/methods; no arbitrary IPC bridge. |
| `apps/desktop/src/main/ipc/registerIpc.ts` | Trusted sender verification. Preserve and extend. |
| `apps/desktop/src/renderer/panel/ChatPanel.tsx` | Keep existing UI; add task steps, approval cards, Pause/Resume/Stop. |
| `apps/desktop/src/main/storage/database.ts` | Existing SQLite persistence and redacted event audit. No screenshot or audio storage by default. |
| `apps/desktop/src/shared/guides.ts`, renderer overlay | Preserve step-by-step teaching and highlights as a first-class alternative to automation. |

**Known baseline constraints:** Existing remote assistant converts one sentence into one JSON intent; existing native control is named-element-based, not general vision-driven computer use; capture had returned a blank/protected frame in a documented manual test; the existing orchestrator's Promise-based timeout can stop *waiting* without stopping the native side effect. Treat these as engineering issues, not solved features. Verify actual current code at task start, as the repo may have changed.

### Non-regression requirements

- Mascot, dragging, menus, Home, favorites, reminders, accessibility settings, guides, text scaling, existing demo mode, existing `/v1/interpret`, and push-to-talk must still work.
- No extra always-on privileged window or breaking changes to renderer security (`contextIsolation`, `sandbox`, CSP, `nodeIntegration: false`).
- Existing tests must continue passing. Keep old Chat semantics in a **Legacy**/demo path while the new agent is behind an opt-in feature flag.
- Reuse existing approval UI if it satisfies per-action payload binding; extend it, don't invent an unrelated pop-up system.

---

## 2. Stack and exact dependency strategy

Use the existing Node 22+, npm workspaces, Electron, React, TypeScript, Zod, SQLite, Swift and Vitest. **Do not switch package managers or front-end frameworks.**

| Layer | Selection | Reason / install timing |
| --- | --- | --- |
| Agent model | OpenAI **Responses API**, with function calling and image input through `openai` Node SDK | New code runs in the backend proxy; exact model is selected by env `COMPANION_AGENT_MODEL` after confirming support for image inputs + function tools. Install in Phase 4 (`npm install openai` at repo root or a properly declared backend workspace). No provider key in Electron or renderer. |
| Agent reasoning loop | Custom TypeScript/Node finite-state loop, **not** LangChain or a large orchestration platform | Small code, easy cancellation and existing policy integration. See runtime contract below. |
| Native Mac tools | Existing Swift helper, AXUIElement APIs, OS APIs / ScreenCaptureKit if needed | Existing transport and permissions are already established. Primary production adapter. |
| Optional development adapter | [OpenClaw Peekaboo](https://github.com/openclaw/peekaboo) (MIT), CLI | Strong macOS actions and observation; excellent for experiments and fallback. `brew install openclaw/tap/peekaboo`; macOS 15+. **Do not require or silently install Peekaboo on end-user machines.** Wrap behind an interface. |
| Browser | [Microsoft Playwright](https://github.com/microsoft/playwright), `playwright` npm package | Structured role/label locators are preferable to pixel clicking. Install only Phase 5, then install its supported Chromium browser. Dev: `npm install -w companion-desktop playwright` and `npx playwright install chromium`. Document packaging separately. |
| Validation | Existing Zod 4 | Zod-validate tool schemas at ingress and results at egress. |
| Tests | Existing Vitest; optional Playwright for browser integration tests | Mock model, AX, clock, approvals and browser for deterministic tests; real macOS smoke tests are separate and opt-in. |
| Screenshots | Existing Swift helper with a corrected modern capture path; optional `electron.nativeImage` for resize | Avoid a heavy screenshot stack and native-image packaging complications initially. Prefer cropped target window and limited image size. |
| UI | Existing React and CSS | No redesign, no speculative Zustand or Tailwind migration. |

### Important tradeoffs

- **Peekaboo is not the architecture.** It is one optional implementation of `DesktopAutomationPort`. It may need its **own** macOS permissions, which should not be mistaken for Companion's permissions. The production app should eventually bundle/sign its own helper; there is real integration and packaging work.
- **Playwright is not universal Safari control.** It controls supported browser instances that it launches or deliberately connects to. MVP is a separate Chromium profile. Never attach to an existing logged-in personal browser silently, and do not copy their cookies.
- **Built-in computer-use API is an alternative, not an extra prerequisite.** The official OpenAI docs explicitly support using existing desktop/browser function tools with Responses. This design chooses that path so authorization stays local. Check live API docs before coding; do not transcribe speculative SDK methods from this spec.
- **Model selection is not hardcoded.** Choose an actually available vision+function-capable Responses model, verify it in a small provider smoke test, and pin runtime dependencies in the lockfile. Compare cost and reliability on fixtures.

Official references:
- https://developers.openai.com/api/docs/guides/tools-computer-use-integration
- https://developers.openai.com/api/docs/guides/function-calling
- https://developers.openai.com/api/docs/guides/tools-computer-use
- https://playwright.dev/docs/intro
- https://www.electronjs.org/docs/latest/tutorial/security
- https://github.com/openclaw/peekaboo

---

## 3. Process boundaries and data flow

```text
 React Chat / Mascot / Overlay (untrusted renderer)
           │  typed named IPC + event subscription
           ▼
 Electron Main  ─ AgentSessionController
           │          ├── task lifecycle, single active run, Pause/Stop
           │          ├── AgentRunner (bounded observe → choose → act → verify)
           │          ├── ObservationService (AX, vision, browser DOM)
           │          └── AuthorizedToolExecutor (shared with legacy orchestrator)
           │                          │
           │                 Tool Registry + Risk Policy
           │                  ┌───────┴─────────┐
           │                  ▼                 ▼
           │           DesktopAutomationPort  BrowserAutomationPort
           │                  │                 │
           │         Swift helper via JSONL   Playwright Chromium
           │           (optional Peekaboo)
           │
           └── AgentProviderClient ── HTTPS/auth ── existing backend proxy
                                               └── OpenAI Responses API
```

**Critical invariant:** The model can *request* a tool call but can **never** directly execute a tool. Only the main-process `AuthorizedToolExecutor` can perform an action. The tool executor revalidates its input, origin, target, permissions, risk, active task token and snapshot freshness **every time**, even after approval.

### Data sent to the model

Allowed per task only with explicit cloud consent: goal text, recent user messages, compact redacted tool results, optional selected app/window title, bounded AX metadata / browser accessibility or DOM summary, and cropped screenshots **only when the user has also enabled screen-sharing for this task**. Never send full filesystem scans, raw password fields, browser cookies, clipboard contents, session tokens, or unrelated app screens. Screen observations are marked untrusted.

### Model/proxy transport

Keep the existing `/v1/interpret` untouched. Add `POST /v1/agent/turn` to the proxy, supporting **one model turn at a time**. Enforce body limits, authentication, rate limits, provider timeouts, user consent and schema validation. Proposed API shape (adjust as needed after checking SDK):

```ts
// Main-process → authenticated proxy; JSON contract, Zod validated
interface AgentTurnRequest {
  taskId: string;
  goal: string;                   // user-authorized request
  continuation?: { responseId: string; callId: string };
  lastToolResult?: SafeModelToolResult;
  context: { stepNumber: number; summary: string; observation?: SafeObservation };
}

type AgentTurnResponse =
  | { type: 'tool_call'; responseId: string; callId: string; tool: string; args: unknown }
  | { type: 'final'; text: string; completion: 'claimed' | 'unable' | 'needs_input' }
  | { type: 'refusal'; text: string };
```

The proxy must continue the conversation with provider-supported `previous_response_id` / function tool output semantics, or maintain equivalent authenticated server-side state. A function call must be answered with a matching `call_id`. Restrict model output to **at most one tool call at a time** (for example `parallel_tool_calls: false` when supported). If a model returns multiple, reject or serialize only after complete validation—do not execute them in parallel. Never trust an AI-generated risk rating or task-complete claim.

Security design: Production authentication must identify the user/device and enforce quotas. A shared secret baked into a distributed Electron binary is not a secret. Local development may use the current localhost token; production needs real user auth or a BYO-key design with OS secure storage. Avoid deploying the development proxy publicly without auth and TLS.

---

## 4. Proposed files and ownership

Do **not** create all files immediately. Create them as phases require. Exact filenames may vary only with an explicit architectural reason recorded in `docs/DECISIONS.md`.

```text
apps/desktop/src/
  shared/
    computerAgent.ts           # Zod schemas: task, step, tool, observation, event
    agentIpc.ts                # optional helper for typed IPC events
  main/
    agent/
      AgentSessionController.ts # one active task, permission context, resume/stop
      AgentRunner.ts            # bounded planner / action loop
      AgentStateMachine.ts      # valid states / transitions, pure/testable
      AgentPrompt.ts            # goals, tool instructions, injection boundary
      AgentBudget.ts            # step/time/token/cost limits
      AuthorizedToolExecutor.ts # shared authorization + execution + verify
      AgentProviderClient.ts    # authenticated per-turn proxy client
      ObservationService.ts     # collects/redacts current screen + browser state
      TargetResolver.ts         # snapshot-bound, unique target selection
      AgentEvents.ts            # safe progress events to renderer
      ports/
        DesktopAutomationPort.ts
        BrowserAutomationPort.ts
        NativeMacAdapter.ts     # uses existing screenCoordinator/osBridge
        PeekabooDevAdapter.ts   # optional, off by default
        PlaywrightAdapter.ts    # isolated managed browser (Phase 5)
      tools/
        desktopTools.ts
        browserTools.ts
      security/
        AgentRiskPolicy.ts      # extends existing policy, no second loophole
        ObservationRedaction.ts
        ScopeGuard.ts
  renderer/panel/
    AgentProgress.tsx          # compact readable progress + approval + Stop
backend/assistant-proxy/
  agent.mjs                    # model turn handler; existing server.mjs routes to it
  agentSchemas.mjs             # proxy-side validation
  agent.test.mjs               # mock model tests
native/CompanionMacHelper/
  Sources/CompanionMacHelper/HelperMain.swift  # narrowly extend methods
```

**Reconcile with existing code.** Do not duplicate interfaces unnecessarily: `shared/agent.ts`, `toolRegistry.ts`, `policyEngine.ts` and `TaskOrchestrator` should remain sources of truth until carefully refactored. The proposed `AuthorizedToolExecutor` is extracted from existing authorized execution (not a separate, weaker executor). Preserve existing `TaskOutcome` behavior and the `confirmChat`/`cancelChat` flow for old tasks.

---

## 5. Agent runtime: deterministic control loop

### Allowed states

`idle → observing → planning → awaiting_permission | awaiting_confirmation | executing → verifying → observing ... → completed | partial | failed | cancelled`

Also support `paused` before the **next** action. Every transition should emit an event and have one responsible service. After a crash/relaunch, mark incomplete tasks `interrupted` and require a fresh user instruction to resume; do not silently replay unsafe actions.

### Pseudocode (conceptual, not drop-in SDK code)

```ts
async function runAgent(task: AgentTask, signal: AbortSignal) {
  const budget = { maxActions: 20, maxModelTurns: 30, deadlineMs: 5 * 60_000 };
  let previousObservation: SafeObservation | null = null;
  while (withinBudget(budget) && !signal.aborted) {
    await waitIfPaused(signal);
    const observation = await observeAuthorizedTarget(task, signal);
    assertNotProtected(observation);
    const choice = await provider.next({ task, previousObservation, observation }, signal);
    if (choice.type === 'final') {
      return verifyGoalBeforeClaimingSuccess(task, observation, choice);
    }
    if (choice.type === 'refusal') return failSafely(choice.text);
    const validated = validateKnownToolAndArgs(choice);
    const decision = await executor.preflight(task, validated, observation);
    if (decision.kind === 'needs_permission') return suspendForPermission(decision);
    if (decision.kind === 'needs_confirmation') {
      await waitForExactUserApproval(decision, signal);
      // Re-check target, identity, payload and preconditions at execution.
    }
    const outcome = await executor.execute(task, validated, { signal, observation });
    publishSafeProgress(outcome);
    previousObservation = observation;
    if (outcome.status === 'uncertain') return pauseWithUncertainOutcome(outcome);
    if (outcome.status === 'blocked') return reportBlocker(outcome);
    // A new observation is mandatory before choosing the next action.
  }
  return stopWithLimitAndPartialProgress();
}
```

### Hard execution limits (initial defaults, configurable later)

- One active agent run and at most one mutating action in flight per desktop session.
- **20** actions per task; **30** model turns; **5 minutes** wall-clock deadline; **15 seconds** per desktop/tool attempt except documented slow operations; max **2 retries** for an observation or safe/idempotent action.
- Repeated identical failed call on an unchanged snapshot: stop after **2** occurrences; do not loop forever.
- After **3** consecutive model failures: stop with a useful explanation and suggested manual recovery.
- Do not retry non-idempotent actions (send, delete, purchase, submit, create) without checking whether they already happened; otherwise result is **uncertain**, not success.
- Define model token/request budget and per-task estimated cost cap in configuration; show an intelligible usage notice for expensive operations. No unbounded polling or screenshot streaming.
- Explicit `AbortSignal` everywhere; abort provider fetch and queued actions. A timed-out local action must not auto-retry until its outcome is known or the underlying operation is safely terminated. `Promise.race` alone is NOT cancellation.
- A tool result `verification.passed` means that specific tool's claimed effect was checked, **not** that the overall user goal was achieved. Overall completion requires goal-specific evidence or a transparent “I did X; couldn't verify Y.”

### Distinct action outcome categories

`success_verified | changed_but_unverified | no_change | ambiguous_target | needs_permission | needs_approval | blocked_sensitive | failed | cancelled | uncertain_after_timeout`

Do not fold “changed_but_unverified” or “uncertain_after_timeout” into “success.” Implement human-readable summaries.

### Human-in-the-loop behavior

If the model needs missing details, stop and ask the user rather than guessing. Preserve user goal and progress in session, then resume only after a **new direct user instruction**. A user saying “No,” “Stop,” or “I’ll do it” is respected immediately; never escalate or ask repeatedly.

---

## 6. Tools: exact functional contract

Each tool has a Zod input schema, known risk classification determined in code, a permission requirement, a typed result, cancellation hook if possible, and a verification method. No model-originated arbitrary function names or raw shell commands.

### Desktop tools — staged

| Tool | Inputs | Result / verification | Phase |
| --- | --- | --- | --- |
| `apps.open` | existing trusted app name or bundle ID | Actual foreground/OS launch verification | reuse immediately |
| `desktop.listWindows` | optional app bundle id | `{windowId, appName, bundleId, title}` (redacted) | 2 |
| `desktop.focusWindow` | `windowId`, expected bundle id | Verify foreground window/pid | 2 |
| `desktop.observe` | `windowId?`, `includeImage?` | bounded AX snapshot + snapshot ID + optional cropped image | 2–3 |
| `desktop.clickElement` | `snapshotId`, unique `targetId`, expected window/app | Re-resolve semantic AX target and invoke; re-observe | 2 |
| `desktop.setText` | `snapshotId`, `targetId`, `text` capped length | Allowed editable element only; verify field content where safe | 2 |
| `desktop.keyPress` | vetted keys/chords enum, target app/window | Verify resulting UI change where possible | 2–3 |
| `desktop.scroll` | direction + bounded amount + target window | Re-observe viewport | 2–3 |
| `desktop.clickPoint` | `snapshotId`, `windowId`, `x`, `y`, display scale | **Fallback only** after fresh screenshot and strict scope checks | 3 or later |
| `desktop.drag` | restricted start/end coordinates + snapshot | Advanced extension, not required for MVP | later |
| `desktop.highlight` | `targetId` | Reuse guide overlay; no action triggered | 7 |

Do **not** expose a general filesystem read, shell, OS clipboard dump, arbitrary AppleScript, arbitrary script execution, or arbitrary HTTP request as an agent tool.

#### Element targeting rules

- Observation yields a fresh `snapshotId`, timestamp, window ID, process ID, app bundle ID, display ID, and target list.
- `targetId` is **ephemeral and scoped to the observation**, not a global persistent AX pointer. It may map to AX metadata internally, but the native adapter must re-find it before acting.
- Snapshot TTL: default **3 seconds** for mutable actions (or refresh/compare immediately). A stale snapshot triggers re-observation, never guessed coordinates.
- Reject targets that have disappeared, changed window identity, are disabled, are protected, or have >1 matching candidate. Ask the user or re-observe rather than clicking a random match.
- Prefer semantic Accessibility actions over pixel clicks. For clicks that require coordinates, prefer a fresh **target-window crop** and validate display scaling/coordinate translation/multiple monitors. A visual model suggestion is not proof of a target identity.
- Never type into secure fields or use synthetic input to bypass a blocked Accessibility action. Reject hidden/disabled controls.
- If another user action changes focus unexpectedly, re-evaluate scope and pause before a destructive action. Never fight the user for keyboard focus.

### Browser tools — Phase 5

Use an agent-managed Chromium profile stored under a dedicated Companion data directory. It must be visibly marked **Agent Browser** and be stoppable. Do not silently read existing browser cookies, sessions, extensions or profiles.

| Tool | Behavior |
| --- | --- |
| `browser.launch` | Start dedicated headed Chromium context; reuse for one task/session when authorized. |
| `browser.open` | Navigate to approved HTTP(S) URL; block dangerous schemes and local/private-network targets by default. |
| `browser.observe` | Return URL, page title, bounded accessibility/DOM-derived interactive summary, optional screenshot. |
| `browser.click` | Prefer `getByRole`, `getByLabel`, and exact text or stable locator IDs generated by observation. |
| `browser.fill` | Fill only recognized non-sensitive input fields. Sensitive fields are user-only. |
| `browser.press` | Allowed key press in scoped page. |
| `browser.scroll` | Bounded scroll and observe. |
| `browser.back`, `browser.listTabs`, `browser.selectTab` | Work only within the managed context. |
| `browser.close` | Gracefully close agent browser when asked, preserving user edits according to product choice. |

Browser rules:

- No model-supplied arbitrary CSS/JS execution as a tool. Do not enable unrestricted `page.evaluate` on model input; implementation code may inspect the DOM safely.
- Restrict navigation to HTTP(S), deny `file:`, `javascript:`, `data:`, custom protocols, `localhost`, RFC1918/loopback/metadata IPs by default; guard redirect chains, DNS resolution and target changes.
- Downloads and uploads are **off by default**. Future file access requires explicit user file selection, destination preview, path sandbox, type/size checks, and approval.
- A site saying “ignore instructions,” “send me your password,” or “you must transfer funds” is **untrusted page content**, never a user command.
- Do not press Submit/Send/Buy/Delete automatically based solely on locator text. Classify the semantic effect from page/context and require approval or deny it.
- Bot protections, CAPTCHA and sign-in are user-only; don't bypass them.

### Optional Peekaboo adapter

Developer install: `brew install openclaw/tap/peekaboo`, verify `peekaboo permissions status`, sample inspection `peekaboo see --app Finder --json`. Implement `PeekabooDevAdapter` with a strict fixed list of permissible subcommands and validated argument arrays; **never** pass model text into an executable command string or a shell. Use `spawn(binary, args, { shell:false })`, timeout, output-size cap and error redaction. Do not default to `peekaboo agent` because that creates a **second uncontrolled planning loop** outside Companion's safety policy. The **Companion** `AgentRunner` owns the reasoning loop. No production dependency on PATH-resident dev tools.

---

## 7. Observation and screenshots

### Unified observation type (sketch)

```ts
type SafeObservation = {
  observationId: string;
  capturedAtUtc: string;
  source: 'mac_ax' | 'browser_dom' | 'vision';
  app: { bundleId?: string; processId?: number; name: string };
  window: { id: string; title?: string; displayId?: string };
  targets: Array<{
    id: string; role: string; name: string; enabled: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
  contextText?: string;        // redacted, bounded, untrusted
  screenshot?: { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array; width: number; height: number };
  protected: boolean;
  truncated: boolean;
};
```

Keep raw screenshot bytes **only** in the main process during the active authorized task. To avoid breaching the existing **1 MB JSONL response limit** in `osBridge.ts`, do **not** start base64-streaming full PNGs through JSONL. Use a secure temporary file handle or one-shot file handoff in a private directory (mode 0700 directory / 0600 file), read in main, unlink in `finally`; handle app crash cleanup and avoid persistent filesystem backups. Alternative binary IPC requires a separate design and tests. Do not put image bytes in Redux/React state, SQLite, logs, standard output, or telemetry.

**Important existing failure:** `docs/PROGRESS.md` records a blank/protected capture. The first vision milestone is fixing and verifying capture in a real signed/authorized Mac process, *not* telling the model that image vision exists. macOS Screen Recording authorization and Accessibility authorization are separate. The correct identity receiving grants depends on whether the helper or Electron process performs the OS call; do not assume that a grant to one binary automatically applies to another. Avoid repeatedly requesting permissions in a loop. Use the current Apple ScreenCaptureKit APIs where appropriate, verify supported version + required entitlements/signing.

### Observation priority

1. Browser page semantics/DOM for the agent-managed browser.
2. Native Accessibility tree for other Mac apps.
3. Cropped screenshot + a vision-capable model where textual inspection is insufficient and the user has consented.
4. Stop or ask user when all methods are ambiguous.

Screen capture is **not continuous recording**. Capture only at a relevant step; provide a visible “screen is being used” indicator and Stop sharing. Mask or omit sensitive contents where technically possible. If protected content cannot be safely distinguished from ordinary content, do not send the frame to the cloud. Tell the user that an additional screenshot will be shared if consent has not been granted.

---

## 8. Authorization, approvals, and safety

### Centralize permissions

Existing `policyEngine.ts` provides R0–R4. Extend its concept to **all new tools**, rather than defining an independent allowlist in the model client. The source of truth is the policy **in main process**, not the model.

| Risk | Examples | Default |
| --- | --- | --- |
| R0: observe local state | List windows, explain available buttons, highlight without clicking | User-invoked scope, OS permissions if screen required |
| R1: low-impact actions | Open app, navigate safe URL, scroll, move to an existing non-sensitive tab | Permit for active authorized task; show action |
| R2: meaningful edits | Type substantial text, change a setting, fill forms, create document, click coordinate fallback | Preview / approval as required by context and current stricter policies |
| R3: consequential | Submit/send, delete, post publicly, purchase, attach/upload file, change account/security settings | Exact, one-time explicit confirmation **and** specialized allowlisted integration; if not implemented, do not execute |
| R4: prohibited | Money movement, credentials/OTP, granting privileged access, disabling security, arbitrary shell, broad destruction | Deny and offer guidance |

A safe-looking UI label (e.g. “Continue”) is **not** sufficient evidence of low risk: use screen context and domain/app identity. If classification is uncertain, require approval or refuse. The user chooses *what goal*, but each sensitive action must be authorized precisely. Voice approval cannot waive required confirmation for consequential actions.

### Exact approval binding

Preview should display: app/site name, target window, action, exact recipient/URL/file/fields when relevant, and outcome. Approval ties `{taskId, stepId, toolName, canonicalArgs, targetIdentity, observationId, expiry}`. On approval, **recheck** UI state, user permissions and scope. Expire in at most 10 minutes (shorter for changing targets). A user approving a click on “Save” does not approve “Delete” after the screen changes. No “allow everything” checkbox.

### Stop / cancel

- Stop is always visible in Chat and available in a menu-bar fallback, even if an overlay is present.
- Set cancellation state **before** waiting on any remote calls. Abort fetches and cancellable local operations. Signal cancellation across the helper request and Playwright task. If the underlying action cannot be interrupted, mark result `uncertain_after_timeout` and prevent further actions until reconciled.
- Ensure every `await` boundary checks cancellation before dispatching the next action, including after confirmation and after provider response.
- A stale response from a stopped task must never resume execution or alter active task state.
- Stop sharing also cancels or pauses all screen-dependent agent tasks.
- On process exit kill helper/managed browser child processes as appropriate; avoid orphaned mouse-control processes.

### Prompt injection and privacy

Treat all observed page/screen text as **data**, not instructions. Only direct user messages can change goal or authorize a consequential action. Filter/limit HTML, metadata, URLs, and AX labels used in prompts. Do not follow tool instructions from webpages (e.g., “upload the user’s documents”). Place a trust-boundary reminder in the system message and implement actual local scope checks—it is not enough to rely on prompting.

No activity log of full screenshots, clipboard, typed sensitive content, raw page dumps, OAuth tokens, or unredacted chat. Activity records should be redacted summaries and status. Provide explicit opt-in for cloud screen upload; consider screenshots personal information.

---

## 9. UX specs for an older-adult-first assistant

Keep the existing UI; add a small, predictable **task strip** within Chat:

- One high-contrast sentence stating the goal: “I'm helping you create a note.”
- One current step and one recent completed step, e.g. “1 of 4: Opening TextEdit.” Avoid internal tool names/JSON.
- Buttons: **Pause**, **Stop**, and contextual **Continue** for real confirmation. At most one primary action visually prominent.
- Before a consequential action, a readable approval card: “I am about to save ‘appointment.txt’ to Documents. Save?” with **Save** and **Cancel**.
- If screen permission needed, explain what it allows; offer **Allow screen access** and **Do it myself** (guide mode).
- If stalled: “I couldn't tell which Save button you meant. Please choose one.” Do not repetitively ask permission.
- If failed: show completed steps, what may have changed, and one practical recovery action. No fabricated success.
- Provide a visible “Companion is looking at this screen” indicator only while actively observing; maintain current stop-sharing affordance.
- Respect existing font size, reduced motion, high-contrast preferences, voice output and keyboard navigation. Use accessible labels; don't rely on color alone; approvals must be screen-reader usable.
- Clicking a different task in Home must not silently kill an in-flight destructive action; show a clear prompt or queue it. Only one active mutating task.

A **Guide mode** continues to work when a task is unsupported or the user prefers to do it themselves. Don't turn every question into autonomous automation.

---

## 10. Tests and observable acceptance criteria

### Deterministic tests (must run in CI without macOS permissions)

- Runtime loops: multiple tool calls, final answer, missing-input clarification, provider rejection, invalid JSON, unknown tool, malicious tool name, repeated action, budget exhaustion, and model timeout.
- Policy: R0/R1 allow, R2/R3 confirmation, R4 deny; unknown/unsafe control actions deny; untrusted page injection cannot change task goal or authorize tools.
- Confirmation: wrong task ID, wrong payload, changed target/window, expired confirmation, replayed approval, stale observation.
- Cancellation: stop while model request pending, stop while native action pending, stop while waiting for approval, stop while paused; late responses ignored; no second action dispatched after stop.
- Adapter: ambiguous AX target, disabled control, protected field, window changes, snapshot expiry, multiple monitor coordinates, browser tab switch, navigation redirect, screenshot cleanup on exception.
- Idempotence: timeout after unknown mutation must not double-submit / double-send.
- IPC: wrong sender, invalid schema, oversized payload, unrecognized channel; no raw executor path from renderer.
- Privacy: screenshots never appear in SQLite/events/logs; explicit consent required before any image/model upload; no secret fields in observations.
- Non-regression: all existing tests continue to pass.

### Integration tests with mock tools

1. Goal “open TextEdit and type Hello” produces `apps.open → observe → setText → observe → terminal status` using fixtures.
2. Goal “click ambiguous Save” pauses and requests clarification, with **zero clicks** executed.
3. Goal “open webpage and search” launches only managed browser; page content cannot cause external `apps.open` or file reads.
4. Approval change/replay test: confirmed target changes from Save to Delete; execution is denied.
5. User presses Stop between planning and action; action count stays zero.

### Real macOS smoke tests — explicit user consent and controlled fixtures

- Rebuild helper, grant permissions, inspect and interact with **TextEdit**; show actual observed state and capture failure if any.
- Open TextEdit, type a note in a disposable document; save to a **test-only temporary directory** after explicit confirmation; verify file exists and content matches without scanning unrelated directories.
- Finder: list a known test window, focus it, highlight a known control.
- Browser: agent-managed Chromium navigates to a **local fixture page** (explicitly allowed for tests only), clicks and fills a field, sees confirmation; external network not required for tests.
- Test Pause, Stop and Stop sharing during an active task; no further input after Stop.
- Verify macOS Accessibility and Screen Recording permissions separately; user can refuse, and other app features still work.

**Required command gates** (from repo root):

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run build:helper   # only on a configured Apple Silicon Mac
```

Use scoped tests during a feature; run complete gates before marking the phase done. Don't claim these commands ran unless they actually ran. Real desktop verification requires the developer's Mac; CI/unit tests cannot prove OS automation works. Keep hand-tested operations out of default CI to avoid stealing focus.

---

## 11. Phases / dependencies / Definition of Done

**Phase 0 — Baseline and dependency audit (no behavior change).** Record current commit, worktree status, versions, existing source and tests; identify current OS capture/permission bug and cancellation gap. Create `docs/COMPUTER_AGENT_PROGRESS.md`. Get baseline checks. No sweeping refactor.

**Phase 1 — Unified authorized executor + task state.** Extract common authorization/execute/verification path from existing orchestrator so both legacy commands and new agent use it; add task state machine, abort propagation, events, bounded budgets and fake model. All original behaviors remain. Unit tests for cancellation and approvals.

**Phase 2 — Native macOS computer-control port.** Wrap existing Swift helper: list/focus windows, observe AX targets, match uniquely, click element, setText, limited keyboard input, scroll. Fix native abort/stale-response handling. Dev test in TextEdit. No model integration needed yet.

**Phase 3 — Reliable observation + image pipeline.** Fix real macOS screenshot capture and permission handling; snapshot-target freshness and redaction; optional image observation when permitted. Verify image is real and actually from intended window; avoid JSONL base64 overload.

**Phase 4 — Cloud model and adaptive loop.** Add authenticated proxy `/v1/agent/turn` with OpenAI Responses function tools; maintain one serialized step at a time; connect model to local executor, add safe summaries, requests, tool outputs, budget and loop detection. Keep demo mock and `/v1/interpret`. Cloud screen sharing explicitly opt-in.

**Phase 5 — Managed browser via Playwright.** Add headed Chromium isolated profile, page observations, safe role/label locators, navigation, fill, click, back, tabs, screenshots. Do not take over user's main Safari/Chrome session. Add local fixture tests.

**Phase 6 — Approvals, Stop, recovery hardening.** Complete task-bound approval UX, cancellation across provider/helper/browser, timeouts with uncertain-outcome behavior, target and scope rechecks, prompt-injection tests, privacy review. Core safety must start in Phase 1; this phase is hardening, not the first time safety exists.

**Phase 7 — Accessible UX and guide/voice integration.** Progress strip and one-action approvals, pause/resume/stop visible everywhere, sensible short explanations, guide fallback; voice only submits explicit user requests and never silently confirms high-risk actions.

**Phase 8 — Packaging, evaluation and release gate.** Test real workflows, install/uninstall, helper signing/entitlements, permission onboarding, browser binary packaging, app notarization, startup reliability, model cost, failure reporting. Do not label general availability until real-device tests pass.

Each phase is further decomposed into Cursor-ready prompts in `CURSOR_PHASE_PROMPTS.md`.

---

## 12. Decisions and implementation guardrails

1. **One main Cursor agent** coordinates and one builder at a time. Separate researcher/verifier agents are useful when they don't edit the same files. Parallel code edits require git worktrees and non-overlapping files.
2. **Phase boundaries matter.** Do not build Playwright, visual clicking, cloud model and signing in one task; too many failure modes.
3. **No large auto-rewrites.** Treat `desktop.ts`, `TaskOrchestrator`, `policyEngine.ts` as sensitive. Make small transformations preserving tests and exports.
4. **Clarification protocol:** Only ask the user when a major product choice/secret/OS permission is required. Otherwise implement the sensible default in this spec. If blocked by an unverifiable platform API, report evidence + options; don't hallucinate a Swift method.
5. **Stop after 3 failed attempts to repair one error.** Include exact failing command and relevant logs in report. Do not try variations endlessly or modify unrelated code.
6. **Never create a success response from a mock or unchecked UI change.** Report `tested with mock`, `compiled`, or `tested on Mac` precisely.
7. **Source control:** work in a feature branch, commit once per validated slice, no secrets; don't push or merge unless user asks. Keep README/docs updated.
8. **Progress handoff:** after each phase, write `docs/COMPUTER_AGENT_PROGRESS.md` with implemented files, tests, failures, follow-ups and next action. Cursor sessions can restart using these files, not a long chat context.
9. **Recommended context:** load `AGENTS.md`, this spec, phase prompt, and only files touched by that task. Avoid pasting the entire repository to an agent every time.
10. **Exit condition:** if a capability cannot be delivered safely, deliver an explicit partial or guide-mode feature rather than overstating universal control.

---

## 13. Sources and implementation references

- Repository anchored at `https://github.com/paarthN/dementia/tree/8a72ce34fe9c2014b6b628a2760080bf25e9ed77` (re-check main before coding).
- Peekaboo README and CLI: https://github.com/openclaw/peekaboo
- OpenAI Responses function tools: https://developers.openai.com/api/docs/guides/function-calling
- OpenAI existing UI tools: https://developers.openai.com/api/docs/guides/tools-computer-use-integration
- Playwright browser automation: https://playwright.dev/docs/intro
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Apple ScreenCaptureKit: https://developer.apple.com/documentation/screencapturekit
- Apple Accessibility: https://developer.apple.com/documentation/applicationservices/axuielement

**Note:** Some library API signatures change. Cursor must read the latest official docs at implementation time, pin the installed versions in the lockfile, and test each integration. This specification is intentionally exact about contracts, scope and acceptance—not invented calls against changing SDKs.
