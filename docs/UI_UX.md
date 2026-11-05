# UI and UX

Visual design, windows, and interaction. Feature behavior and acceptance tests are in [FEATURES.md](FEATURES.md). Accessibility is a requirement here, not polish.

## Navigation

The mascot is the root. Click, keyboard activation, or an optional hover expansion exposes **exactly three** entries:

1. **Home** — favorite apps, favorite websites, and common tasks.
2. **Settings** — reading comfort, mascot appearance, privacy, voice, and basic behavior.
3. **Chat** — tasks, step-by-step help, explanations, and visual requests.

Every panel has a visible **Close / Collapse**. A separate **Stop** control exists during any running task.

```text
Persistent Mascot
├── Home
│   ├── Favorite applications
│   ├── Favorite websites
│   ├── Quick actions / common tasks
│   ├── Recent tasks (optional, P1)
│   └── Edit favorites and shortcuts
├── Settings
│   ├── Display and reading comfort
│   ├── Mascot and panel customization
│   ├── Voice input and output
│   ├── Privacy and permissions
│   ├── Startup and notifications
│   └── About, help, reset
└── Chat
    ├── Local conversation history (opt-in persistence)
    ├── Talk or type
    ├── Do it for me
    ├── Show me how
    ├── Explain this screen
    ├── Make it easier to see
    ├── Confirmation and progress
    └── Stop / try again / switch to guidance
```

Mode is a preference, not a gate. Chat accepts natural language first. **Do it for me** and **Show me how** are shortcuts, not a required first step.

## Mascot

**MAS-001 — Floating window.** A small transparent, frameless, always-on-top Electron `BrowserWindow`, separate from the panel. Idle, it must not take keyboard focus.

**MAS-002 — States.** `idle`, `hovered`, `menuOpen`, `listening`, `thinking`, `acting`, `waitingForUser`, `speaking`, `error`, and `collapsed`. Each state has a visual cue and an accessible text label.

**MAS-003 — Dragging.** Drag within the visible work area. Persist coordinates relative to the selected monitor and work area, not absolute pixels only.

**MAS-004 — Hover and click.** Hover may preview the three actions after about 350–500 ms. Click, Enter, and Space must always work. Hover is not required to discover the menu.

**MAS-005 — Collapse.** Reduce to a small tab or dot, restore it, hide it from the menu bar, or move it aside. A menu-bar status item is how the user gets it back.

**MAS-006 — Placement.** Default near the lower-right edge, clear of the Dock. Handle Dock moves, monitor disconnect, display-scale changes, and multiple displays.

**MAS-007 — Persistence.** Save position, collapsed state, color, and whether to launch at login.

**MAS-008 — Non-obstruction.** The idle hit target is only the mascot. Transparent surroundings must not eat clicks. Overlays use click-through where appropriate. Test `setIgnoreMouseEvents` and turn input back on when the mascot itself is used.

**MAS-009 — Keyboard.** A configurable global shortcut opens and closes Chat. Proposed default: `Control+Option+Space`, after checking conflicts. A second shortcut may focus the mascot. If registration fails, warn in Settings.

**MAS-010 — Honest motion.** Listening or acting animation appears only while the microphone is actually capturing or a tool is actually running.

### Appearance

Default look: an original geometric character with expressive eyes, simple motion, and a soft neutral palette. No copyrighted character. MVP assets are bundled SVG with deterministic CSS. No remote image host.

| State | Motion | Announcement |
|---|---|---|
| Idle | Resting or breathing, or still | “Assistant ready” |
| Hovered | Slight lift or outline | “Open assistant options” |
| Listening | Microphone pulse and a visible mic | “Listening. Press Stop to end.” |
| Thinking | Gentle dots. Do not claim a task is running | “Preparing an answer” |
| Acting | Bounded progress | “Working on: [task]” |
| Waiting | Static question mark | “Waiting for your approval” |
| Error | A distinct, calm warning mark | “Something went wrong. Open for details.” |
| Collapsed | A small recoverable side tab | “Expand assistant” |

Reduced motion is optional and should be offered. Idle animation must not flash, jitter, or distract.

### Three windows

The Electron main process owns:

1. **Mascot window** — transparent, always on top, narrow hit region.
2. **Panel window** — Home, Settings, and Chat in a normal desktop window, about 1040×680 CSS px, with a sidebar and a content column. Minimum about 860×560. It stays inside the work area, can be resized, and is keyboard accessible.
3. **Guidance overlay** — transparent, per-monitor, click-through. It draws borders, arrows, labels, and optional dimming without capturing clicks meant for the target app.

Do not draw over the lock screen or a password dialog. Do not assume an overlay appears above protected fullscreen windows. Keep the overlay and panel aligned when the display or target window changes. Prefer separate windows over one full-screen transparent window that swallows the mouse. macOS may require a panel-style window and `setVisibleOnAllWorkspaces` for the mascot and overlay. Prove that on a real display before calling it done.

### Focus

- Mascot click opens the menu or the last panel. It never starts a task by itself.
- Opening a panel focuses the first meaningful control, unless a guided target app must keep focus.
- Closing the panel returns focus to the previous app when that is reasonable.
- Escape closes a transient menu. During a running action it offers an explicit stop or cancel. It does not abandon the task silently.
- If another app is fullscreen, the menu bar and shortcut still work when the overlay cannot.
- During a highlight, the target stays visible. The side panel must not cover the highlighted control.

## Home layout

**Header.** A time-of-day greeting is optional. Include “What would you like to do?” and a prominent Chat button.

**Favorite apps.** Large tiles: icon, name, one-click launch. Show 4–8 first. More live in scroll or “All favorites.”

**Favorite websites.** Large tiles with an editable label and a trusted URL. Show the domain while editing and when opening an unfamiliar site.

**Common tasks.** Large action tiles. See the starter set in [FEATURES.md](FEATURES.md).

**Footer.** Edit Home, Help, and a privacy indicator when screen access is on.

## Settings layout

### Companion display (P0)

**SET-001 Text size.** Presets `Comfortable`, `Large`, and `Extra large`, plus optional fine adjustment. Body sizes: 15 px, 18 px, and 22 px. Usable at 200% display scale.

**SET-002 Content scale.** Scale layout, type, and icons together through design tokens. Avoid browser zoom if it breaks overlay alignment.

**SET-003 Contrast and theme.** At least `Light`, `Dark`, `High contrast`, and `Follow system`. High contrast uses deliberate, tested tokens.

**SET-004 Pointer aid.** Open macOS pointer settings. An optional in-app high-visibility pointer helper can come later. Do not install a global mouse hook for a decorative cursor.

**SET-005 Reading comfort.** Reduce motion, extra line spacing, and straightforward language.

**SET-006 Preview.** Companion changes apply immediately, with a visible preview and **Reset to default**.

### Mascot and panel customization

- A small set of original mascot colors: blue, teal, purple, coral, neutral.
- Panel accent from accessible presets. Unrestricted color pickers that produce unreadable text are not the default.
- Mascot size: small, medium, large.
- Toggles for idle animation and sound.
- Restore defaults without deleting favorites or reminders.
- Persist locally.

### Voice settings

- Microphone permission state, and an input device selector when the OS provides one.
- Push-to-talk by default, with an optional shortcut.
- Voice output on or off. Volume and speed when the TTS provider supports them.
- Status is one of “Microphone off,” “Listening now,” or “Microphone not available.”
- Chat uses a Listen button. Click starts the microphone. Click Stop ends it.
- Stopping voice leaves text chat working.

### System Settings group

Deep links and guided navigation. Verify the URL scheme on the target macOS version. If a direct page is missing, open the broader Accessibility or Displays page. The mapping of each request is in [FEATURES.md](FEATURES.md).

## Chat layout

1. **Header.** Title, close, and an editable mode indicator.
2. **Message feed.** User and assistant messages, readable timestamps, spacing, and a copy button.
3. **Context banner.** “Screen access: Off/On” and “Microphone: Off/Listening.”
4. **Suggestions.** “Open an app,” “Help with this screen,” “Make text bigger,” “Set a reminder.”
5. **Composer.** A message field, Send, and Listen. Enter sends. Shift+Enter adds a line.
6. **Task area.** Progress, confirmation cards, Stop, Cancel, Try again, and Switch to guidance.
7. **Live region.** Polite announcements for new status. Do not read every streamed token.

Short paragraphs. Optional “More details.” No raw technical dumps.

### Confirmation card

- **What will happen:** verb, target or recipient, and the relevant content.
- **What could change:** for example, “This will send an email.”
- **Primary button:** the specific verb, such as “Send email.” Never a bare “OK.”
- **Secondary:** “Cancel,” and “Edit” when useful.
- Approval expires after a sensible time or when the target data changes.
- A unique `approvalId` is bound to the exact payload. Editing invalidates it.

The policy behind the card is in [AGENT_SYSTEM.md](AGENT_SYSTEM.md) and [SECURITY.md](SECURITY.md).

### Guidance callout

High-contrast rounded outline around a validated element, plus a callout that does not cover the element. Hide the highlight when there is no reliable target and give plain instructions instead. If the target is off-screen or covered, say so. Offer “Can't see the highlight?” and keyboard-only instructions.

Highlight rules **GUIDE-001** through **GUIDE-008**, including click-through, multi-monitor, and mixed DPI, are acceptance requirements in [FEATURES.md](FEATURES.md).

## Inclusive design

Use WCAG 2.2 AA as the benchmark where it applies.

- Body text about 20 px, adjustable larger. Controls stay legible at 200% OS scaling.
- Targets at least 44×44 CSS px, larger for primary actions.
- Contrast at least 4.5:1 for normal text, 3:1 for large text, and 3:1 for essential non-text UI.
- Status is never color alone.
- Keyboard-only use, visible focus, semantic labels, and appropriate live regions.
- No fixed-height boxes that clip enlarged text. Panels may grow and scroll.
- Avoid stacked dialogs and auto-dismiss of critical instructions.
- Accessibility mode allows about 1.5–2× line spacing and extra whitespace.
- Respectful, short wording, with an optional longer explanation.

Older-adult specifics:

- Primary navigation icons always have text labels.
- Home, Settings, and Chat stay in the same relative order.
- Confirm in the user's terms: “Your reminder is set for Thursday at 4 PM,” not “API returned 200.”
- Errors name the situation: “The app could not open; it may have been uninstalled.”
- “Repeat that step” and “Show me again” are easy to find.
- Instructions stay on screen while the user is reading.
- The always-on-top mascot must be easy to dismiss.
- Voice is never the only path. Text and keyboard are mandatory.

## Component contracts

- `MascotButton` — state, draggable hit region, keyboard activation, accessible name.
- `MascotQuickMenu` — exactly Home, Settings, and Chat, plus collapse.
- `CompanionPanel` — shell with header, back, and close.
- `HomePanel` — grids, task tiles, add and edit dialogs.
- `SettingsPanel` — visual settings, system links, privacy, and voice.
- `ChatPanel` — history, composer, suggestions, task status.
- `ChatMessage` — plain, status, permission, approval, error, guidance.
- `TaskProgress` — current step, status, Stop.
- `ApprovalCard` — exact preview, Edit, Cancel, Confirm.
- `ScreenAccessBanner` — session indicator and Stop Sharing.
- `GuidanceCallout` — step count, description, Repeat, Next, Can't find.
- `HighlightLayer` — drawing over a validated target only; no click interception.
- `ReminderToast` — due reminder with Done, Snooze, and Open.
