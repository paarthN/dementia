import { app, BrowserWindow, globalShortcut } from 'electron'
import { join } from 'path'
import { Desktop } from './desktop'
import { registerIpc } from './ipc/registerIpc'
import { spawnCommand } from './services/launcher'
import { hardenContents, installSessionGuards } from './security/sessionGuards'
import { openDatabase } from './storage/database'

function databasePath(): string {
  return join(app.getPath('userData'), 'companion.sqlite')
}

app.whenReady().then(() => {
  installSessionGuards()

  app.on('web-contents-created', (_event, contents) => {
    hardenContents(contents)
  })

  const desktop = new Desktop(openDatabase(databasePath()), spawnCommand)
  registerIpc(desktop)
  desktop.start()

  app.on('will-quit', () => {
    desktop.stop()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      desktop.showMascot()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
