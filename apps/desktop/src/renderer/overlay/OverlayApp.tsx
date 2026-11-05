import { useEffect, useState } from 'react'
import { placeCallout } from '../../shared/highlightGeometry'
import type { SessionSnapshot } from '../../shared/session'
import './overlay.css'

const card = { width: 220, height: 36 }

export function OverlayApp(): React.JSX.Element | null {
  const [session, setSession] = useState<SessionSnapshot | null>(null)
  const [frame, setFrame] = useState({ width: window.innerWidth, height: window.innerHeight })

  useEffect(() => {
    const load = (): void => {
      void window.companion.getSession().then(setSession)
    }
    const resize = (): void => {
      setFrame({ width: window.innerWidth, height: window.innerHeight })
    }
    load()
    resize()
    window.addEventListener('companion:session-changed', load)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('companion:session-changed', load)
      window.removeEventListener('resize', resize)
    }
  }, [])

  const box = session?.guide?.highlight
  const instruction = session?.guide?.status === 'showing' ? session.guide.instruction : ''
  if (!box) {
    return null
  }
  const spot = instruction ? placeCallout(box, frame, card) : null

  return (
    <>
      <div
        className="highlight"
        role="presentation"
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      />
      {spot && instruction ? (
        <p className="callout" style={{ left: spot.x, top: spot.y, width: card.width }}>
          {instruction}
        </p>
      ) : null}
    </>
  )
}
