# Browser agent session handoff — 2026-11-08

> **Superseded later the same day. Read this first.**
>
> The 4/5 (80%) below was scored on page evidence with the run outcome short-circuited.
> The stored report for that run shows **none of the five runs ended `success_verified`** —
> three ended `cancelled`, one `no_change` after burning the action budget, one `failed`.
> The benchmark now marks a task `success` only when page evidence and the run outcome
> agree, so the next live number will be lower and is the honest baseline.
>
> Root causes found afterwards, all now fixed: 34 of 35 tools were offered to the model
> with no argument schema; observations never carried the `windowId` / `bundleId` /
> `processId` that every `desktop.*` mutator requires; `tool_choice: "required"` left no
> legal way to answer `final` so the model exited through `tasks.cancel`; the
> identical-failure limit never fired because its key contained `snapshotId`; and a
> `query`-only click produced a nameless approval — which is what `reveal-note` was, not a
> flake. Approvals are now one card per task and surface. See the 2026-11-08 entry in
> [`docs/PROGRESS.md`](PROGRESS.md) and the last three entries in
> [`docs/DECISIONS.md`](DECISIONS.md).
>
> What stays true below: the Option B design, the targeting helpers, the file map, and the
> failure timeline that explains why the code looks the way it does.

**Audience:** a new agent continuing this work.  
**Status as of this file:** live LLM browser benchmark passed its `rate >= 0.8` assertion at 4/5 on page evidence. Structured targeting (Option B) is implemented. Do not restart design from scratch.

Related sources of truth:

- Design: [`docs/superpowers/specs/2026-11-08-browser-targeting-design.md`](superpowers/specs/2026-11-08-browser-targeting-design.md)
- Decision: [`docs/DECISIONS.md`](DECISIONS.md) — “Browser structured targeting (Option B)” and “Browser LLM benchmark gate”
- Running log: [`docs/PROGRESS.md`](PROGRESS.md)
- Product agent rules: [`docs/AGENT_SYSTEM.md`](AGENT_SYSTEM.md), [`AGENTS.md`](../AGENTS.md)

---

## What we were doing

Build Companion’s general-purpose **“Do It for Me”** browser control path without Playwright MCP.

1. **Architecture choice:** keep the existing `PlaywrightAdapter` (Option A / Approach 1), not a Playwright MCP server.
2. **Option B targeting** (user-approved with four amendments):
   - Structured observations (ancestors, list indexes)
   - List-relative ordinals via `within` + `itemOrdinal` (no silent global retargeting)
   - Before/after verification for actions
   - Soft target cap (~80) with `browser.observe({ within })` for truncation
   - `browser.fill` stays text-only
3. Prove it with a **real-LLM multi-task browser benchmark** (not mocks). Gate: **≥80%** of fixture tasks succeed on **page evidence**.

---

## What shipped (code)

| Area | Files |
|---|---|
| Targeting helpers | `apps/desktop/src/main/agent/ports/browserTargeting.ts` — identity keys, `resolveTargetQuery`, `preferTargets`, `preferUniqueTarget`, expectation helpers |
| Playwright adapter | `apps/desktop/src/main/agent/ports/PlaywrightAdapter.ts` — ancestors, rematch by identity / name+role, dialog-aware unique Save, stale snapshot recovery |
| Port / tools | `BrowserAutomationPort.ts`, `browserTools.ts` — query/`within`, observe-within |
| Runner enrich | `AgentRunner.ts` — `enrichBrowserMutationArgs` fills missing `name` / `role` / `ancestors` from **lastObservation** (do not re-observe for enrich; that renumbers ids) |
| Approvals | `ActionApproval.ts` — empty-name + same `observationId` match; bind-on-confirm when live resolve supplies a name |
| Goal checks | `GoalCriteria.ts`, `backend/assistant-proxy/agentSchemas.mjs`, proxy `tool_choice` forcing `task.setGoalChecks` early |
| Benchmark | `apps/desktop/tests/browserLlmBenchmark.test.ts` |
| Unit coverage | `browserTargeting.test.ts`, plus regressions in `browserAgent.test.ts`, `approvalHardening.test.ts`, `goalCriteria.test.ts` |

---

## Benchmark tasks (fixture “Library desk”)

Defined in `browserLlmBenchmark.test.ts`. Success = page text/URL evidence, not model prose.

| Id | Goal (plain) | Latest live result (2026-11-08 ~15:47) |
|---|---|---|
| `fill-search` | Type `oak` into Search; do not submit | **success** |
| `reveal-note` | Press “Show the note”; Oak Street text appears | **failure** (flake / still weak) |
| `second-result` | Open 2nd Search results item (County Library) | **success** |
| `dialog-save` | Save **inside** Confirm save dialog, not the other Save | **success** |
| `open-results` | Open Results page link | **success** |

**Suite result:** 4/5 = 0.8 → Vitest assertion `rate >= 0.8` **passed**.

Report file (local, ephemeral): `$TMPDIR/companion-browser-llm-benchmark.json`

```bash
python3 -c "import json,os; d=json.load(open(os.path.join(os.environ['TMPDIR'],'companion-browser-llm-benchmark.json'))); print([(r['task'],r['mark'],r['evidence']) for r in d['rows']])"
```

---

## Failure timeline (why the code looks the way it does)

Live scores climbed: **0% → 0% → 0% → 60% → 80%**.

| Run | Symptom | Root cause | Fix |
|---|---|---|---|
| Early | Model finals with no tools; “Still needed: a checkable plan” | No forced tool use | Proxy `tool_choice` → `task.setGoalChecks` / `required` while checks missing |
| Early | Repeated invalid `task.setGoalChecks` | Empty/weak JSON schema | Real schema + `parseGoalCriteria` normalization |
| Mid | “screen reading expired” | Model reused dead `snapshotId` | Rematch by identity, then name+role |
| 60% | `fill-search`: “type into that control” then “control changed” | Empty approval name; `sameTargetIdentity` rejected empty-empty even with same snapshot | Enrich from `lastObservation`; identity allows same `observationId` / bind-on-confirm |
| 60% | `dialog-save`: Save approved then expired / wrong Save | Enrich early-returned when name present but **role** missing; two Saves ambiguous | Always enrich role/ancestors; `preferUniqueTarget` prefers dialog Save |
| 80% | Suite passed; `reveal-note` still failed once | Click/reveal flake or weak confirmation | **Open:** harden reveal path if chasing 5/5 |

**Security note:** an API key was pasted into a terminal during debugging. If that key is still active, **rotate it**.

---

## How to re-run

Harness only (no paid model; always runs):

```bash
npx vitest run apps/desktop/tests/browserLlmBenchmark.test.ts
```

Live suite (needs all three env vars or the live `describe` is skipped):

```bash
COMPANION_BROWSER_LLM_BENCHMARK=1 \
ASSISTANT_API_KEY='…' \
COMPANION_AGENT_MODEL='…' \
npx vitest run apps/desktop/tests/browserLlmBenchmark.test.ts
```

Targeting / approval regressions:

```bash
npm run typecheck -w companion-desktop
npx vitest run apps/desktop/tests/browserTargeting.test.ts \
  apps/desktop/tests/approvalHardening.test.ts \
  apps/desktop/tests/browserAgent.test.ts \
  apps/desktop/tests/browserLlmBenchmark.test.ts
```

**Terminal tip:** only paste the command, never Vitest log output (`RUN v5…`). Pasting logs causes `command not found: RUN` / `subsh>` confusion. If live is skipped (`↓`), the three env vars were missing.

---

## Product capability (what this proves)

On the controlled fixture, the real model + Agent Browser stack can:

- Fill a text field without submitting
- Click a **list-relative** second result
- Prefer the Save **inside a dialog** when two Saves exist
- Follow a link and land on the right page

It does **not** yet prove arbitrary real-world websites, desktop Peekaboo flows, or a rock-solid 5/5 every run (`reveal-note` still failed on the passing suite).

Architecture constraint that must stay: **no arbitrary shell tool**; keep PlaywrightAdapter (no MCP swap) unless a new decision is recorded in `DECISIONS.md`.

---

## Sensible next steps for the next agent

1. Optional: diagnose `reveal-note` flake from the latest report `progress` / summary and harden click verification for reveal.
2. Update [`docs/PROGRESS.md`](PROGRESS.md) if you change behavior; keep this handoff in sync or replace it with a dated follow-up.
3. If expanding beyond the fixture, add tasks carefully and keep evidence-based scoring (page state > model claims).
4. Do not weaken approval identity checks without a security review — the empty-name / bind-on-confirm paths exist for a specific enrich failure mode.

---

## Chat context (human + agent)

- User chose Option A (keep PlaywrightAdapter) then Option B targeting with four amendments; approved design then implementation.
- User asked for a real multi-task LLM benchmark; iterated on live failures with terminal pastes.
- Latest verified outcome: live suite **2/2 tests passed**, task marks **4 success / 1 failure (`reveal-note`)**.
- User asked for this handoff markdown so another agent has full context.
