import { contextBridge, ipcRenderer } from 'electron'
import { createCompanionApi } from '../shared/preloadApi'

if (!process.contextIsolated) {
  throw new Error('Companion preload requires context isolation')
}

const companion = createCompanionApi((channel, payload) =>
  ipcRenderer.invoke(channel, payload ?? {})
)

ipcRenderer.on('companion:session-changed', () => {
  window.dispatchEvent(new Event('companion:session-changed'))
})

contextBridge.exposeInMainWorld('companion', companion)
