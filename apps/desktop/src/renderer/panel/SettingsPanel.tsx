import { useState } from 'react'
import { mascotColorIds, textScales, themeModes } from '../../shared/preferences'
import type { SessionSnapshot } from '../../shared/session'
import type { SystemSettingsSection } from '../../shared/systemSettings'
import { ScaleControl, SegmentedChoice, SwitchRow } from './controls'

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
    <div className="page">
      <p className="lede">These controls change Companion. They do not change your Mac.</p>
      {session.shortcutWarning ? <p className="notice">{session.shortcutWarning}</p> : null}
      <section className="block">
        <h2>Reading</h2>
        <SegmentedChoice
          label="Text size"
          value={appearance.textScale}
          options={textScales.map((scale) => ({ value: scale, label: scale }))}
          onChange={(textScale) => patch({ textScale })}
        />
        <ScaleControl
          value={appearance.contentScale}
          onChange={(contentScale) => patch({ contentScale })}
        />
        <SwitchRow
          label="Extra line spacing"
          checked={session.preferences.accessibility.extraLineSpacing}
          onCheckedChange={(extraLineSpacing) => patch({ extraLineSpacing })}
        />
      </section>
      <section className="block">
        <h2>Appearance</h2>
        <SegmentedChoice
          label="Theme"
          value={appearance.theme}
          options={themeModes.map((theme) => ({
            value: theme,
            label: theme === 'system' ? 'Follow system' : theme
          }))}
          onChange={(theme) => patch({ theme })}
        />
        <SegmentedChoice
          label="Mascot color"
          value={appearance.mascotColorId}
          options={mascotColorIds.map((color) => ({ value: color, label: color }))}
          onChange={(color) => patch({ mascotColorId: color, accentColorId: color })}
        />
        <SwitchRow
          label="Reduce motion"
          checked={appearance.reduceMotion}
          onCheckedChange={(reduceMotion) => patch({ reduceMotion })}
        />
      </section>
      <section className="block">
        <h2>Startup</h2>
        <div className="toggle-list">
          <SwitchRow
            label="Launch at login"
            checked={session.preferences.startup.launchAtLogin}
            onCheckedChange={(enabled) => void window.companion.setLaunchAtLogin(enabled)}
          />
          <SwitchRow
            label="Notify me when a reminder is due"
            checked={session.preferences.startup.showNotifications}
            onCheckedChange={(enabled) => void window.companion.setReminderNotifications(enabled)}
          />
        </div>
        <p className="muted">
          Reminders stay on this Mac. Companion can notify you only while it is open. If the app was
          quit, missed reminders show the next time it starts.
        </p>
        <p className="muted">
          {session.preferences.privacy.assistantMode === 'cloud'
            ? 'Cloud assistant connected. Demo mode still works on this Mac if you switch back.'
            : 'Demo mode. Requests stay on this Mac.'}
        </p>
      </section>
      <section className="block">
        <h2>Voice</h2>
        <div className="toggle-list">
          <SwitchRow
            label="Use the microphone"
            checked={session.preferences.voice.enabled}
            onCheckedChange={(enabled) =>
              void window.companion.setVoice({
                enabled,
                readRepliesAloud: session.preferences.voice.readRepliesAloud
              })
            }
          />
          <SwitchRow
            label="Read replies aloud"
            checked={session.preferences.voice.readRepliesAloud}
            onCheckedChange={(readRepliesAloud) =>
              void window.companion.setVoice({
                enabled: session.preferences.voice.enabled,
                readRepliesAloud
              })
            }
          />
        </div>
        <p className="muted">
          Click Listen in Chat to start the microphone, then click Stop. The words land in the
          message box so you can edit them before sending. Companion does not save the recording.
          You can type if the microphone is off or unavailable.
        </p>
      </section>
      <section className="block">
        <h2>Cloud assistant</h2>
        <CloudAssistant session={session} onNotice={onNotice} />
      </section>
      <section className="block">
        <h2>Privacy</h2>
        <SwitchRow
          label="Show screen inspection details"
          checked={session.preferences.privacy.developerInspection === true}
          onCheckedChange={(enabled) => void window.companion.setDeveloperInspection(enabled)}
        />
        <p className="muted">
          Off by default. This lists names and roles from the last look. It does not save a
          screenshot.
        </p>
        {session.preferences.privacy.developerInspection === true ? (
          <div className="group" aria-label="Inspection details">
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
          </div>
        ) : null}
      </section>
      <section className="block">
        <h2>Mac settings</h2>
        <p className="muted">Opening one of these leaves the Mac setting for you to change.</p>
        <div className="grid">
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
        </div>
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
      </section>
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
    <div className="group" aria-label="Cloud assistant">
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
          <label className="field">
            Assistant server
            <input
              name="assistant-server"
              aria-label="Assistant server"
              autoComplete="off"
              spellCheck={false}
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://assistant.example.com"
            />
          </label>
          <label className="check">
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
    </div>
  )
}
