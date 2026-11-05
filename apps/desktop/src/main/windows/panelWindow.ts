import { BrowserWindow } from 'electron'
import { join } from 'path'
import { loadRenderer } from './loadRenderer'
import { devToolsAllowed, secureWebPreferences } from './secureWebPreferences'

let panelWindow: BrowserWindow | null = null

export function openPanelWindow(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isMinimized()) {
      panelWindow.restore()
    }
    panelWindow.show()
    panelWindow.focus()
    return
  }

  panelWindow = new BrowserWindow({
    width: 520,
    height: 420,
    show: false,
    title: 'Companion',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences({
      preloadPath: join(__dirname, '../preload/index.js'),
      devTools: devToolsAllowed()
    })
  })

  panelWindow.on('ready-to-show', () => {
    panelWindow?.show()
  })

  panelWindow.on('closed', () => {
    panelWindow = null
  })

  loadRenderer(panelWindow, 'panel.html')
}

export function closePanelWindow(): void {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.close()
  }
}
