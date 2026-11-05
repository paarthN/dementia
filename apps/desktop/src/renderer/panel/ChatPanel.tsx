import { useEffect, useRef, useState } from 'react'
import type { SessionSnapshot } from '../../shared/session'

const suggestions = [
  'Open TextEdit',
  'Where is File?',
  'Search for gardening tips',
  'Explain this screen'
]

interface BrowserSpeech {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function transcriptFrom(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  const parts: string[] = []
  for (let index = 0; index < results.length; index += 1) {
    const piece = results[index]?.[0]?.transcript ?? ''
    if (piece.trim()) {
      parts.push(piece.trim())
    }
  }
  return parts.join(' ').trim()
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
  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceNote, setVoiceNote] = useState<string | null>(null)
  const recognizer = useRef<BrowserSpeech | null>(null)
  const wantListen = useRef(false)
  const spoken = useRef('')
  const sendingRef = useRef(false)
  const spokenId = useRef<string | null>(null)
  const latest = session.messages.at(-1)
  const task = session.activeTask

  async function send(text = draft): Promise<void> {
    if (sendingRef.current) {
      return
    }
    sendingRef.current = true
    setSending(true)
    try {
      await window.companion.submitChat({ text, mode: 'execute' })
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
      wantListen.current = false
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

  function beginListening(seed: string): void {
    const Ctor = speechCtor()
    if (!Ctor) {
      setVoiceNote('Speech to text is not available. You can type instead.')
      return
    }
    const next = new Ctor()
    spoken.current = seed.trim()
    let sessionText = ''
    next.lang = session.preferences.voice.language
    next.continuous = true
    next.interimResults = true
    next.onresult = (event) => {
      sessionText = transcriptFrom(event.results)
      const combined = [spoken.current, sessionText].filter(Boolean).join(' ').trim()
      onDraftChange(combined)
    }
    next.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wantListen.current = false
        setListening(false)
        onListeningChange(false)
        setVoiceNote(
          'The microphone is blocked. Allow it in System Settings, then click Listen again.'
        )
      }
    }
    next.onend = () => {
      if (sessionText) {
        spoken.current = [spoken.current, sessionText].filter(Boolean).join(' ').trim()
        sessionText = ''
      }
      if (!wantListen.current) {
        return
      }
      try {
        next.start()
      } catch {
        wantListen.current = false
        setListening(false)
        onListeningChange(false)
      }
    }
    wantListen.current = true
    recognizer.current = next
    try {
      next.start()
    } catch {
      wantListen.current = false
      recognizer.current = null
      setListening(false)
      onListeningChange(false)
      setVoiceNote('The microphone did not start. You can type instead.')
      return
    }
    setListening(true)
    onListeningChange(true)
  }

  function endListening(): void {
    wantListen.current = false
    const current = recognizer.current
    recognizer.current = null
    try {
      current?.stop()
    } catch {
      // Stopping after recognition already ended is normal.
    }
    setListening(false)
    onListeningChange(false)
  }

  async function toggleListening(): Promise<void> {
    if (listening) {
      endListening()
      return
    }
    setVoiceNote(null)
    await window.companion.requestSystemPermissions({})
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) {
        track.stop()
      }
    } catch (error) {
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
      setVoiceNote(
        blocked
          ? 'The microphone is blocked. Allow it in System Settings, then click Listen again.'
          : 'The microphone is not available. You can type instead.'
      )
      if (blocked) {
        await window.companion.requestSystemPermissions({ openSettings: true })
      }
      return
    }
    if (!session.preferences.voice.enabled) {
      await window.companion.setVoice({
        enabled: true,
        readRepliesAloud: session.preferences.voice.readRepliesAloud
      })
    }
    beginListening(draft)
  }

  return (
    <div className="chat">
      {session.screen.captureActive ? (
        <div className="guide-bar">
          <p>Your screen is being used for this request.</p>
          <button
            type="button"
            className="quiet"
            onClick={() => void window.companion.stopSharing()}
          >
            Stop sharing
          </button>
        </div>
      ) : null}
      <div className="feed" aria-live="polite">
        {session.messages.length === 0 ? (
          <p className="lede">
            Ask Companion to open an app, explain this screen, or set a reminder.
          </p>
        ) : null}
        {session.messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <p>{message.text}</p>
            <p className="muted">{message.role === 'user' ? 'You' : 'Companion'}</p>
            {message.recovery?.map((action) => (
              <button
                key={action.actionKey}
                type="button"
                className="quiet"
                onClick={() => void window.companion.recoverChat(action.actionKey)}
              >
                {action.label}
              </button>
            ))}
            <button
              type="button"
              className="quiet"
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
            className="quiet"
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
            className="quiet"
            onClick={() => void window.companion.cancelChat(session.pendingApproval?.taskId ?? '')}
          >
            Cancel
          </button>
        </section>
      ) : null}
      {task && task.state === 'awaiting_permission' ? (
        <section className="bubble" aria-label="Screen access">
          <p>Allow screen access and I will look at the other app.</p>
          <button
            type="button"
            className="primary"
            onClick={() => void window.companion.setScreenAccess(true)}
          >
            Allow screen access
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => void window.companion.cancelChat(task.id)}
          >
            Not now
          </button>
        </section>
      ) : null}
      {session.guide?.status === 'showing' && session.guide.highlight ? (
        <div className="guide-bar">
          <p>{session.guide.instruction}</p>
          {session.guide.targetName ? (
            <button
              type="button"
              className="primary"
              onClick={() => void window.companion.guideAction('press')}
            >
              {`Press ${session.guide.targetName}`}
            </button>
          ) : null}
          <button
            type="button"
            className="quiet"
            onClick={() => void window.companion.guideAction('stop')}
          >
            Stop
          </button>
        </div>
      ) : null}
      {session.notice ? (
        <p className="toast" role="status">
          {session.notice}
        </p>
      ) : null}
      {task && stoppable.has(task.state) ? (
        <button
          type="button"
          className="quiet"
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
            className="quiet"
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
        <textarea
          id="chat-message"
          aria-label="Message"
          value={draft}
          placeholder="Ask Companion"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          rows={3}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="listen"
            aria-pressed={listening}
            onClick={() => void toggleListening()}
          >
            {listening ? 'Stop' : 'Listen'}
          </button>
          <button type="submit" className="primary" disabled={sending}>
            {sending ? 'Sending' : 'Send'}
          </button>
        </div>
      </form>
      {listening || voiceNote ? (
        <p className="status-line" role="status">
          {listening ? 'Listening. Click Stop to end.' : voiceNote}
        </p>
      ) : null}
    </div>
  )
}
