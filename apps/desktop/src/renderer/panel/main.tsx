import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PanelApp } from './PanelApp'
import './panel.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>
)
