import { cpSync, chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Packaging must use the normal Playwright browser install. A temp cache path
// would be copied into the app and break after that directory is removed.
delete process.env.PLAYWRIGHT_BROWSERS_PATH
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { chromium } = require('playwright')

const executable = chromium.executablePath()
if (!existsSync(executable)) {
  console.error('Chromium is not installed. From the repository root, run: npx playwright install chromium')
  process.exit(1)
}

const appBundle = resolve(executable, '../../..')
if (!appBundle.endsWith('.app')) {
  console.error(`Could not find the Chromium app bundle from ${executable}`)
  process.exit(1)
}

const helper = join(root, 'native/CompanionMacHelper/.build/release/CompanionMacHelper')
if (!existsSync(helper)) {
  console.error('The helper binary is missing. Run npm run build:helper first.')
  process.exit(1)
}

const staged = join(root, 'apps/desktop/staged')
rmSync(staged, { recursive: true, force: true })
mkdirSync(join(staged, 'helper'), { recursive: true })
cpSync(helper, join(staged, 'helper/CompanionMacHelper'))
chmodSync(join(staged, 'helper/CompanionMacHelper'), 0o755)
cpSync(appBundle, join(staged, 'agent-browser/Chromium.app'), {
  recursive: true,
  verbatimSymlinks: true
})
console.log('Staged the helper and Agent Browser Chromium. No browser was downloaded.')
