import { useEffect, useRef, useState } from 'react'
import type { MascotColorId, UserPreferences } from '../../shared/preferences'
import type { PanelView } from '../../shared/session'
import './mascot.css'

const fills: Record<MascotColorId, string> = {
  teal: '#2a6b66',
  blue: '#2c5278',
  purple: '#5a4d86',
  coral: '#a85a48',
  neutral: '#4e555b'
}

const announcements = {
  idle: 'Assistant ready',
  hovered: 'Open assistant options',
  menuOpen: 'Home, Settings, and Chat',
  collapsed: 'Expand assistant'
} as const

type MascotMood = keyof typeof announcements

export function MascotApp(): React.JSX.Element {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null)
  const [mood, setMood] = useState<MascotMood>('idle')
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const dragging = useRef(false)
  const hoverTimer = useRef<number | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.companion.getSession().then((session) => {
        setPreferences(session.preferences)
        if (session.preferences.mascot.collapsed) {
          setMood('collapsed')
        }
      })
    }
    load()
    window.addEventListener('companion:session-changed', load)
    return () => window.removeEventListener('companion:session-changed', load)
  }, [])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (dragging.current) {
        return
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)
      void window.companion.setMascotInteractive(Boolean(target?.closest('[data-hit]')))
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMood(preferences?.mascot.collapsed ? 'collapsed' : 'idle')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preferences?.mascot.collapsed])

  if (!preferences) {
    return <main className="mascot-shell" />
  }

  const color = fills[preferences.appearance.mascotColorId]
  const size =
    preferences.appearance.mascotSize === 'small'
      ? 72
      : preferences.appearance.mascotSize === 'large'
        ? 120
        : 96
  const reduceMotion = preferences.appearance.reduceMotion

  const openView = (view: PanelView): void => {
    setMood('idle')
    void window.companion.openPanel(view)
  }

  const clearHoverTimer = (): void => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const toggleMenu = (): void => {
    clearHoverTimer()
    setMood((current) => (current === 'menuOpen' ? 'idle' : 'menuOpen'))
  }

  return (
    <main className={reduceMotion ? 'mascot-shell reduce-motion' : 'mascot-shell'}>
      <p className="live" aria-live="polite">
        {announcements[mood]}
      </p>
      {preferences.mascot.collapsed ? (
        <button
          type="button"
          className="tab"
          data-hit="true"
          aria-label="Expand assistant"
          onClick={() =>
            void window.companion.setMascotCollapsed(false).then(() => setMood('idle'))
          }
        >
          Companion
        </button>
      ) : (
        <>
          {mood === 'menuOpen' ? (
            <nav className="menu" aria-label="Assistant options">
              <button type="button" data-hit="true" onClick={() => openView('home')}>
                Home
              </button>
              <button type="button" data-hit="true" onClick={() => openView('settings')}>
                Settings
              </button>
              <button type="button" data-hit="true" onClick={() => openView('chat')}>
                Chat
              </button>
            </nav>
          ) : null}
          <button
            type="button"
            className={`character ${mood === 'menuOpen' ? 'menuOpen' : mood}`}
            data-hit="true"
            aria-label={announcements[mood === 'menuOpen' ? 'menuOpen' : mood]}
            onPointerEnter={() => {
              clearHoverTimer()
              hoverTimer.current = window.setTimeout(() => setMood('menuOpen'), 420)
              setMood((current) => (current === 'menuOpen' ? current : 'hovered'))
            }}
            onPointerLeave={() => {
              clearHoverTimer()
              setMood((current) => (current === 'menuOpen' ? current : 'idle'))
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return
              }
              clearHoverTimer()
              dragging.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              void window.companion.setMascotInteractive(true)
              drag.current = { x: event.screenX, y: event.screenY, moved: false }
            }}
            onPointerMove={(event) => {
              if (!drag.current) {
                return
              }
              const dx = event.screenX - drag.current.x
              const dy = event.screenY - drag.current.y
              if (Math.abs(dx) + Math.abs(dy) < 4) {
                return
              }
              drag.current = { x: event.screenX, y: event.screenY, moved: true }
              void window.companion.nudgeMascot(dx, dy)
            }}
            onPointerUp={(event) => {
              dragging.current = false
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              const moved = drag.current?.moved ?? false
              drag.current = null
              const target = document.elementFromPoint(event.clientX, event.clientY)
              void window.companion.setMascotInteractive(Boolean(target?.closest('[data-hit]')))
              if (!moved) {
                toggleMenu()
              }
            }}
            onPointerCancel={() => {
              dragging.current = false
              drag.current = null
              void window.companion.setMascotInteractive(false)
            }}
          >
            <MascotFace color={color} size={size} />
          </button>
        </>
      )}
    </main>
  )
}

function MascotFace({ color, size }: { color: string; size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <rect x="8" y="10" width="80" height="76" rx="28" fill={color} />
      <g className="eyes" fill="#f6f1e6">
        <circle cx="36" cy="42" r="7" />
        <circle cx="60" cy="42" r="7" />
      </g>
      <rect x="34" y="58" width="28" height="6" rx="3" fill="#f6f1e6" />
    </svg>
  )
}
