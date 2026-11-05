import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDERER_CONTENT_SECURITY_POLICY } from '../src/shared/csp'
import { isAllowedAppUrl } from '../src/shared/navigation'
import { createCompanionApi } from '../src/shared/preloadApi'
import { devToolsAllowed, secureWebPreferences } from '../src/main/windows/secureWebPreferences'

describe('renderer security baseline', () => {
  it('exposes only named preload functions', async () => {
    const calls: string[] = []
    const api = createCompanionApi(async (channel) => {
      calls.push(channel)
      return undefined
    })

    await api.getCapabilities()
    await api.openPanel()
    await api.closePanel()

    expect(Object.keys(api)).not.toContain('send')
    expect(Object.keys(api)).not.toContain('invoke')
    expect(Object.keys(api)).toContain('getCapabilities')
    expect(Object.keys(api)).toContain('openPanel')
    expect(Object.keys(api)).toContain('closePanel')
    expect(api).not.toHaveProperty('send')
    expect(api).not.toHaveProperty('invoke')
    expect(calls).toEqual(['capabilities:get', 'panel:open', 'panel:close'])
  })

  it('does not publish ipcRenderer from the preload', () => {
    const source = readFileSync(resolve('src/preload/index.ts'), 'utf8')
    expect(source).toContain("exposeInMainWorld('companion'")
    expect(source).not.toContain('ipcRenderer.send')
    expect(source).not.toContain("exposeInMainWorld('electron'")
    expect(source).not.toContain('exposeInMainWorld("electron"')
  })

  it('locks BrowserWindow preferences and keeps DevTools off outside unpackaged dev', () => {
    const preferences = secureWebPreferences({
      preloadPath: '/app/preload/index.js',
      devTools: devToolsAllowed({})
    })

    expect(preferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false
    })
    expect(devToolsAllowed({ ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(true)
  })

  it('uses a restrictive content security policy and local navigation only', () => {
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain('*')
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain('http')
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
    expect(RENDERER_CONTENT_SECURITY_POLICY).toContain("script-src 'self'")

    const policy = {
      devOrigin: 'http://localhost:5173',
      rendererDirectory: '/Users/me/companion/out/renderer'
    }

    expect(isAllowedAppUrl('http://localhost:5173/placeholder.html', policy)).toBe(true)
    expect(isAllowedAppUrl('file:///Users/me/companion/out/renderer/panel.html', policy)).toBe(true)
    expect(isAllowedAppUrl('https://example.com', policy)).toBe(false)
    expect(isAllowedAppUrl('file:///etc/passwd', policy)).toBe(false)
  })
})
