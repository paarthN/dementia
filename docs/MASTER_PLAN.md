# Companion — Master Plan

> **Status:** Source of truth for vision, scope, and architecture. The product has not been built.  
> **Working name:** Companion (placeholder; product name must be configurable, not hard-coded).  
> **Version:** 1.1 — 2026-11-04. macOS-first. Split from `OLDER_ADULT_AI_ASSISTANT_BUILD_SPEC.md`.  
> **Primary platform:** macOS 14 and newer, verified on macOS 15. Apple Silicon first.  
> **Primary audience:** Older adults who are uncomfortable with computers, plus other people who benefit from accessible digital assistance.  
> **Primary interface:** Small, persistent desktop mascot; expandable Home, Settings, and Chat panels; optional push-to-talk voice.

This folder replaces the single spec as the working reference. Read this file first, then the doc for the area you are changing.

| Doc | Use it for |
|---|---|
| [FEATURES.md](FEATURES.md) | What the product must do, journeys, and acceptance tests |
| [UI_UX.md](UI_UX.md) | Layout, mascot, panels, motion, and accessibility |
| [TECH_STACK.md](TECH_STACK.md) | Stack, processes, storage, repo layout, official docs |
| [AGENT_SYSTEM.md](AGENT_SYSTEM.md) | Routing, tools, planning, confirmation, and verification |
| [SECURITY.md](SECURITY.md) | Permissions, privacy, threat model, and prohibitions |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Phase order and done-when criteria |
| [PROGRESS.md](PROGRESS.md) | What is actually finished and what to build next |
| [TASKS.md](TASKS.md) | Small milestones and acceptance criteria |
| [DECISIONS.md](DECISIONS.md) | Approved architecture choices and what they cost if wrong |

## How an agent should use these docs

1. Inspect the repository before editing. Preserve working code unless a concrete reason requires replacing it.
2. Implement phases in [IMPLEMENTATION.md](IMPLEMENTATION.md) in order. Stop at a coherent milestone. Do not scatter incomplete scaffolds across every feature.
3. Do not claim a feature is finished unless it passes the acceptance criteria in [FEATURES.md](FEATURES.md). Update [PROGRESS.md](PROGRESS.md) with evidence.
4. Do not silently replace unsupported features with nonfunctional buttons or fake success messages. If a capability is unsupported, show **“I can help you do that manually”** or **“This feature isn't available yet.”**
5. Each major service needs a **mock provider** so the app runs without cloud credentials, and a **production provider interface** so integrations can be added later.
6. Favor simple, legible implementations. Build a real locally runnable macOS desktop app, not a static mock. An Electron web preview is not proof that macOS accessibility automation works.
7. If the Swift helper cannot run, implement the Electron UI, mocks, types, and tests first. Do not assert that the native macOS helper works without a real macOS build.
8. Record the detected environment (OS, Node, package manager, Swift, Xcode command-line tools) and pin dependency versions in a lockfile. Record version choices in [DECISIONS.md](DECISIONS.md).
9. After each phase: type-check, lint, relevant tests, and an app smoke test.
10. Do not create or use production OAuth credentials, API secrets, or paid cloud resources without authorization. Never commit credentials.
11. Permission and confirmation checks live in the execution layer. Prompt wording is not a security boundary. See [SECURITY.md](SECURITY.md) and [AGENT_SYSTEM.md](AGENT_SYSTEM.md).
12. For uncertain platform behavior, use the official docs in [TECH_STACK.md](TECH_STACK.md) and verify on a real machine.

## Priorities

1. Reliability and understandable behavior matter more than apparent intelligence.
2. User control matters more than autonomous task completion.
3. Accessibility, privacy, and security are functional requirements.
4. Start with a functioning vertical slice: mascot → chat → task routing → real safe action → verified result.

## One-sentence pitch

A friendly, always-available desktop assistant that lets older adults ask a simple question, get clear guidance, or have a safe digital task completed for them.

## Core product promise

The user should be able to say:

- **“Do this for me.”** The assistant performs an authorized task, confirms consequential steps, then verifies what happened.
- **“Show me how.”** The assistant guides one step at a time, highlighting a control when it can identify the correct element.
- **“What does this mean?”** The assistant explains the current screen, alert, dialog, or selected control in plain language.
- **“Make this easier to see.”** The assistant changes its own UI immediately and helps the user reach supported macOS accessibility settings.

All four experiences are one continuous conversation. Switching modes must not erase task context.

## What makes this different

A generic chatbot expects the user to describe the problem and then carry out the answer. This product does both:

1. A persistent mascot available during any ordinary desktop task.
2. A customizable, simplified launcher and shortcuts hub.
3. Plain-language explanations of confusing screens and errors.
4. Step-by-step on-screen guidance with highlights and progress.
5. Allowlisted task execution with real feedback and confirmation.
6. Optional preferences that gradually personalize suggestions and explanation depth.

## Personas

### A — Independent older adult, low technical confidence

Uses a Mac for email, video calls, news, banking, pictures, and occasional forms. Uncertain about unfamiliar screens and error dialogs. Wants reassurance without being talked down to. Needs large targets, straightforward language, repetition, and easy reversal.

**Job:** “Help me accomplish something on this computer without getting lost.”

### B — Older adult with visual or dexterity difficulties

Benefits from bigger text, stronger contrast, larger pointers, voice, and lower precision demands. May already use macOS accessibility aids.

**Job:** “Adapt the computer interface to what I can comfortably see and use.”

### C — Trusted family member or helper (post-MVP)

May help with setup, favorite contacts, or explaining unfamiliar services. Must not automatically gain screen, email, or account access.

**Job:** “Help configure the tool without taking away the primary user's control.”

### D — Digitally inexperienced, not necessarily older

Wants the same interface and instruction model. Avoid language that assumes age implies incapacity.

## Product principles

- **No shame.** Never use condescending praise, babyish language, or “you should already know.”
- **Plain language.** Prefer “Open your email” to “Invoke the mail client.”
- **One decision at a time.** Do not stack several unfamiliar steps in one instruction.
- **Clear agency.** Always say whether the assistant is explaining, preparing, doing, verifying, or waiting.
- **Visible consent.** Screen reading, microphone input, and consequential actions are opt-in and conspicuous.
- **Never trap the user.** Provide Close, Back, Stop, and Cancel where relevant.
- **Respect existing tools.** Work with macOS accessibility aids, including VoiceOver, Zoom, and display settings. Do not disable them.
- **Graceful fallback.** If automation is unreliable, switch to guided instructions.

## Platform

Build **macOS desktop first**. The central interaction is a persistent floating mascot. macOS exposes the Accessibility API (`AXUIElement`) for roles, labels, enabled state, and geometry. That API does not make every app or element readable or controllable. Poor metadata, custom-rendered UIs, protected content, TCC-denied windows, the lock screen, password dialogs, and changing websites can block access.

Shared UI is Electron and React. Native inspection and approved OS operations go through a Swift helper behind a platform interface. A Windows adapter can implement that same interface later. The MVP ships only the macOS implementation.

### Baseline

- Target: macOS 14 and newer on Apple Silicon. Verify on macOS 15 before claiming that version.
- Test each older major version before claiming it. Intel Macs are not an MVP target.
- Electron desktop application, not a browser-only web app.
- Internet is optional for local tools and required for remote models and web browsing.
- Mouse, trackpad, and keyboard are always supported. Voice is optional.

### Later platforms

Windows, Android, and iOS each need their own accessibility and overlay work. iOS is not a port of desktop automation. **Do not attempt cross-platform native automation in the MVP.** Keep the `OsBridge` interface so a later port is possible.

## Scope tiers

| Feature | MVP (P0) | Next (P1) | Future (P2) |
|---|---|---|---|
| Always-visible mascot with drag and collapse | Yes | Animation polish | Alternative character packs |
| Home, Settings, Chat | Yes | Contextual suggestions | Dynamic workspace |
| Favorite applications and websites | Yes | Recent tasks and suggestions | Synced preferences |
| Chat with text and guided responses | Yes | Streaming, richer context | Long-term personalization |
| Voice push-to-talk | Stub plus interface; implement if stable | Production speech | Optional opt-in wake word |
| Open app, open site, browser search | Yes | Broader allowlisted workflows | App-specific automations |
| Local reminders and notifications | Yes | Calendar sync | Shared family planning |
| Screen explanation | Accessibility-tree text first, plus a permissioned screenshot | Multimodal production model | Advanced semantic inspection |
| Highlight guidance | Accessibility-backed guide demo | Multi-step guided procedures | More apps and adaptive coaching |
| Accessibility controls | In-app scaling and themes; System Settings deep links | Native integration where tested | Wider visual adaptations |
| OS automation | Small allowlist | Better verification and recovery | Extensible skills |
| Email and calendar | Interfaces and mocks | OAuth connector(s) | Multiple providers |
| Safety and approvals | Yes | Stronger policy profiles | Delegated permissions |
| Family helper portal | No | No | Consent-scoped support |
| Screen recording history | No | No by default | Only if specifically opted into and justified |

Prohibited default behaviors are in [SECURITY.md](SECURITY.md). Detailed requirements are in [FEATURES.md](FEATURES.md).

## First useful build

The first useful build must:

- Launch as a macOS desktop app and show a small mascot above ordinary windows.
- Open Home, Settings, and Chat with mouse or keyboard.
- Reposition the mascot and persist its placement.
- Save favorite applications and websites and launch valid selected targets.
- Accept text commands and route them to a small, safe set of working tools.
- Open an application, open a vetted website, search the web in a browser, and create a local reminder.
- Show a visible confirmation, an understandable failure, or a recovery option.
- Offer a screen-guidance demo tied to a **real inspected UI element** or the app's own test fixture. Guessed coordinates are not verified highlights.
- Include a mock AI mode that works without paid services. Cloud AI is a separate, testable extension.

**Out of scope for that build:** unrestricted control of any website, protected program, email account, or financial transaction.

## Architecture at a glance

Three Electron windows (mascot, panel, guidance overlay) talk to the main process through a typed preload API. The main process owns preferences, the task orchestrator, the tool registry, and the policy engine. A local Swift helper speaks JSON Lines over stdio for Accessibility inspection and approved OS operations. A remote model is reached only through an opted-in secure proxy. The desktop policy engine still checks every tool call.

```text
Mascot / Panel / Guidance renderers (React)
        │ typed preload IPC
Electron main: preferences, orchestrator, policy, tools
        │                         │
        │ JSONL stdio             │ HTTPS only if opted in
        ▼                         ▼
Swift macOS helper          Secure backend proxy
Accessibility, windows      Remote LLM / STT / TTS
```

Full diagram, stack, and storage are in [TECH_STACK.md](TECH_STACK.md). Behavior of the orchestrator is in [AGENT_SYSTEM.md](AGENT_SYSTEM.md).

## Success

**Primary metric:** share of core tasks completed correctly without outside help, while the user understands what happened and keeps control. Do not optimize only for automatic clicks.

Supporting measures:

- Task success by type (`execute`, `guide`, `explain`).
- Error recovery rate.
- Wrong-target highlight rate (must stay exceptionally low).
- User-initiated cancellations and why.
- Time to first success after install.
- Repeated instructions before completion.
- False confirmations or unapproved actions (**zero in release tests**).
- Opt-in measurement only. No invasive telemetry by default.

### Pilot gate

A build is ready for a controlled pilot when:

- Install and basic navigation work on macOS without developer tools.
- Every P0 tool is implemented or visibly marked unavailable.
- The guided TextEdit Save example works on the target macOS versions.
- Consent and emergency stop have been tested.
- About 10–15 representative users try the workflows with observation.
- No known failure allows an unapproved consequential action.

### First user study

Give each participant 4–6 tasks: open a familiar app from Home, search for a hobby topic, create a reminder, ask what an unfamiliar dialog means, follow one highlighted step, and make the interface easier to read. Record success, confusion, whether privacy cues are understood, and whether the mascot feels helpful or intrusive. Test with and without a facilitator.

Usability measures: completion without help, median time and extra steps, wrong clicks, requests to repeat, perceived control, willingness to use again, and unexpected screen or microphone collection (target: zero).

## Open decisions

These defaults do not block P0.

| Decision | Starting point | Revisit when |
|---|---|---|
| Product name | Companion | Branding is chosen |
| Mascot style | Original geometric character | User research |
| Default placement | Right edge, near the lower corner | Dock, menu bar, and accessibility feedback |
| First OS | macOS 14+, Apple Silicon, verified on macOS 15 | Pilot data |
| Chat model | Mock local provider | A backend exists |
| Voice default | Off; push-to-talk | Reliability and consent are validated |
| Chat retention | Session-only or explicit opt-in | Privacy and legal review |
| First guided workflow | TextEdit Save | Pilot usability |
| First OAuth provider | Google or Microsoft, one only | The audience's ecosystem is known |
| Family sharing | Not in MVP | A consent model is proven |
| Windows or mobile | Not in MVP | macOS product-market fit |

## Did we build the right thing?

The product is succeeding when a person with little computer experience can:

- [ ] Find the assistant without hunting through menus.
- [ ] Click the mascot and understand Home, Settings, and Chat immediately.
- [ ] Open familiar apps and websites from large tiles.
- [ ] Ask in a normal sentence, not a technical command.
- [ ] Ask for help instead of handing control to the agent.
- [ ] See a real, correctly placed highlight for the next action.
- [ ] Ask what an unfamiliar pop-up means and get a plain explanation.
- [ ] Make Companion easier to read and find Mac-wide visual settings.
- [ ] Create a reminder and trust it while the app is running.
- [ ] Know whether the assistant is listening, looking, acting, or waiting.
- [ ] Stop an action, deny screen access, close the mascot, or quit.
- [ ] See a truthful error when a task cannot be completed.
- [ ] Keep control of messages, purchases, passwords, and security decisions.

**Design rule:** The assistant should increase digital independence. It should not hide what the computer is doing or make the user depend on an opaque agent.
