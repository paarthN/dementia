import { existsSync } from 'node:fs'
import { join } from 'node:path'

const devOnlyMarkers = ['/opt/homebrew/', '/usr/local/Cellar/', '/peekaboo']

export function isDevOnlyRuntimePath(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/')
  return devOnlyMarkers.some((marker) => normalized.includes(marker))
}

export function bundledHelperPath(resourcesPath: string): string {
  return join(resourcesPath, 'helper', 'CompanionMacHelper')
}

export function bundledBrowserExecutable(resourcesPath: string): string {
  return join(
    resourcesPath,
    'agent-browser',
    'Chromium.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing'
  )
}

export function resolveBundledBrowser(resourcesPath: string | undefined): string | null {
  if (!resourcesPath) {
    return null
  }
  const candidate = bundledBrowserExecutable(resourcesPath)
  if (!existsSync(candidate) || isDevOnlyRuntimePath(candidate)) {
    return null
  }
  return candidate
}

export function helperBinaryCandidates(start = process.cwd()): string[] {
  return [
    join(start, 'native/CompanionMacHelper/.build/release/CompanionMacHelper'),
    join(start, '../../native/CompanionMacHelper/.build/release/CompanionMacHelper'),
    join(start, '../../../../native/CompanionMacHelper/.build/release/CompanionMacHelper')
  ]
}

export interface RuntimeLayout {
  packaged?: boolean
  resourcesPath?: string
}

export function resolveHelperCommand(
  env: NodeJS.ProcessEnv = process.env,
  start = process.cwd(),
  layout: RuntimeLayout = {}
): { command: string; args: string[] } | null {
  if (layout.packaged) {
    if (!layout.resourcesPath) {
      return null
    }
    return resolveBundledHelper(layout.resourcesPath)
  }
  const override = env['COMPANION_HELPER_PATH']
  if (override && existsSync(override) && !isDevOnlyRuntimePath(override)) {
    return { command: override, args: [] }
  }
  const found = helperBinaryCandidates(start).find(
    (candidate) => existsSync(candidate) && !isDevOnlyRuntimePath(candidate)
  )
  return found ? { command: found, args: [] } : null
}

function resolveBundledHelper(resourcesPath: string): { command: string; args: string[] } | null {
  const bundled = bundledHelperPath(resourcesPath)
  if (!existsSync(bundled) || isDevOnlyRuntimePath(bundled)) {
    return null
  }
  return { command: bundled, args: [] }
}
