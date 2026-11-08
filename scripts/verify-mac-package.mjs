import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'apps/desktop/dist')
const candidates = [
  join(dist, 'mac-arm64/Companion.app'),
  join(dist, 'mac/Companion.app')
]
const app = candidates.find((candidate) => existsSync(candidate))
if (!app) {
  console.error(`No Companion.app was found under ${dist}`)
  process.exit(1)
}

const helper = join(app, 'Contents/Resources/helper/CompanionMacHelper')
const browser = join(
  app,
  'Contents/Resources/agent-browser/Chromium.app/Contents/MacOS/Google Chrome for Testing'
)
if (!existsSync(helper) || !existsSync(browser)) {
  console.error('The packaged app is missing the helper or Agent Browser.')
  console.error(helper)
  console.error(browser)
  process.exit(1)
}

function sign(target) {
  const result = spawnSync('codesign', ['--force', '--sign', '-', target], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout)
    process.exit(result.status ?? 1)
  }
}

sign(helper)
const chromiumApp = join(app, 'Contents/Resources/agent-browser/Chromium.app')
const chromiumSign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', chromiumApp], {
  encoding: 'utf8'
})
if (chromiumSign.status !== 0) {
  console.error(chromiumSign.stderr || chromiumSign.stdout)
  process.exit(chromiumSign.status ?? 1)
}
sign(app)

const relocatedRoot = mkdtempSync(join(tmpdir(), 'companion-relocated-'))
const relocated = join(relocatedRoot, 'Companion.app')
cpSync(app, relocated, { recursive: true })
const relocatedHelper = join(relocated, 'Contents/Resources/helper/CompanionMacHelper')
const relocatedBrowser = join(
  relocated,
  'Contents/Resources/agent-browser/Chromium.app/Contents/MacOS/Google Chrome for Testing'
)
if (!existsSync(relocatedHelper) || !existsSync(relocatedBrowser)) {
  console.error('The relocated app could not find its helper or browser.')
  process.exit(1)
}
sign(relocatedHelper)

const ping = await new Promise((resolvePing) => {
  const child = spawn(relocatedHelper, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  const timer = setTimeout(() => {
    child.kill()
    resolvePing('')
  }, 5_000)
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
    if (output.includes('\n')) {
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      resolvePing(output)
    }
  })
  child.on('error', () => {
    clearTimeout(timer)
    resolvePing('')
  })
  child.stdin.write(`${JSON.stringify({ id: '1', version: 1, method: 'system.ping', params: {} })}\n`)
})

if (!ping.includes('"pong":true') && !ping.includes('"pong": true')) {
  console.error('The relocated helper did not answer system.ping.')
  console.error(ping)
  process.exit(1)
}

rmSync(relocatedRoot, { recursive: true, force: true })
if (existsSync(relocated)) {
  console.error('Uninstall left the relocated app in place.')
  process.exit(1)
}

const helperVerify = spawnSync('codesign', ['--verify', '--strict', helper], { encoding: 'utf8' })
const appVerify = spawnSync('codesign', ['--verify', '--strict', app], { encoding: 'utf8' })
const signature = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' })
const signatureText = `${signature.stdout}\n${signature.stderr}`
const assessment = spawnSync('spctl', ['--assess', '--verbose', '--type', 'execute', app], {
  encoding: 'utf8'
})
console.log('Packaged app:', app)
console.log('Helper ping from a relocated copy: ok')
console.log('Removed the relocated copy. The built app is still in dist.')
console.log(signatureText.trim())
console.log(assessment.stdout.trim())
console.log(assessment.stderr.trim())
console.log(`helper signature verify: ${helperVerify.status === 0 ? 'PASS' : 'FAIL'}`)
console.log(`app signature verify: ${appVerify.status === 0 ? 'PASS' : 'FAIL'}`)
if (helperVerify.status !== 0 || appVerify.status !== 0) {
  console.error(helperVerify.stderr)
  console.error(appVerify.stderr)
  process.exit(1)
}
if (!signatureText.includes('Signature=adhoc')) {
  console.error('The app does not have an ad-hoc signature.')
  process.exit(1)
}
console.log('notarization: FAIL (Developer ID signing is not configured)')
console.log('gatekeeper: FAIL (an ad-hoc app is not a public release)')
