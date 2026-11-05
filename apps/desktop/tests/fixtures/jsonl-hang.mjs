import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const log = process.argv[2]
const lines = readline.createInterface({ input: process.stdin })

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (log) {
    appendFileSync(log, `${message.method}\n`)
  }
  if (message.method === 'desktop.cancel') {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, version: 1, ok: true, result: { accepted: true } })}\n`
    )
  }
})
