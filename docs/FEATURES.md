# Features

Detailed product requirements, user journeys, the error contract, and acceptance tests. Visual layout is in [UI_UX.md](UI_UX.md). How tasks run is in [AGENT_SYSTEM.md](AGENT_SYSTEM.md). Phase order is in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Scope tiers and the first-useful-build bar are in [MASTER_PLAN.md](MASTER_PLAN.md).

## Home

### Favorite applications

A favorite stores a unique ID, user-visible name, icon reference, validated application identifier or path, last launch date, and order. The model must not invent or run arbitrary shell commands.

Supported launch methods:

- Known macOS bundle IDs and approved URL schemes, when supported.
- Verified application locations from Launch Services.
- A vetted allowlist of first-party launch actions.

If an app is missing, show “I couldn't find [app] on this computer” and offer to edit or remove the favorite. Do not show success until the OS launch succeeds. Optionally verify that the app window appears.

### Favorite websites

- Store an `https://` URL and a display name.
- Normalize URLs without changing the user's intent.
- Warn before a suspicious or newly changed domain. Reject `javascript:`, `file:`, and arbitrary executable protocols.
- Open the default browser with a validated `https:` URL.
- Add, edit, delete, and reorder with undo for local list edits.

### Common task cards

Each card has `id`, `title`, `description`, `icon`, `kind`, `actionKey`, `requiresPermissions`, and `available`.

- One click runs a local low-risk action or opens a prefilled Chat request.
- Cards never directly send, purchase, or delete.
- Reorder with accessible move-up and move-down controls, not drag alone.

Starter cards: “Search the internet,” “Set a reminder,” “Make text bigger,” “Explain my screen,” “Open email,” and “Call for help.” “Call for help” opens an assistance view. Do not invent a phone service.

### Home acceptance

- Favorites remain after restart.
- Long names truncate and still expose the full text through an accessible name or tooltip.
- A missing app and an invalid URL show recoverable errors.
- A keyboard-only user can reach and activate every tile.
- Favorite order survives edits.

## Settings behavior

Separate **Companion appearance** (this app) from **macOS System Settings**. Never imply a Mac-wide change when only this app changed. Control sizes, themes, and deep links are specified in [UI_UX.md](UI_UX.md).

| User asks | P0 behavior | Direct OS change later |
|---|---|---|
| “Make all Mac text bigger” | Explain and open Accessibility > Display, text size | Only after a documented, tested mechanism |
| “Make everything bigger” | Open Displays | Do not force a resolution or scale change |
| “Turn on Zoom” | Open Accessibility > Zoom, and explain how to turn it off | A shortcut only after explicit confirmation and testing |
| “Make the pointer bigger” | Open Accessibility > Display, pointer | Direct setter only if supported and tested |
| “Improve contrast” | Open Accessibility > Display, contrast options, and explain them | Only after a native adapter is tested |
| “Make my screen brighter” | Open Displays and explain hardware limits | Optional hardware support with feedback and rollback |

Brightness may be unavailable on external monitors. The service reports `supported`, `unsupported`, `requiresUserAction`, or `failed`. It does not invent success.

Privacy controls that must exist:

- Explicit screen-capture enable and revoke.
- Clear local chat history.
- Delete local preferences and data separately from resetting appearance.
- View and disconnect accounts once integrations exist.
- Show what is sent to a remote AI provider, and when.
- Diagnostic telemetry **off by default**.
- Launch at login is a toggle. Never silent auto-run on first install.

## Chat capabilities

Natural language is the primary entry. Do not force a mode before every message. Two shortcuts sit at the top of Chat: **Do it for me** and **Show me how**. The router may propose a mode. The user can switch at any time.

- “Send this photo to my sister” → action intent; ask which photo and recipient, then preview and confirm.
- “How do I send a photo?” → guidance.
- “What is this pop-up?” → screen explanation.
- “Make the writing bigger” → in-app change or OS-settings guidance, depending on context.

### A — Direct task completion

The assistant plans a supported task, calls permitted tools, waits for required confirmations, verifies the result, and explains the outcome.

First tasks:

- `open_application(appId)` — launch a known app, a favorite, or another installed app by its name.
- `open_website(url)` — open a validated HTTPS site.
- `search_web(query)` — open a browser search with an encoded query.
- `create_reminder(title, triggerAt, timezone)` — save and schedule a local reminder.
- `list_reminders()` and `cancel_reminder(id)` — manage reminders; confirm cancellation when ambiguous.
- `open_system_settings(section)` — open a known System Settings page.
- `change_companion_setting(key, value)` — change only Companion-owned visual settings.

Later, with dedicated tools and OAuth: email search, summarize, draft, and send after confirmation; calendar list, draft, create, update, and cancel after confirmation. Photo sharing, site-specific workflows, shopping, and forms are not generic first-phase capabilities.

Success example: “I opened your browser and searched for easy gardening tips.”  
Failure example: “I couldn't open the browser. Would you like me to show you how?”

### B — Step-by-step assistance

One active step at a time, with an optional highlight on an identified control.

```text
Request received
→ Select a supported guide or inspect the current app
→ Identify the next target
→ Show step text and a highlight
→ Wait for the user's click or an explicit “Next”
→ Verify observed state when possible
→ Advance, retry, or re-identify
→ Complete with a short summary
```

Each step has:

- One plain instruction, normally under 25 words.
- An Accessibility selector, or an explicit mark that the step is manual.
- An optional highlight from currently verified Accessibility geometry.
- “I did it,” “Repeat,” “Can't find it,” “Do it for me,” and “Stop” as appropriate.
- A step indicator such as “Step 2 of 4.”

Do not advance because a click was inferred near the target. Prefer an Accessibility state change, a role check, or explicit confirmation. If the screen changes, drop the stale highlight and re-inspect.

### C — Screen explanations

Examples: “What does this error mean?”, “What is this pop-up asking?”, “Is this website asking for my password?”, “What does the blue button do?”

1. Check screen-inspection permission.
2. Inspect the foreground window and accessible tree.
3. If metadata is inadequate, ask permission for one screenshot or an explicitly started capture session.
4. Redact or withhold sensitive content. Do not collect hidden password values.
5. Say what was observed, what is uncertain, and any risks.
6. Offer safe next steps. Never approve a suspicious dialog by default.

Example: “This window is asking whether the app can make changes to your computer. If you weren't expecting an installation, choose No. I can't safely approve it for you.”

### D — Visual changes from chat

- “Can you make your text larger?” → `change_companion_setting`, then confirm the visible change.
- “Make everything on my Mac bigger.” → open the supported System Settings page and offer guidance.
- “Use a darker theme.” → if unclear, ask whether they mean Companion or the Mac.

Every response names the **scope**:

- “I made the text in this assistant larger.”
- “I opened Mac text-size settings so you can change the size across the Mac.”

### Switching modes mid-task

“Help me attach a file to an email,” then “Actually, can you do it?”

- Keep the objective and any safe known context.
- If an authenticated email connector exists, create a draft and ask before sending.
- If it does not, say so and keep guiding inside the mail app.
- UI automation is not a substitute for an authorized email API.

## Voice

Typed chat is fully functional in the MVP. Voice starts when the user clicks Listen and stops when they click Stop. No always-on microphone. No hidden wake word.

1. The user clicks Listen.
2. The UI shows “Listening.”
3. Speech becomes text in a visible, editable field.
4. The user can correct and send, or turn on auto-send after transcription.
5. The reply is text. Optional speech reads it aloud.
6. Stop, mute, and retry are always available.

Safety:

- Microphone defaults to off.
- No silent hot-mic sessions and no background uploads.
- Do not store raw audio by default.
- Say when a third party is transcribing.
- A voice command cannot skip confirmation for sending, purchases, account changes, or deletion.
- Uncertain transcription of a consequential action requires read-back and confirmation.

Provider interfaces live in [TECH_STACK.md](TECH_STACK.md).

## Reminders

Local reminders work without Google or Microsoft accounts.

- “Remind me to call Sarah tomorrow at 2.”
- “Remind me to take my umbrella at 7 tomorrow morning.”
- “What reminders do I have this week?”
- “Cancel the reminder to call Sarah.”

```ts
interface Reminder {
  id: string;
  title: string;
  notes?: string;
  triggerAtUtc: string;
  timezone: string; // IANA, e.g. America/Los_Angeles
  status: 'scheduled' | 'fired' | 'completed' | 'cancelled';
  createdAtUtc: string;
  updatedAtUtc: string;
  source: 'user' | 'assistant';
}
```

- Ask one follow-up when the date or time is ambiguous.
- Restate the resolved absolute local date and time in the confirmation or success message.
- Persist in SQLite.
- On restart, reload scheduled reminders and detect missed ones.
- If the computer was off, show the missed reminder at next launch. Do not invent a notification while powered off.
- Honor the local timezone and daylight saving transitions.
- Notification actions: “Done,” “Snooze 10 minutes,” “Open assistant.” Large and labeled.
- Cancel updates state and unregisters the scheduled notification.
- Snooze sets a new due time without duplicating the user-visible reminder.

MVP scheduling is a persisted local scheduler while the app runs, plus restart reconciliation. Do not claim OS background notifications work after the process exits unless a background task has actually been implemented and tested.

## Screen understanding

Two sources, used together:

- **Accessibility inspection** is preferred for actionable controls: name, role, enabled state, bounds, and supported actions. macOS uses `AXUIElement`.
- **A permissioned screenshot** is a fallback for explanation. It is not proof that an element is safe to click.

Selection priority: exact app or window, then automation ID and control type, then accessible name and structure, then action pattern and enabled state, then verified geometry. Coordinates are a last resort, with confirmation and a fresh targeting check.

Do not keep raw Accessibility element references across unrelated window updates. Use snapshot IDs and re-resolve before invoking or highlighting.

Capture rules:

- `ScreenCaptureService` exposes `requestPermission`, `captureForegroundWindow`, `captureSelectedDisplay`, and `stop`.
- Prefer OS capture indicators. Electron `desktopCapturer` is allowed for the MVP only with an app-owned consent UI and a visible capture banner.
- Prefer one still image for “What does this mean?” over a stream.
- Hide Companion windows before capture so the assistant does not analyze itself.
- Mask known sensitive regions. Skip password dialogs and protected desktops.
- Drop image buffers after the request unless the user explicitly saves them.
- Fail clearly on denial, black or protected captures, an inaccessible window, or a display change.

A remote model may explain a screen. That is not permission for the model to drive the machine. The prompt contract is in [AGENT_SYSTEM.md](AGENT_SYSTEM.md).

## User journeys

### 1 — First launch

1. The installer finishes. The user chooses to launch.
2. Welcome: “I can help you use your computer.”
3. Three examples: ask a question, open an app, get step-by-step help.
4. Choose text size and optional reduced motion.
5. Explain microphone and screen permissions. Do not pre-enable them.
6. Offer favorite apps and sites. Skipping is allowed.
7. Show the mascot and how to reopen it from the menu bar.
8. Onboarding completes without an account.

If the native bridge is unavailable, say screen guidance may be limited. Home, typed chat, and local reminders still work.

### 2 — Hover or click the mascot

Idle near the edge. A short hover previews Home, Settings, and Chat. Click and keyboard do the same reliably. Home opens beside the mascot. Clicking outside or pressing Escape closes a transient menu and does not silently abandon a running task. Position and theme persist.

### 3 — Launch a favorite app

Home → TextEdit. Resolve the bundle ID `com.apple.TextEdit`. The main process launches it, using the Swift helper if needed. Report “TextEdit is open.” If missing, offer to edit the favorite or choose an app.

### 4 — Search from chat

“Search for simple tomato soup recipes.” Route to `search_web`. Policy treats it as low risk. URL-encode the query. The default browser opens the search page. Confirm that the search was opened, not that a result was read.

### 5 — Reminder

“Remind me Friday at 3 PM to call the pharmacy.” Parse with the user timezone and today's date. Ask if ambiguous. Write SQLite and register the scheduler. Confirm the exact local time. When due and the app is running, notify with Done and Snooze. After a missed time, say “You missed this reminder.”

### 6 — Explain a warning

Chat → “Explain this screen.” Say what can be inspected and request permission if needed. Read the foreground Accessibility tree. Optionally offer one screenshot. Explain in plain language. For a security or password dialog, urge caution and do not press Continue. Offer “Show me what to do next.”

### 7 — Guided click

“Show me how to save this in TextEdit.” Load the guide and confirm TextEdit is in front. Find File or Save through the Accessibility tree and highlight it. Say “Click File at the top of the window.” Advance only after a reliable state change or “I did it.” If the control is missing, give `Command+S` and remove the highlight. End on the real state, such as “You've opened the Save dialog.”

### 8 — Readability

“Make the assistant easier to read.” Change the app's text-size preset and contrast immediately. Keep the layout usable. Say “I made the text in this assistant larger.” Reset remains available.

### 9 — Mac-wide text

“Make all my computer text bigger.” Distinguish the Mac from Companion. Open System Settings text-size controls. Explain the native control in one step. Do not claim the OS value already changed.

### 10 — Stop

During a low-risk multi-step task, Stop or the cancel shortcut sets a cancellation flag and blocks further tool calls. Already finished steps stay listed accurately. Return to idle. No leftover highlights.

### 11 — Permission refused

A screen explanation is denied. Say “I can't see the screen without permission. You can describe the message, or turn on screen access for this request.” Do not re-prompt in a loop. Typed chat and non-screen actions stay available.

### 12 — Moving target

A Save button's rectangle goes stale when the window moves. Detect the change, remove or recompute the overlay, and revalidate. If the target is gone, switch to manual guidance.

### 13 — Protected window

The helper reports a limitation, a password dialog, the lock screen, or a window that Accessibility or Screen Recording cannot read. Do not bypass it or approve the secure UI. Explain the dialog in general terms and leave the decision to the user.

### 14 — Low confidence

If the interpretation lacks screen evidence, say “I can't verify this from what I can see.” Offer a consented screenshot or ask the user to read the text. Do not invent a button label or a completed action.

### 15 — Stop sharing

While a capture session is active, “Stop sharing” ends capture, releases buffers, and clears the indicator. The screen-dependent task pauses or fails safely. Chat still works.

## Error contract

| Problem | Detection | Tell the user | Engineering behavior |
|---|---|---|---|
| Sidecar will not start | Spawn or heartbeat failure | “Some screen-help features are unavailable.” | Retry once, log a safe code, keep the UI alive |
| No microphone | Device or permission failure | “Your microphone isn't available. You can type instead.” | Fall back to text |
| AI provider timeout | Request timeout | “I couldn't reach the assistant service. Try again.” | Abort; no false completion |
| Screen access denied | Consent result | “I won't look at your screen.” | No consented capture or inspect |
| Element not found | Empty Accessibility query | “I can't reliably find that button.” | Stop the highlight; offer a manual guide |
| App not installed | Resolver failure | “I couldn't find that app.” | No arbitrary shell fallback |
| Invalid URL | Validation failure | “That website address doesn't look safe or valid.” | Reject the scheme or domain |
| Reminder in the past | Date check | “That time has passed. When should I remind you?” | Do not schedule silently |
| Computer was off | Startup reconciliation | “Here's a reminder you missed.” | Mark missed or fired honestly |
| Several matches | Selector returns more than one | “Which button do you mean?” | Never click at random |
| Permission revoked mid-task | Permission event | “Screen access has stopped.” | Abort capture and related steps |
| Verification failed | Postcondition check | “I tried, but couldn't confirm it worked.” | Mark partial or failed; offer recovery |
| Page tells the AI to act | Policy boundary | “I won't act on instructions from the page.” | Reject the unauthorized step |
| Lock screen or password dialog | Native detection | “I can't work with that secure screen.” | Do not inject input |

## Acceptance catalog

Implement unit tests where possible. Use a manual macOS script where the OS is required.

### Mascot and navigation

- **T-MAS-01:** Start → mascot appears at a valid screen-edge position.
- **T-MAS-02:** Click → Home, Settings, and Chat are visible and each opens.
- **T-MAS-03:** Keyboard can open Chat and use it.
- **T-MAS-04:** Drag to another monitor → restart → saved position is still valid.
- **T-MAS-05:** Transparent area around the mascot does not block clicks on the app behind it.
- **T-MAS-06:** Menu-bar Restore works after hide or collapse.
- **T-MAS-07:** Unplug the second monitor → mascot is recoverable on the primary monitor.

### Home and settings

- **T-HOME-01:** Add a website → it persists → it opens the intended domain.
- **T-HOME-02:** `javascript:` and `file:` favorites are rejected.
- **T-HOME-03:** An unknown app shows failure, not success.
- **T-SET-01:** Larger text resizes panel content without clipping controls.
- **T-SET-02:** High contrast stays readable and keyboard accessible.
- **T-SET-03:** Reset appearance leaves reminders and favorites intact.
- **T-SET-04:** A System Settings shortcut opens the real page, and the assistant says it opened the page rather than changed the value.

### Chat and tasks

- **T-CHAT-01:** Empty or whitespace input is rejected with a useful hint.
- **T-CHAT-02:** A supported open-app intent launches the app or reports a precise error.
- **T-CHAT-03:** A search query with spaces and symbols is URL-encoded.
- **T-CHAT-04:** A failed tool cannot produce a success message.
- **T-CHAT-05:** Cancellation blocks later queued tool calls.
- **T-CHAT-06:** No renderer API can run an arbitrary shell command.
- **T-CHAT-07:** An unknown tool name from the model is rejected.
- **T-CHAT-08:** An R3 action without approval is rejected.
- **T-CHAT-09:** Instructions inside UI content cannot change authorization, including requests to exfiltrate data.

### Reminders

- **T-REM-01:** A reminder due in two minutes fires while the app is running.
- **T-REM-02:** Restart before it is due → it still fires.
- **T-REM-03:** Cancel → it never fires.
- **T-REM-04:** Missed while the app was off → shown on next launch.
- **T-REM-05:** A DST or timezone case yields the correct absolute time or an explicit ambiguity question.

### Screen and guidance

- **T-SCR-01:** Without consent, capture refuses.
- **T-SCR-02:** With consent, inspection returns the foreground title and exposed controls.
- **T-SCR-03:** A password dialog, the lock screen, or a TCC-protected window cannot bypass security restrictions.
- **T-SCR-04:** Revoke → capture ends, the indicator updates, and the task stops.
- **T-GUIDE-01:** A valid Accessibility element gets a correctly aligned highlight.
- **T-GUIDE-02:** When the window moves, the highlight tracks or disappears safely.
- **T-GUIDE-03:** When the control disappears, the guide says it is unavailable and does not keep a stale box.
- **T-GUIDE-04:** The overlay does not intercept the click meant for the button underneath.
- **T-GUIDE-05:** Mixed 100% and 150% scaling produces correct highlight bounds.
- **T-GUIDE-06:** Stop ends the guide and removes every overlay.

### Accessibility and security

- **T-ACC-01:** The full experience works without a microphone.
- **T-ACC-02:** Primary navigation is entirely keyboard operable.
- **T-ACC-03:** A screen reader announces controls and confirmation status sensibly.
- **T-ACC-04:** The UI stays usable at large text and 200% OS scaling.
- **T-SEC-01:** The renderer cannot read secrets or call unexposed Electron APIs.
- **T-SEC-02:** Stored preferences contain no API keys or OAuth tokens.
- **T-SEC-03:** Screenshots and microphone audio are not persisted by default.
- **T-SEC-04:** A new confirmation is required if the target, recipient, or action changes.
- **T-SEC-05:** Stop and permission revocation fail closed during an active task.
