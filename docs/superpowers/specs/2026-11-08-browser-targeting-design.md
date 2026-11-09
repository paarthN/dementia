# Browser structured targeting (Option B)

**Status:** Approved 2026-11-08 (Approach 1 + four amendments)  
**Scope:** Enrich existing `PlaywrightAdapter` / `BrowserAutomationPort`. No Playwright MCP. No second agent loop. No app-specific finishers.

## Amendments locked in

1. Ordinal targeting is list-relative: `within` selects a list (or similar container); optional `itemOrdinal` selects the Nth `listitem` inside it; role/name then resolve inside that item. Not “Nth matching link globally.”
2. No silent retargeting: clicks bind to the observed target’s identity (role, name, ancestor chain). List reorder must not click a different element that now sits at the old index. Identity rematch may still click the same control at a new index; a missing identity requires a fresh observation.
3. Verification compares before/after; `expectTextIncludes` / `expectUrlIncludes` only count when newly true after the action. Brief wait for async UI. If no reliable evidence, return `changed_but_unverified`.
4. Soft cap ~80 targets; `browser.observe({ within })` returns more targets inside a selected container. Checkbox/radio state is not part of `browser.fill` (fill is text only; toggle via click).

## Action vs task

Adapter statuses mean action evidence only. Task completion stays on `task.setGoalChecks` / `evaluateGoalCriteria`.

## Implemented

- `browserTargeting.ts` helpers + unit tests
- Enriched `BrowserTarget` / observe-within / click query + expectations in `PlaywrightAdapter`
- Tool wiring in `browserTools.ts`; model target schema allows ancestors / `inListIndex` (max 80)
- Regression coverage in `browserAgent.test.ts` (list ordinal, reorder identity, expectText before/after, scoped observe)

## Next after green tests

Real-LLM multi-task browser benchmark (`apps/desktop/tests/browserLlmBenchmark.test.ts`). No further architecture until that shows concrete weaknesses. Live run requires `COMPANION_BROWSER_LLM_BENCHMARK=1` plus proxy model env vars.
