import { useCallback, useEffect, useState } from 'react'
import { textScalePixels } from '../../shared/preferences'
import type { PanelView, SessionSnapshot } from '../../shared/session'
import { browserSpeechAvailable, micLabel, micStatus } from '../../shared/voice'
import { Separator } from '@radix-ui/react-separator'
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

const nav: Array<{ view: PanelView; label: string }> = [
  { view: 'chat', label: 'Chat' },
  { view: 'home', label: 'Home' },
  { view: 'settings', label: 'Settings' },
  { view: 'help', label: 'Help' }
]

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
    return <main className="app loading">Opening Companion.</main>
  }

  const view = session.panelView
  const microphone = micStatus(
    session.preferences.voice.enabled,
    view === 'chat' && listening,
    recognizerAvailable
  )
  const pixels = textScalePixels[session.preferences.appearance.textScale]
  const fontSize = pixels * session.preferences.appearance.contentScale
  const screenLabel = session.screen.captureActive
    ? 'Looking at your screen'
    : session.screen.access === 'on'
      ? 'Screen access on'
      : 'Screen access off'

  return (
    <main
      className="app"
      data-spacing={session.preferences.accessibility.extraLineSpacing ? 'loose' : 'regular'}
      data-motion={session.preferences.appearance.reduceMotion ? 'reduce' : 'full'}
      style={{ fontSize }}
    >
      <a className="skip" href="#workspace">
        Skip to content
      </a>
      <aside className="sidebar">
        <p className="brand" translate="no">
          Companion
        </p>
        <nav className="nav" aria-label="Sections">
          {nav.map((item) => (
            <button
              key={item.view}
              type="button"
              aria-current={view === item.view ? 'page' : undefined}
              onClick={() => void window.companion.openPanel(item.view)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <Separator className="sidebar-rule" orientation="horizontal" decorative />
        <footer className="sidebar-foot">
          <p>{screenLabel}</p>
          <p>{micLabel(microphone)}</p>
          {session.screen.access === 'on' ? (
            <button
              type="button"
              className="quiet"
              onClick={() => void window.companion.stopSharing()}
            >
              Stop sharing
            </button>
          ) : (
            <button
              type="button"
              className="quiet"
              onClick={() =>
                void window.companion.requestSystemPermissions({
                  openSettings: true,
                  resumeScreen: true
                })
              }
            >
              Allow screen
            </button>
          )}
        </footer>
      </aside>
      <section className="workspace">
        <header className="workspace-head">
          <h1 id="workspace" tabIndex={-1}>
            {titles[view]}
          </h1>
        </header>
        <div className={view === 'chat' ? 'workspace-body is-chat' : 'workspace-body'}>
          {notice || session.dueReminders.length > 0 ? (
            <div className="banners">
              {notice ? <p className="notice">{notice}</p> : null}
              {session.dueReminders.map((item) => (
                <section
                  key={`${item.reminderId}-${item.kind}`}
                  className="notice"
                  aria-label="Reminder"
                >
                  <p>{item.summary}</p>
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void window.companion.completeReminder(item.reminderId)}
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => void window.companion.snoozeReminder(item.reminderId)}
                    >
                      Snooze 10 minutes
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => void window.companion.openPanel('chat')}
                    >
                      Open
                    </button>
                  </div>
                </section>
              ))}
            </div>
          ) : null}
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
        </div>
      </section>
    </main>
  )
}
