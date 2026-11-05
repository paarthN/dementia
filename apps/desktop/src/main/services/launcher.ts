import { spawn } from 'node:child_process'
import { systemSettingsUrl, type SystemSettingsSection } from '../../shared/systemSettings'
import type { ActionResult } from '../../shared/session'

export type CommandRunner = (command: string, args: string[]) => Promise<number>

export function spawnCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export async function launchBundle(
  bundleId: string,
  run: CommandRunner = spawnCommand
): Promise<ActionResult> {
  const code = await run('/usr/bin/open', ['-b', bundleId])
  if (code !== 0) {
    return { status: 'failed', summary: "I couldn't find that app on this computer." }
  }
  return { status: 'succeeded', summary: 'The app is open.' }
}

export async function launchAppByName(
  name: string,
  run: CommandRunner = spawnCommand
): Promise<ActionResult> {
  const code = await run('/usr/bin/open', ['-a', name])
  if (code !== 0) {
    return { status: 'failed', summary: "I couldn't find that app on this computer." }
  }
  return { status: 'succeeded', summary: 'The app is open.' }
}

export async function launchWebsite(
  url: string,
  run: CommandRunner = spawnCommand
): Promise<ActionResult> {
  const code = await run('/usr/bin/open', [url])
  if (code !== 0) {
    return { status: 'failed', summary: "I couldn't open the browser." }
  }
  return { status: 'succeeded', summary: 'I opened that website in your browser.' }
}

export async function launchSystemSettings(
  section: SystemSettingsSection,
  run: CommandRunner = spawnCommand
): Promise<ActionResult> {
  const code = await run('/usr/bin/open', [systemSettingsUrl(section)])
  if (code !== 0) {
    return { status: 'failed', summary: "I couldn't open System Settings." }
  }
  return {
    status: 'succeeded',
    summary: 'I opened System Settings. I did not change your Mac.'
  }
}
