import { join } from 'path'
import type { BrowserWindow } from 'electron'

export function loadRenderer(
  window: BrowserWindow,
  page: 'mascot.html' | 'panel.html' | 'overlay.html'
): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    const base = devServer.endsWith('/') ? devServer : `${devServer}/`
    void window.loadURL(new URL(page, base).toString())
    return
  }

  void window.loadFile(join(__dirname, '../renderer', page))
}
