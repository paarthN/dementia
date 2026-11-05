import { useEffect, useState } from 'react'
import type { SessionSnapshot } from '../../shared/session'
import './overlay.css'

export function OverlayApp(): React.JSX.Element | null {
  const [session, setSession] = useState<SessionSnapshot | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.companion.getSession().then(setSession)
    }
    load()
    window.addEventListener('companion:session-changed', load)
    return () => window.removeEventListener('companion:session-changed', load)
  }, [])

  const box = session?.guide?.highlight
  if (!box) {
    return null
  }

  return (
    <div
      className="highlight"
      role="presentation"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    />
  )
}
