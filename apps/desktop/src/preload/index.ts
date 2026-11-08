import { contextBridge, ipcRenderer } from 'electron'
import type { AgentStatus } from '../shared/agentStatus'
import { createCompanionApi } from '../shared/preloadApi'

function pushedAgentStatus(payload: unknown): AgentStatus | null | undefined {
  if (payload == null) {
    return null
  }
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    return undefined
  }
  if (text.includes('data:image') || text.includes('base64,')) {
    return undefined
  }
  if (typeof payload !== 'object') {
    return undefined
  }
  return payload as AgentStatus
}

if (!process.contextIsolated) {
  throw new Error('Companion preload requires context isolation')
}

const companion = createCompanionApi(
  (channel, payload) => ipcRenderer.invoke(channel, payload ?? {}),
  (listener) => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      const accepted = pushedAgentStatus(detail)
      listener(accepted === undefined ? null : accepted)
    }
    window.addEventListener('companion:agent-status', handler)
    return () => window.removeEventListener('companion:agent-status', handler)
  }
)

ipcRenderer.on('companion:session-changed', () => {
  window.dispatchEvent(new Event('companion:session-changed'))
})

ipcRenderer.on('companion:agent-status', (_event, payload: unknown) => {
  const accepted = pushedAgentStatus(payload)
  if (accepted === undefined) {
    return
  }
  window.dispatchEvent(new CustomEvent('companion:agent-status', { detail: accepted }))
})

contextBridge.exposeInMainWorld('companion', companion)
