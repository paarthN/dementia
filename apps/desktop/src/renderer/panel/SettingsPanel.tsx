import { useState } from 'react'
import { mascotColorIds, textScales, themeModes } from '../../shared/preferences'
import type { SessionSnapshot } from '../../shared/session'
import type { SystemSettingsSection } from '../../shared/systemSettings'

const settingButtons: Array<{ section: SystemSettingsSection; label: string }> = [
  { section: 'text', label: 'Mac text size' },
  { section: 'display', label: 'Displays' },
  { section: 'zoom', label: 'Zoom' },
  { section: 'pointer', label: 'Pointer size' },
  { section: 'contrast', label: 'Contrast' },
  { section: 'brightness', label: 'Brightness' }
]

export function SettingsPanel({
  session,
  onNotice
}: {
  session: SessionSnapshot
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const appearance = session.preferences.appearance

  function patch(next: Parameters<typeof window.companion.updateAppearance>[0]): void {
    void window.companion
      .updateAppearance(next)
      .then(() => onNotice('I changed this assistant only. Your Mac is unchanged.'))
  }

  return (
    <div>
      <p className="muted">These controls change Companion. They do not change your Mac.</p>
      {session.shortcutWarning ? <p className="notice">{session.shortcutWarning}</p> : null}
      <h2>Text size</h2>
      <div className="choice-row" role="group" aria-label="Text size">
        {textScales.map((scale) => (
          <button
            key={scale}
            type="button"
            className="icon-button"
            aria-pressed={appearance.textScale === scale}
            onClick={() => patch({ textScale: scale })}
          >
            {scale}
          </button>
        ))}
      </div>
      <h2>Content scale</h2>
      <input
        aria-label="Content scale"
        type="range"
        min={1}
        max={1.6}
        step={0.1}
        value={appearance.contentScale}
        onChange={(event) => patch({ contentScale: Number(event.target.value) })}
      />
      <h2>Theme</h2>
      <div className="choice-row" role="group" aria-label="Theme">
        {themeModes.map((theme) => (
          <button
            key={theme}
            type="button"
            className="icon-button"
            aria-pressed={appearance.theme === theme}
            onClick={() => patch({ theme })}
          >
            {theme === 'system' ? 'Follow system' : theme}
          </button>
        ))}
      </div>
      <h2>Mascot color</h2>
      <div className="choice-row" role="group" aria-label="Mascot color">
        {mascotColorIds.map((color) => (
          <button
            key={color}
            type="button"
            className="icon-button"
            aria-pressed={appearance.mascotColorId === color}
            onClick={() => patch({ mascotColorId: color, accentColorId: color })}
          >
            {color}
          </button>
        ))}
      </div>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={appearance.reduceMotion}
          onChange={(event) => patch({ reduceMotion: event.target.checked })}
        />
        Reduce motion
      </label>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={session.preferences.accessibility.extraLineSpacing}
          onChange={(event) => patch({ extraLineSpacing: event.target.checked })}
        />
        Extra line spacing
      </label>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={session.preferences.startup.launchAtLogin}
          onChange={(event) => void window.companion.setLaunchAtLogin(event.target.checked)}
        />
        Launch at login
      </label>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={session.preferences.startup.showNotifications}
          onChange={(event) => void window.companion.setReminderNotifications(event.target.checked)}
        />
        Notify me when a reminder is due
      </label>
      <p className="muted">
        Reminders stay on this Mac. Companion can notify you only while it is open. If the app was
        quit, missed reminders show the next time it starts.
      </p>
      <p className="muted">
        {session.preferences.privacy.assistantMode === 'cloud'
          ? 'Cloud assistant connected. Demo mode still works on this Mac if you switch back.'
          : 'Demo mode. Requests stay on this Mac.'}
      </p>
      <h2>Voice</h2>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={session.preferences.voice.enabled}
          onChange={(event) =>
            void window.companion.setVoice({
              enabled: event.target.checked,
              readRepliesAloud: session.preferences.voice.readRepliesAloud
            })
          }
        />
        Allow push-to-talk
      </label>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={session.preferences.voice.readRepliesAloud}
          onChange={(event) =>
            void window.companion.setVoice({
              enabled: session.preferences.voice.enabled,
              readRepliesAloud: event.target.checked
            })
          }
        />
        Read replies aloud
      </label>
      <p className="muted">
        Hold the microphone button in Chat to dictate. The words land in the message box so you can
        edit them before sending. Companion does not save the recording. Typed chat keeps working if
        the microphone is off or unavailable.
      </p>
      <h2>Cloud assistant</h2>
      <CloudAssistant session={session} onNotice={onNotice} />
      <h2>Privacy</h2>
      <label className="choice-row">
        <input
          type="checkbox"
          checked={session.preferences.privacy.developerInspection === true}
          onChange={(event) => void window.companion.setDeveloperInspection(event.target.checked)}
        />
        Show screen inspection details
      </label>
      <p className="muted">
        Off by default. This lists names and roles from the last look. It does not save a
        screenshot.
      </p>
      {session.preferences.privacy.developerInspection === true ? (
        <section aria-label="Inspection details">
          {session.inspectionView ? (
            <>
              <p>
                {session.inspectionView.title
                  ? `Window: ${session.inspectionView.title}`
                  : 'No window title was shared.'}
              </p>
              <p>
                {session.inspectionView.appName
                  ? `App: ${session.inspectionView.appName}`
                  : 'App name was not shared.'}
              </p>
              <ul>
                {session.inspectionView.controls.length === 0 ? (
                  <li>No controls were shared.</li>
                ) : (
                  session.inspectionView.controls.map((control, index) => (
                    <li key={`${control.role}-${control.name}-${index}`}>
                      {control.name || 'Unnamed'} ({control.role})
                    </li>
                  ))
                )}
              </ul>
              {session.inspectionView.unknown.map((item) => (
                <p key={item}>Unknown: {item}</p>
              ))}
            </>
          ) : (
            <p>Nothing has been inspected in this session.</p>
          )}
        </section>
      ) : null}
      <h2>Mac settings</h2>
      <p className="muted">Opening one of these leaves the Mac setting for you to change.</p>
      {settingButtons.map((item) => (
        <button
          key={item.section}
          type="button"
          className="tile"
          onClick={() =>
            void window.companion
              .openSystemSettings(item.section)
              .then((result) => onNotice(result.summary))
          }
        >
          {item.label}
        </button>
      ))}
      <button
        type="button"
        className="primary"
        onClick={() =>
          void window.companion
            .resetAppearance()
            .then(() => onNotice('Appearance is back to the default. Favorites are still here.'))
        }
      >
        Reset to default
      </button>
    </div>
  )
}

function CloudAssistant({
  session,
  onNotice
}: {
  session: SessionSnapshot
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const [origin, setOrigin] = useState(session.preferences.privacy.assistantOrigin ?? '')
  const [consent, setConsent] = useState(false)
  const cloud = session.preferences.privacy.assistantMode === 'cloud'

  return (
    <section aria-label="Cloud assistant">
      <p>
        Cloud mode sends the words you type, and a voice transcript after you send it, to the
        assistant server you choose. It does not send a screenshot or a saved recording. That server
        holds the model key. This app does not. Demo mode does not contact that server.
      </p>
      {cloud ? (
        <button
          type="button"
          className="primary"
          onClick={() =>
            void window.companion.setAssistantMode({ mode: 'demo' }).then(() => {
              onNotice('Demo mode is on. Nothing is sent to the assistant server.')
            })
          }
        >
          Use demo mode
        </button>
      ) : (
        <>
          <label>
            Assistant server
            <input
              aria-label="Assistant server"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://assistant.example.com"
            />
          </label>
          <label className="choice-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I understand what is sent
          </label>
          <button
            type="button"
            className="primary"
            disabled={!consent || origin.trim().length === 0}
            onClick={() =>
              void window.companion
                .setAssistantMode({ mode: 'cloud', origin, consent: true })
                .then((next) => {
                  if (next.preferences.privacy.assistantMode === 'cloud') {
                    onNotice('Cloud assistant connected. Demo mode is still available.')
                  } else {
                    onNotice('Use an https address, or http://127.0.0.1 for a server on this Mac.')
                  }
                })
            }
          >
            Turn on cloud assistant
          </button>
        </>
      )}
    </section>
  )
}
