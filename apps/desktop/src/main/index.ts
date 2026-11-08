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

  let crashing = false
  process.on('uncaughtException', (error) => {
    if (crashing) {
      process.exit(1)
    }
    crashing = true
    desktop.recordCrash(error)
    app.quit()
  })

  let quitting = false
  app.on('will-quit', (event) => {
    if (quitting) {
      return
    }
    quitting = true
    event.preventDefault()
    void desktop.stop().finally(() => {
      app.quit()
    })
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
