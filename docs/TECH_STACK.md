# Technology and architecture

Stack, processes, storage, and repository shape. Product behavior is in [FEATURES.md](FEATURES.md). Tool policy is in [AGENT_SYSTEM.md](AGENT_SYSTEM.md). Security rules are in [SECURITY.md](SECURITY.md).

Pin exact library versions at implementation time in lockfiles and record them in `docs/DECISIONS.md`. Do not copy version numbers from an old tutorial.

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Desktop shell | Electron + TypeScript | macOS windows, overlays, menu bar, shortcuts |
| Front-end | React + TypeScript + Vite | Component development |
| Styling | Tailwind CSS plus accessible headless components or Radix | Consistent accessible UI |
| App state | A small store such as Zustand | Panel and task state |
| Validation | Zod | IPC and tool boundaries |
| Local persistence | SQLite through a main-process adapter | Preferences, reminders, activity |
| Native macOS helper | Swift executable | Accessibility, foreground inspection, OS integrations |
| Helper transport | Stdio JSON Lines | Local, no listening port, no XPC |
| AI orchestration | Main-process service, optional secure backend proxy | Tool control and mock mode |
| Remote model | Provider adapter, for example OpenAI Responses API with function tools | Restricted capabilities |
| Unit tests | Vitest and Swift tests | UI, policy, services, helper contracts |
| End-to-end | Playwright Electron or a comparable harness, plus a manual macOS script | Desktop flows and accessibility |
| Distribution | A signed and notarized Mac build; packager chosen in Phase 9 | Install, uninstall, launch at login |

## System diagram

```text
┌──────────────────────────────────────────────────────────────────┐
│                        Electron Desktop App                      │
│                                                                  │
│  Mascot Renderer      Panel Renderer         Guidance Renderer   │
│  (React)              (React)                (React/SVG)         │
│       │                    │                      │              │
│       └────────────────────┴──────────────────────┘              │
│                             │                                    │
│                    Typed Preload IPC API                         │
│                             │                                    │
│                      Electron Main Process                       │
│   ┌──────────────────┬───────────────────┬──────────────────┐     │
│   │ User preferences │ Task orchestrator │ Privacy/policy   │     │
│   │ SQLite/reminders │ Tool registry     │ permissions      │     │
│   └──────────────────┴───────────────────┴──────────────────┘     │
│           │                    │                    │            │
│           ▼                    ▼                    ▼            │
│       OsBridge            Browser/OS tools       AI provider     │
└───────────┼────────────────────────────────────────┼────────────┘
            │                                        │
     JSONL stdio, local                       HTTPS, only when
            │                                user opted in
            ▼                                        ▼
   Swift macOS helper                        Secure backend proxy
   Accessibility,                            → Remote LLM/STT/TTS
   foreground windows,
   System Settings adapters
```

**Dependency direction:** Renderer → Preload API → Main controller → Policy or service → `OsBridge`, provider, or storage. The helper does not call back into rendering logic. Renderers never spawn processes, read the filesystem, call OS input APIs, or call providers with secrets.

## Why a native helper exists

Electron is the right shell for the mascot and panels. It cannot reliably expose the macOS Accessibility API from renderer JavaScript. A small Swift executable handles inspection and approved OS operations. Electron main talks to it through an `OsBridge` interface. The MVP implements that interface on macOS only. A later Windows adapter would implement the same interface and is not part of this build.

Verify Accessibility and ScreenCaptureKit calls against the current Apple docs and the installed SDK. Do not invent symbol names. Prove the choice with a compiling smoke test.

The helper contains no LLM logic. It answers narrow RPC calls from the trusted Electron main process.

## Helper RPC

Line-delimited JSON, versioned:

```json
{"id":"req_001","version":1,"method":"system.getForegroundWindow","params":{}}
{"id":"req_001","version":1,"ok":true,"result":{"title":"TextEdit","windowId":"ephemeral","bundleId":"com.apple.TextEdit"}}
```

Phase-gated methods. Names stay platform-neutral so a Windows adapter can reuse them:

```text
system.ping
system.getDisplays
system.getForegroundWindow
ui.inspectForeground
ui.findElement
ui.readElementState
ui.invokeElement              # allowlist and policy are enforced in Electron main
system.openKnownSettingsPage
system.listKnownApplications
system.launchKnownApplication
```

On macOS, `ui.*` is implemented with `AXUIElement`. `system.launchKnownApplication` uses `NSWorkspace` and a bundle ID. `system.openKnownSettingsPage` opens a verified System Settings URL and falls back to the Accessibility or Displays pane.

Errors include `code`, `message`, and optional `details`. Enforce a maximum request size, timeouts, process supervision, and fail-closed behavior. If the helper crashes, the UI stays up and says native screen guidance is temporarily unavailable.

No unauthenticated TCP or HTTP admin endpoint. No XPC service in the MVP. Stdio only. Only the Electron main process launches and uses the helper.

### Inspection types

```ts
interface ForegroundWindowInfo {
  windowId: string;             // ephemeral, not a persisted handle
  title: string;
  processId: number;
  bundleId?: string;
  processName?: string;
  boundsPx: Rect;
  automationDenied?: boolean | null;
}

interface UiElementDescriptor {
  id: string;                   // ephemeral, tied to a snapshot
  snapshotId: string;
  name: string;
  automationId?: string;
  controlType: string;
  className?: string;
  isEnabled: boolean;
  isOffscreen: boolean;
  boundsPx: Rect | null;
  supportedPatterns: string[];
  parentId?: string;
  children?: UiElementDescriptor[];
}

interface UiInspectionService {
  getForegroundWindow(): Promise<ForegroundWindowInfo | null>;
  inspectForeground(options?: { depth?: number; maxNodes?: number }): Promise<UiSnapshot>;
  findElement(selector: ElementSelector): Promise<UiElementDescriptor | null>;
  getElementState(selector: ElementSelector): Promise<ElementState>;
  invokeElement(selector: ElementSelector): Promise<ActionResult>;
}
```

### Coordinates

Convert Accessibility rectangles into one coordinate space. Keep AppKit points distinct from Electron DIP coordinates. Store the source display ID and scale factor. Prove conversion with a multi-monitor, mixed-scale test. Do not mix CSS pixels with Accessibility coordinates.

## Electron security baseline

- `contextIsolation: true`, `nodeIntegration: false`, sandboxing where supported, a restrictive CSP, and a typed `contextBridge` preload.
- Restrict navigation, new windows, external URLs, and IPC senders.
- Do not expose a generic `ipcRenderer.send`. Expose named functions such as `openPanel`, `runTask`, `savePreferences`, and `requestScreenCapture`.
- Validate renderer IPC arguments in the main process with Zod.
- Do not load arbitrary remote web content in a privileged renderer.
- DevTools off by default in release builds.
- Provider secrets stay out of renderer bundles and out of the shipped desktop binary.
- OAuth tokens go in the macOS Keychain through Electron `safeStorage`, not plain SQLite or logs.

Threat handling is in [SECURITY.md](SECURITY.md).

## Providers

```ts
interface AssistantProvider {
  interpret(request: AssistantInput): Promise<AssistantPlanOrResponse>;
}

class MockAssistantProvider implements AssistantProvider { /* deterministic */ }
class RemoteAssistantProvider implements AssistantProvider { /* backend proxy */ }

interface SpeechToTextProvider {
  isAvailable(): Promise<boolean>;
  start(options: { language: string }): Promise<void>;
  stop(): Promise<{ text: string; confidence?: number }>;
  cancel(): Promise<void>;
}

interface TextToSpeechProvider {
  speak(text: string, options?: { speed?: number; voiceId?: string }): Promise<void>;
  stop(): Promise<void>;
}
```

Ship `MockSpeechToTextProvider` for tests and `NoOpTextToSpeechProvider` for offline demo. Production speech providers are explicit, report availability, and surface errors without blocking typed chat.

**Demo mode** uses deterministic intents and fixture content. No cloud keys.  
**Production mode** goes through a secure backend proxy that holds service secrets, authenticates the app session, rate-limits, and caps request size. Local policy still runs. A backend response cannot bypass it.

Settings shows the active mode, for example “Demo mode” versus “Cloud assistant connected.” Mock results must not be presented as real external actions.

## Storage

SQLite behind repositories, with migrations and a schema version. Store only what is necessary.

```text
app_settings
- key TEXT PRIMARY KEY
- value_json TEXT NOT NULL
- updated_at TEXT NOT NULL

favorites
- id TEXT PRIMARY KEY
- kind TEXT CHECK ('application','website','task')
- title TEXT NOT NULL
- target_json TEXT NOT NULL
- sort_order INTEGER NOT NULL
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL

reminders
- id TEXT PRIMARY KEY
- title TEXT NOT NULL
- notes TEXT NULL
- trigger_at_utc TEXT NOT NULL
- timezone TEXT NOT NULL
- status TEXT NOT NULL
- created_at_utc TEXT NOT NULL
- updated_at_utc TEXT NOT NULL

conversation_sessions
- id TEXT PRIMARY KEY
- created_at_utc TEXT NOT NULL
- updated_at_utc TEXT NOT NULL
- persistence_enabled INTEGER NOT NULL

conversation_messages
- id TEXT PRIMARY KEY
- session_id TEXT NOT NULL
- sender TEXT NOT NULL
- content_json TEXT NOT NULL
- created_at_utc TEXT NOT NULL

activity_events
- id TEXT PRIMARY KEY
- task_id TEXT NULL
- operation TEXT NOT NULL
- result TEXT NOT NULL
- safe_summary TEXT NOT NULL
- created_at_utc TEXT NOT NULL

permissions
- key TEXT PRIMARY KEY
- consent_status TEXT NOT NULL
- granted_at_utc TEXT NULL
- expires_at_utc TEXT NULL
- details_json TEXT NULL
```

Do not store screenshots or raw microphone audio here by default. Do not store OAuth access or refresh tokens in SQLite as plaintext. If chat persistence is off, do not write message content to disk.

### Preferences

```ts
type TextScale = 'comfortable' | 'large' | 'extra-large';
type ThemeMode = 'light' | 'dark' | 'high-contrast' | 'system';
type MascotSize = 'small' | 'medium' | 'large';

interface UserPreferences {
  version: number;
  appearance: {
    textScale: TextScale;
    contentScale: number;   // validated min/max
    theme: ThemeMode;
    accentColorId: string;
    mascotColorId: string;
    mascotSize: MascotSize;
    reduceMotion: boolean;
  };
  accessibility: {
    extraLineSpacing: boolean;
    simpleExplanations: boolean;
  };
  voice: {
    enabled: boolean;
    readRepliesAloud: boolean;
    language: string;
  };
  privacy: {
    saveChatHistory: boolean;
    allowDiagnosticTelemetry: boolean;
    cloudScreenAnalysisEnabled: boolean;
  };
  startup: {
    launchAtLogin: boolean;
    showNotifications: boolean;
  };
  mascot: {
    monitorId: string | null;
    normalizedX: number; // 0..1
    normalizedY: number; // 0..1
    collapsed: boolean;
  };
}
```

### Task record

```ts
type TaskState =
  | 'created'
  | 'planning'
  | 'awaiting_permission'
  | 'awaiting_confirmation'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface AssistantTask {
  id: string;
  goal: string;
  mode: 'execute' | 'guide' | 'explain';
  state: TaskState;
  steps: PlannedStep[];
  currentStepIndex: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  cancellationRequested: boolean;
  safeSummary?: string;
}
```

Persist a short activity summary. Do not persist raw model reasoning or sensitive screen data.

## Repository shape

A monorepo or a simple package workspace. Production code stays separate from mocks. The backend folder can be absent until Phase 7.

```text
companion/
├── README.md
├── package.json
├── package-lock.json or pnpm-lock.yaml
├── tsconfig.base.json
├── .env.example
├── .gitignore
├── docs/                         # this folder
├── apps/desktop/
│   ├── src/main/
│   │   ├── windows/              # mascot, panel, guidance
│   │   ├── ipc/                  # handlers, validation
│   │   ├── services/             # orchestrator, policy, tools, reminders,
│   │   │                         # launcher, browser, inspection, capture,
│   │   │                         # guidance, voice, native bridge client
│   │   ├── storage/              # database, migrations, repositories
│   │   └── providers/            # mock and remote assistant
│   ├── src/preload/
│   ├── src/renderer/             # Mascot, Home, Settings, Chat, Guidance,
│   │                             # Confirmation, shared, hooks, state, themes
│   ├── src/shared/               # contracts, schemas, constants
│   ├── assets/mascot/
│   └── tests/                    # unit, integration, e2e
├── native/CompanionMacHelper/
│   ├── Package.swift
│   ├── Sources/                  # Rpc, Accessibility, SystemIntegration, Security
│   └── Tests/
├── packages/contracts/
└── backend/                      # P1, not required for demo
```

### Main-process services

Each service owns one capability:

`taskOrchestrator`, `policyEngine`, `toolRegistry`, `permissions`, `reminderScheduler`, `appLauncher`, `browserService`, `uiInspection`, `screenCapture`, `guidanceService`, `voiceService`, `osBridge` (macOS implementation now; Windows adapter later).

UI component names are in [UI_UX.md](UI_UX.md).

## Official references

Check current docs while implementing. APIs change.

- [AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement)
- [NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace)
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Change Display settings on Mac](https://support.apple.com/guide/mac-help/change-display-settings-mh26701/mac)
- [Accessibility features on Mac](https://support.apple.com/guide/mac-help/accessibility-features-mh35884/mac)
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

An Accessibility client can identify and operate many controls. Support varies by target app. Open or guide System Settings until a specific direct API is verified on the installed macOS version. Electron capture does not replace Screen Recording consent or the app's own consent step. Local development uses a stable ad-hoc code signature so the Accessibility permission survives rebuilds. Public builds are Developer ID signed and notarized in Phase 9.
