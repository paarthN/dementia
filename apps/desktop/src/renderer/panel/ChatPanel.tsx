import { useEffect, useRef, useState } from 'react'
import type { SessionSnapshot } from '../../shared/session'
import { browserSpeechAvailable, micLabel, micStatus } from '../../shared/voice'

const suggestions = [
  'Open TextEdit',
  'Search for gardening tips',
  'Make your text bigger',
  'Explain this screen'
]

interface BrowserSpeech {
  lang: string
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function speechHost(): Window & {
  SpeechRecognition?: new () => BrowserSpeech
  webkitSpeechRecognition?: new () => BrowserSpeech
} {
  return window as Window & {
    SpeechRecognition?: new () => BrowserSpeech
    webkitSpeechRecognition?: new () => BrowserSpeech
  }
}

function speechCtor(): (new () => BrowserSpeech) | null {
  const host = speechHost()
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null
}

const stoppable = new Set([
  'created',
  'planning',
  'awaiting_permission',
  'awaiting_confirmation',
  'executing',
  'verifying'
])

export function ChatPanel({
  session,
  draft,
  onDraftChange,
  onListeningChange
}: {
  session: SessionSnapshot
  draft: string
  onDraftChange: (value: string) => void
  onListeningChange: (listening: boolean) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'execute' | 'guide'>('execute')
  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [recognizerAvailable] = useState(() => browserSpeechAvailable(speechHost()))
  const recognizer = useRef<BrowserSpeech | null>(null)
  const sendingRef = useRef(false)
  const spokenId = useRef<string | null>(null)
  const latest = session.messages.at(-1)
  const task = session.activeTask
  const microphone = micStatus(session.preferences.voice.enabled, listening, recognizerAvailable)

  async function send(text = draft): Promise<void> {
    if (sendingRef.current) {
      return
    }
    sendingRef.current = true
    setSending(true)
    try {
      await window.companion.submitChat({ text, mode })
      if (text.trim()) {
        onDraftChange('')
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  useEffect(() => {
    return () => {
      try {
        recognizer.current?.stop()
      } catch {
        // The recognizer may already have stopped.
      }
      recognizer.current = null
      onListeningChange(false)
    }
  }, [onListeningChange])

  useEffect(() => {
    if (!session.preferences.voice.readRepliesAloud || latest?.role !== 'assistant') {
      return
    }
    if (spokenId.current === latest.id || !window.speechSynthesis) {
      return
    }
    spokenId.current = latest.id
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(latest.text))
  }, [latest, session.preferences.voice.readRepliesAloud])

  function beginListening(): void {
    if (!session.preferences.voice.enabled || listening) {
      return
    }
    const Ctor = speechCtor()
    if (!Ctor) {
      return
    }
    const next = new Ctor()
    next.lang = session.preferences.voice.language
    next.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? ''
      if (transcript.trim()) {
        onDraftChange(transcript)
      }
    }
    next.onerror = () => {
      setListening(false)
      onListeningChange(false)
    }
    try {
      next.start()
    } catch {
      setListening(false)
      onListeningChange(false)
      return
    }
    recognizer.current = next
    setListening(true)
    onListeningChange(true)
  }

  function endListening(): void {
    const current = recognizer.current
    recognizer.current = null
    try {
      current?.stop()
    } catch {
      // Releasing the button after recognition already ended is normal.
    }
    setListening(false)
    onListeningChange(false)
  }

  return (
    <div className="chat">
      <div className="mode-row" role="group" aria-label="How Companion should help">
        <button
          type="button"
          className="icon-button"
          aria-pressed={mode === 'execute'}
          onClick={() => setMode('execute')}
        >
          Do it for me
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={mode === 'guide'}
          onClick={() => setMode('guide')}
        >
          Show me how
        </button>
      </div>
      <p className="muted">
        {session.screen.captureActive
          ? 'Your screen is being used for this request.'
          : `Screen access: ${session.screen.access === 'on' ? 'On' : 'Off'}. ${micLabel(microphone)}.`}
      </p>
      {session.screen.captureActive ? (
        <button
          type="button"
          className="icon-button"
          onClick={() => void window.companion.stopSharing()}
        >
          Stop sharing
        </button>
      ) : null}
      <div className="feed" aria-live="polite">
        {session.messages.length === 0 ? (
          <p>Ask me to open an app, search the web, or make this text bigger.</p>
        ) : null}
        {session.messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <p>{message.text}</p>
            <p className="muted">{message.role === 'user' ? 'You' : 'Companion'}</p>
            {message.recovery?.map((action) => (
              <button
                key={action.actionKey}
                type="button"
                className="icon-button"
                onClick={() => void window.companion.recoverChat(action.actionKey)}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="icon-button"
              onClick={() =>
                void navigator.clipboard.writeText(message.text).catch(() => undefined)
              }
            >
              Copy
            </button>
          </article>
        ))}
      </div>
      {session.pendingApproval ? (
        <section className="bubble" aria-label="Approval">
          <p>{session.pendingApproval.summary}</p>
          <button
            type="button"
            className="primary"
            onClick={() =>
              void window.companion.confirmChat(
                session.pendingApproval?.taskId ?? '',
                session.pendingApproval?.approvalId ?? ''
              )
            }
          >
            {session.pendingApproval.confirmLabel}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              const previous = [...session.messages]
                .reverse()
                .find((message) => message.role === 'user')
              if (previous) {
                onDraftChange(previous.text)
              }
              void window.companion.cancelChat(session.pendingApproval?.taskId ?? '')
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.cancelChat(session.pendingApproval?.taskId ?? '')}
          >
            Cancel
          </button>
        </section>
      ) : null}
      {task && task.state === 'awaiting_permission' ? (
        <section className="bubble" aria-label="Screen access">
          <p>I need permission to look at this screen so I can explain it.</p>
          <button
            type="button"
            className="primary"
            onClick={() => void window.companion.setScreenAccess(true)}
          >
            Allow screen access
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.cancelChat(task.id)}
          >
            Not now
          </button>
        </section>
      ) : null}
      {session.guide && session.guide.status !== 'stopped' ? (
        <section className="bubble" aria-label="Guide">
          <p>{session.guide.stepLabel}</p>
          <p>{session.guide.instruction}</p>
          <button
            type="button"
            className="primary"
            onClick={() => void window.companion.guideAction('did_it')}
          >
            I did it
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.guideAction('repeat')}
          >
            Repeat
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.guideAction('cant_find')}
          >
            {"Can't find it"}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.guideAction('manual')}
          >
            Switch to manual
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void window.companion.guideAction('stop')}
          >
            Stop
          </button>
        </section>
      ) : null}
      {task && stoppable.has(task.state) ? (
        <button
          type="button"
          className="icon-button"
          onClick={() => void window.companion.cancelChat(task.id)}
        >
          Stop
        </button>
      ) : null}
      <div className="suggestion-row">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="icon-button"
            disabled={sending}
            onClick={() => void send(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <label htmlFor="chat-message">Message</label>
        <textarea
          id="chat-message"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          rows={3}
        />
        <button type="submit" className="primary" disabled={sending}>
          {sending ? 'Sending' : 'Send'}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={listening}
          disabled={!session.preferences.voice.enabled}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            beginListening()
          }}
          onPointerUp={() => endListening()}
          onPointerCancel={() => endListening()}
          onKeyDown={(event) => {
            if (event.key === ' ' && !event.repeat) {
              event.preventDefault()
              beginListening()
            }
          }}
          onKeyUp={(event) => {
            if (event.key === ' ') {
              event.preventDefault()
              endListening()
            }
          }}
        >
          {listening ? 'Listening now' : 'Hold to talk'}
        </button>
      </form>
      <p className="muted" role="status">
        {latest ? latest.text : 'Ready'}
      </p>
    </div>
  )
}
