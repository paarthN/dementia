export interface SecureWebPreferencesOptions {
  preloadPath: string
  devTools: boolean
}

export function devToolsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['ELECTRON_RENDERER_URL'])
}

export function secureWebPreferences(options: SecureWebPreferencesOptions): {
  preload: string
  contextIsolation: true
  nodeIntegration: false
  sandbox: true
  webSecurity: true
  allowRunningInsecureContent: false
  devTools: boolean
  nodeIntegrationInWorker: false
  nodeIntegrationInSubFrames: false
} {
  return {
    preload: options.preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: options.devTools,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false
  }
}
