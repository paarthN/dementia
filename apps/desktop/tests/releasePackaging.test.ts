import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPlaywrightAdapter } from '../src/main/agent/ports/PlaywrightAdapter'
import {
  bundledBrowserExecutable,
  helperMethodNames,
  isDevOnlyRuntimePath,
  resolveBundledBrowser,
  resolveHelperCommand
} from '../src/main/services/osBridge'
import {
  planHelperPrompts,
  readHelperPermissionStatus,
  shouldRequestOsPermission
} from '../src/shared/permissionPrompt'
import { benchmarkOutcome } from '../src/shared/releaseBenchmark'
import { describeCapabilities } from '../src/shared/capabilities'

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

describe('packaged runtime paths', () => {
  it('uses the helper and browser inside a relocated app and ignores the repo and Homebrew', () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-relocated-'))
    const resources = join(root, 'Companion.app/Contents/Resources')
    const helper = join(resources, 'helper/CompanionMacHelper')
    touch(helper)
    touch(bundledBrowserExecutable(resources))
    touch(join(root, 'native/CompanionMacHelper/.build/release/CompanionMacHelper'))
    touch(join(root, 'opt/homebrew/bin/peekaboo'))

    const resolved = resolveHelperCommand(
      { COMPANION_HELPER_PATH: join(root, 'opt/homebrew/bin/peekaboo') },
      root,
      {
        packaged: true,
        resourcesPath: resources
      }
    )

    expect(resolved).toEqual({ command: join(resources, 'helper/CompanionMacHelper'), args: [] })
    expect(resolveBundledBrowser(resources)).toBe(bundledBrowserExecutable(resources))
    expect(isDevOnlyRuntimePath('/opt/homebrew/bin/peekaboo')).toBe(true)
  })

  it('does not fall back to a dev helper when the packaged copy is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-missing-helper-'))
    const resources = join(root, 'Resources')
    mkdirSync(resources, { recursive: true })
    const devHelper = join(root, 'native/CompanionMacHelper/.build/release/CompanionMacHelper')
    touch(devHelper)

    expect(resolveHelperCommand({}, root, { packaged: true, resourcesPath: resources })).toBeNull()
    expect(resolveBundledBrowser(resources)).toBeNull()
    expect(resolveHelperCommand({}, root, { packaged: false })).toEqual({
      command: devHelper,
      args: []
    })
  })

  it('refuses to launch Agent Browser when the packaged Chromium binary is absent', async () => {
    const adapter = createPlaywrightAdapter({
      profileDir: mkdtempSync(join(tmpdir(), 'companion-no-browser-')),
      browserExecutable: null
    })
    const launched = await adapter.launch({})
    expect(launched.status).toBe('unsupported')
    expect(launched.errorCode).toBe('unavailable')
  })

  it('keeps helper methods on the allowlist and does not install a browser at runtime', () => {
    expect(helperMethodNames).not.toContain('shell')
    expect(helperMethodNames).not.toContain('osascript')
    expect(helperMethodNames).toContain('system.permissionStatus')
    expect(helperMethodNames).toContain('system.promptScreenCapture')
    const adapter = readFileSync(
      resolve(__dirname, '../src/main/agent/ports/PlaywrightAdapter.ts'),
      'utf8'
    )
    expect(adapter).not.toContain('playwright install')
    expect(adapter).not.toContain('npx ')
    const builder = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8')
    expect(builder).toContain('notarize: false')
    expect(builder).toContain('agent-browser')
    expect(builder).toContain('!staged/**')
  })
})

describe('permission prompts', () => {
  it('asks once for an unknown grant and does not ask again after a denial', () => {
    expect(shouldRequestOsPermission('not-determined', false)).toBe(true)
    expect(shouldRequestOsPermission('not-determined', true)).toBe(false)
    expect(shouldRequestOsPermission('unknown', false)).toBe(true)
    expect(shouldRequestOsPermission('denied', false)).toBe(false)
    expect(shouldRequestOsPermission('restricted', false)).toBe(false)
    expect(shouldRequestOsPermission('granted', false)).toBe(false)
  })

  it('prompts the helper only while a grant is missing, and only once', () => {
    expect(
      planHelperPrompts({
        accessibilityTrusted: false,
        screenCaptureAllowed: false,
        askedAccessibility: false,
        askedScreenCapture: false,
        userRequestedScreen: false
      })
    ).toMatchObject({ promptAccessibility: true, promptScreenCapture: false })

    expect(
      planHelperPrompts({
        accessibilityTrusted: false,
        screenCaptureAllowed: false,
        askedAccessibility: true,
        askedScreenCapture: false,
        userRequestedScreen: true
      })
    ).toMatchObject({ promptAccessibility: false, promptScreenCapture: true })

    const again = planHelperPrompts({
      accessibilityTrusted: false,
      screenCaptureAllowed: false,
      askedAccessibility: true,
      askedScreenCapture: true,
      userRequestedScreen: true
    })
    expect(again.promptAccessibility).toBe(false)
    expect(again.promptScreenCapture).toBe(false)
    expect(again.missing.join(' ')).toContain('Companion helper')

    const down = planHelperPrompts({
      accessibilityTrusted: null,
      screenCaptureAllowed: null,
      askedAccessibility: false,
      askedScreenCapture: false,
      userRequestedScreen: true
    })
    expect(down.promptAccessibility).toBe(false)
    expect(down.promptScreenCapture).toBe(false)
    expect(down.missing.join(' ')).toContain('not running')
  })

  it('reads a helper permission status and ignores a malformed payload', () => {
    expect(
      readHelperPermissionStatus({ accessibilityTrusted: true, screenCaptureAllowed: false })
    ).toEqual({ accessibilityTrusted: true, screenCaptureAllowed: false })
    expect(readHelperPermissionStatus({ trusted: true })).toBeNull()
  })

  it('reports the helper grants separately from the Electron app', () => {
    const capabilities = describeCapabilities({
      platform: 'darwin',
      accessibilityTrusted: true,
      screenRecordingStatus: 'granted',
      swiftHelperRunning: true,
      helperAccessibilityTrusted: false,
      helperScreenCaptureAllowed: false
    })
    expect(capabilities.accessibility.available).toBe(true)
    expect(capabilities.helperAccessibility.available).toBe(false)
    expect(capabilities.helperAccessibility.reason).toContain('Companion helper')
    expect(capabilities.helperScreenCapture.available).toBe(false)
  })
})

describe('benchmark outcomes', () => {
  it('does not treat an uncertain or unverified result as success', () => {
    expect(benchmarkOutcome('success_verified')).toBe('success')
    expect(benchmarkOutcome('changed_but_unverified')).toBe('partial')
    expect(benchmarkOutcome('needs_permission')).toBe('partial')
    expect(benchmarkOutcome('uncertain_after_timeout')).toBe('failure')
    expect(benchmarkOutcome('failed')).toBe('failure')
  })
})
