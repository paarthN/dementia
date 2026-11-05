import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MascotApp } from './MascotApp'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MascotApp />
  </StrictMode>
)
