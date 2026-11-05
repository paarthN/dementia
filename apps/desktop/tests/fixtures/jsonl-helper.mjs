import { existsSync, writeFileSync } from 'node:fs'
import readline from 'node:readline'

const marker = process.argv[2]
const lines = readline.createInterface({ input: process.stdin })

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, 'crashed')
    process.exit(1)
  }
  const result = message.method === 'system.ping' ? { pong: true } : { method: message.method }
  process.stdout.write(`${JSON.stringify({ id: message.id, version: 1, ok: true, result })}\n`)
})
