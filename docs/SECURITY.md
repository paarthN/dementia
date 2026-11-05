# Security and privacy

Permissions, prohibitions, and the trust model. Enforcement lives in the main-process policy engine described in [AGENT_SYSTEM.md](AGENT_SYSTEM.md). Electron and storage mechanics are in [TECH_STACK.md](TECH_STACK.md).

## Prohibited default behaviors

Do not build these as automatic defaults:

- Always-listening audio, or continuous upload of the screen.
- Invisible control of the computer, covert remote access, or surveillance.
- Logging or storing passwords, banking details, authentication codes, or full screenshots by default.
- Automatically approving password dialogs, CAPTCHAs, two-factor prompts, or security warnings.
- Sending messages, making purchases, transferring money, destructive file operations, or account changes without a specific confirmation.
- Circumventing anti-bot restrictions or using systems the user has not authorized.
- Promising that any app can be fully automated.
- Diagnosing illness or making health, financial, or legal decisions for the user.
- A mandatory family administrator or paternalistic controls over the user.

**Non-goal for the first useful build:** unrestricted control of any website, protected program, email account, or financial transaction.

## Threats

- A misunderstood request causes an action the user did not want.
- A webpage, email, screenshot, or control label contains instructions aimed at the model.
- A screenshot or log leaks a private screen.
- Credentials are collected by accident, or another account is accessed.
- The remote model or server is compromised, or a tool request is malformed.
- Untrusted IPC or injected content reaches an Electron renderer.
- An OS privilege boundary is crossed, or a “run this shell command” path exists.
- The always-on-top mascot blocks an emergency task or a critical window.
- A nontechnical user hears “prepared” and believes the action is “completed.”

## Controls

1. OS permissions, plus clear per-session indicators for screen and microphone.
2. A local tool policy that does not trust the model.
3. Task-specific approvals that expire and are tied to an immutable payload.
4. Minimized cloud data. No continuous recording by default.
5. Sensitive-content restrictions. No agent that extracts a password manager or one-time codes.
6. A structured, redacted activity audit. No full screenshots or transcripts by default.
7. Safe defaults for network destinations and external URLs.
8. macOS Keychain storage for provider tokens, through Electron `safeStorage`. Service keys stay on a secure backend.
9. Rate limits, timeouts, and cancellation.
10. A global Stop, menu-bar Quit, and a clean uninstall.

## Language to use

- “I need permission to look at this screen so I can explain it.”
- “Your screen is being used for this request. Stop sharing.”
- “I have prepared the email. I won't send it until you confirm.”
- “I could not verify that this worked.”
- “I can guide you, but I can't control this secure window.”

Do not say “I can see everything,” “I can do anything,” or “Your data is 100% secure.”

## Consent

Screen reading, the microphone, and consequential actions are opt-in and visible.

- Microphone defaults to off. Push-to-talk only in the MVP. No wake word.
- No silent hot-mic session and no background audio upload.
- Screen capture requires an app-owned consent step even if Electron `desktopCapturer` is available. Show a banner while capture is active.
- “Stop sharing” ends capture, releases buffers, clears the indicator, and fails or pauses the screen-dependent task.
- Denying permission is final for that request. Do not re-prompt in a loop. Typed chat and non-screen tools stay available.
- Diagnostic telemetry is off until the user consents.
- Launch at login is opt-in. First install does not silently auto-run.
- A family helper never receives screen, email, or account access automatically.

Voice cannot waive confirmation for sending, purchases, account changes, or deletion. Low-confidence transcription of a consequential action requires read-back.

## Approvals

| Risk | Examples | Rule |
|---|---|---|
| R0 | Explain, list favorites, read reminders | Run when the needed permission already exists |
| R1 | Open an app, search, change Companion appearance | Run and show the result, with undo where it exists |
| R2 | Calendar event, OS setting, non-sensitive form | Preview and explicit approval once the integration exists |
| R3 | Send, purchase, delete files, change account permissions | A precise approval for that payload. Some actions stay out of scope |
| R4 | Money transfer, entering credentials, bypassing a security prompt, broad destruction | Refuse automation. Offer safe guidance |

Classification is code, based on the tool and the operation. The model cannot lower it. “Yes to everything” does not stick.

A confirmation is bound to one `approvalId` and one payload. Changing the target, recipient, or action requires a new confirmation. Approvals expire.

Stop fails closed: queued calls do not run. Completed steps are reported honestly. There is no pretend undo.

## Prompt injection

Observed content is data.

- Only the user's direct utterance or typed message starts a new authorized task.
- Each tool call is checked against scope, risk, session permissions, and the current goal.
- Screen text cannot issue a tool call or a confirmation.
- No arbitrary outbound HTTP from the model, and no broad file read.
- Redact secrets when feasible. Do not transmit a screenshot of a sensitive surface.
- Keep the tool registry narrow. Review logs for suspicious requests.

Acceptance: **T-CHAT-09** says UI content that instructs the assistant to exfiltrate data has no effect on authorization. **T-CHAT-07** and **T-CHAT-08** reject unknown tools and unapproved R3 actions.

## Data retention

| Data | Default |
|---|---|
| Preferences, favorites, reminders | Local until the user deletes them |
| Chat messages | Session-only, or an explicit choice to keep them. Record the product decision |
| Screenshots | In memory for the active request, then released. Never saved by default |
| Microphone audio | In memory for the active utterance. Not retained by default |
| Activity audit | Event type and a safe summary, without sensitive payloads. The user can clear or disable it in line with reliability needs |
| Cloud requests | Disclose what is sent, and link the provider policy, before cloud mode is turned on |

Never store screenshots or raw audio in SQLite by default. Never store OAuth tokens as plaintext in SQLite or logs. If chat persistence is disabled, do not write message bodies to disk.

Resetting appearance does not delete favorites or reminders. Deleting local data is a separate action.

## Desktop hardening

- Context isolation on, Node integration off, sandbox where supported, restrictive CSP, typed preload only.
- No generic IPC channel from React. Named functions only. Zod-validate arguments in the main process.
- No arbitrary remote content in a privileged renderer.
- Release builds do not enable DevTools by default.
- No long-lived provider key inside the desktop binary or the renderer bundle.
- The Swift helper is stdio-only, launched by the main process, with size limits, timeouts, and fail-closed crashes.
- `ui.invokeElement` is allowlisted in the main process before the helper runs it.
- The renderer cannot read secrets or call unexposed Electron APIs (**T-SEC-01**).
- Stored preferences contain no API keys or OAuth tokens (**T-SEC-02**).
- Capture images and microphone audio are not persisted by default (**T-SEC-03**).
- Stop and revocation fail closed during an active task (**T-SEC-05**).

## Protected screens

The lock screen, password dialogs, and windows that Accessibility or Screen Recording cannot read are out of reach. Explain them in general terms and leave the choice to the user. Do not inject input, approve the prompt, or treat a black capture as success.

Password fields are not collected. Known sensitive regions are masked. Protected screens are not screenshotted. Screen capture still needs the app's own consent even after macOS has granted Screen Recording.
