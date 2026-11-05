import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin })

const windows = {
  windows: [
    {
      windowId: '42',
      appName: 'TextEdit',
      bundleId: 'com.apple.TextEdit',
      title: 'Untitled',
      processId: 100
    }
  ]
}

const observation = {
  windowId: '42',
  processId: 100,
  bundleId: 'com.apple.TextEdit',
  appName: 'TextEdit',
  title: 'Untitled',
  protected: false,
  truncated: false,
  targets: [
    {
      id: 'node-0',
      role: 'AXTextArea',
      name: 'Note',
      enabled: true,
      value: '',
      bounds: null
    }
  ]
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  const result = message.method === 'desktop.listWindows' ? windows : observation
  process.stdout.write(`${JSON.stringify({ id: message.id, version: 1, ok: true, result })}\n`)
})
