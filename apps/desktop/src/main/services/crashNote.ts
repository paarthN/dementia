import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecretText } from '../agent/AgentPrompt'

export interface CrashNoteInput {
  name: string
  message: string
  atUtc: string
}

export function writeCrashNote(
  directory: string,
  consent: boolean,
  input: CrashNoteInput
): string | null {
  if (!consent) {
    return null
  }
  const body = [input.atUtc, safeName(input.name), redactCrashMessage(input.message)].join('\n')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'crash-note.txt')
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function safeName(value: string): string {
  const cleaned = value
    .replace(/[^\w .:-]/g, '')
    .trim()
    .slice(0, 80)
  return cleaned || 'Error'
}

function redactCrashMessage(value: string): string {
  const modelKey = new RegExp(
    String.raw`\b${String.fromCharCode(115, 107, 45)}[A-Za-z0-9_-]+\b`,
    'g'
  )
  const redacted = redactSecretText(value)
    .replace(/\/Users\/[^/\s]+/g, '/Users/[name]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(modelKey, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[omitted]')
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 500)
}
