# Agent rules

Companion is a macOS desktop assistant. The engineering source of truth is `docs/`. Read [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md) first, then the doc for the area you are changing. Check [docs/PROGRESS.md](docs/PROGRESS.md) and [docs/TASKS.md](docs/TASKS.md) before starting work.

## Context

- Product behavior is in `docs/FEATURES.md` and `docs/UI_UX.md`.
- Tools, routing, and verification are in `docs/AGENT_SYSTEM.md`.
- Permissions and prohibitions are in `docs/SECURITY.md`.
- Stack and the Swift helper contract are in `docs/TECH_STACK.md`.
- Phase order is in `docs/IMPLEMENTATION.md`.
- Approved choices are in `docs/DECISIONS.md`.

A new session reads the relevant files before editing. Do not rely on chat memory for product rules.

## Development

- Ask when a significant product decision is unclear. Do not guess.
- Implement one small, testable change at a time. Follow the phase order. Do not start the next phase until the current phase's done-when checks pass.
- After 3 unsuccessful attempts to fix the same issue, stop and report the blocker.
- Run the appropriate typecheck, lint, and tests before calling anything complete.
- Update `docs/PROGRESS.md` after each task with what actually ran and what passed.
- Never claim a feature works without verifying it. A mock result is not a real OS action.
- Do not add an arbitrary shell tool, and do not commit secrets.

## Who does what

One main agent coordinates. It delegates only when the work is independent.

- **Builder** implements one milestone and does not review its own completion.
- **Researcher** checks current Apple and Electron docs before an API name is treated as final. It does not edit product code.
- **Verifier** runs the relevant tests and reports pass or fail. It does not edit product code.

Do not run agents in parallel when they would edit the same files. Parallel work needs separate git worktrees.
