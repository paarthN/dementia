import { useCallback, useEffect, useState } from 'react'
import { textScalePixels } from '../../shared/preferences'
import type { PanelView, SessionSnapshot } from '../../shared/session'
import { browserSpeechAvailable, micLabel, micStatus } from '../../shared/voice'
import { ChatPanel } from './ChatPanel'
import { HelpPanel } from './HelpPanel'
import { HomePanel } from './HomePanel'
import { SettingsPanel } from './SettingsPanel'

const titles: Record<PanelView, string> = {
  home: 'Home',
  settings: 'Settings',
  chat: 'Chat',
  help: 'Help'
}

export function PanelApp(): React.JSX.Element {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [chatDraft, setChatDraft] = useState('')
  const [listening, setListening] = useState(false)
  const [recognizerAvailable] = useState(() =>
    browserSpeechAvailable(
      window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
    )
  )
  const onListeningChange = useCallback((next: boolean) => setListening(next), [])

  useEffect(() => {
    const load = (): void => {
      void window.companion.getSession().then(setSession)
    }
    load()
    window.addEventListener('companion:session-changed', load)
    return () => window.removeEventListener('companion:session-changed', load)
  }, [])

  useEffect(() => {
    if (!session) {
      return
    }
    document.documentElement.dataset.theme = session.preferences.appearance.theme
  }, [session])

  if (!session) {
    return <main className="shell">Loading Companion.</main>
  }

  const view = session.panelView
  const microphone = micStatus(
    session.preferences.voice.enabled,
    view === 'chat' && listening,
    recognizerAvailable
  )
  const pixels = textScalePixels[session.preferences.appearance.textScale]
  const fontSize = pixels * session.preferences.appearance.contentScale

  return (
    <main
      className="shell"
      data-spacing={session.preferences.accessibility.extraLineSpacing ? 'loose' : 'regular'}
      style={{ fontSize }}
    >
      <header className="top">
        {view === 'home' ? null : (
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.openPanel('home')}
          >
            Back
          </button>
        )}
        <h1>{titles[view]}</h1>
        <button
          type="button"
          className="icon-button"
          onClick={() => void window.companion.closePanel()}
        >
          Close
        </button>
      </header>
      {notice ? <p className="notice">{notice}</p> : null}
      {session.dueReminders.map((item) => (
        <section key={`${item.reminderId}-${item.kind}`} className="notice" aria-label="Reminder">
          <p>{item.summary}</p>
          <button
            type="button"
            className="primary"
            onClick={() => void window.companion.completeReminder(item.reminderId)}
          >
            Done
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.snoozeReminder(item.reminderId)}
          >
            Snooze 10 minutes
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.openPanel('chat')}
          >
            Open
          </button>
        </section>
      ))}
      {view === 'home' ? (
        <HomePanel
          session={session}
          onNotice={setNotice}
          onCompose={(text) => {
            setChatDraft(text)
            void window.companion.openPanel('chat')
          }}
        />
      ) : null}
      {view === 'settings' ? <SettingsPanel session={session} onNotice={setNotice} /> : null}
      {view === 'chat' ? (
        <ChatPanel
          session={session}
          draft={chatDraft}
          onDraftChange={setChatDraft}
          onListeningChange={onListeningChange}
        />
      ) : null}
      {view === 'help' ? <HelpPanel /> : null}
      <p className="footer">
        {session.screen.captureActive
          ? 'Your screen is being used for this request.'
          : `Screen access: ${session.screen.access === 'on' ? 'On' : 'Off'}.`}{' '}
        {micLabel(microphone)}.
        {session.screen.captureActive ? (
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.stopSharing()}
          >
            Stop sharing
          </button>
        ) : null}
      </p>
    </main>
  )
}
