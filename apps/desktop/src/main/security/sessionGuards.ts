import { session, type WebContents } from 'electron'
import { RENDERER_CONTENT_SECURITY_POLICY } from '../../shared/csp'
import { isAllowedAppUrl } from '../../shared/navigation'
import { appUrlPolicy } from './appUrlPolicy'

export function installSessionGuards(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [RENDERER_CONTENT_SECURITY_POLICY]
      }
    })
  })

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

export function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url, appUrlPolicy())) {
      event.preventDefault()
    }
  })

  contents.on('will-redirect', (event, url) => {
    if (!isAllowedAppUrl(url, appUrlPolicy())) {
      event.preventDefault()
    }
  })

  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
