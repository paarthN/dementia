import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const requestLimit = 65_536
const responseLimit = 1_000_000

const helperMethods = new Set([
  'system.ping',
  'system.promptAccessibility',
  'system.getForegroundWindow',
  'ui.inspectForeground',
  'ui.findElement',
  'ui.readElementState',
  'ui.invokeElement',
  'screen.captureOnce',
  'desktop.listWindows',
  'desktop.focusWindow',
  'desktop.observe',
  'desktop.clickElement',
  'desktop.setText',
  'desktop.keyPress',
  'desktop.scroll',
  'desktop.cancel'
])

const oneShotMethods = new Set([
  'ui.invokeElement',
  'desktop.focusWindow',
  'desktop.clickElement',
  'desktop.setText',
  'desktop.keyPress',
  'desktop.scroll'
])

export class HelperCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly dispatched = false
  ) {
    super(message)
    this.name = 'HelperCallError'
  }
}

export class HelperUnavailable extends Error {
  constructor(
    message = 'Some screen-help features are unavailable.',
    readonly dispatched = false
  ) {
    super(message)
    this.name = 'HelperUnavailable'
  }
}

export function helperCallUnresolved(error: unknown): boolean {
  if (error instanceof HelperCallError) {
    return (
      error.dispatched &&
      (error.code === 'aborted' || error.code === 'timeout' || error.code === 'uncertain')
    )
  }
  return error instanceof HelperUnavailable && error.dispatched
}

export interface OsBridge {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<unknown>
  close(): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  dispatched: boolean
}

export function createMacOsBridge(options: { command: string; args?: string[] }): OsBridge {
  let child: ChildProcessWithoutNullStreams | null = null
  let buffer = ''
  let nextId = 0
  let crashed = false
  let retried = false
  const pending = new Map<string, Pending>()

  function failAll(error: Error): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      if (entry.dispatched && error instanceof HelperUnavailable) {
        entry.reject(new HelperUnavailable(error.message, true))
      } else {
        entry.reject(error)
      }
    }
    pending.clear()
  }

  function notifyCancel(requestId: string): void {
    if (!child || crashed) {
      return
    }
    const payload = JSON.stringify({
      id: `req_${(nextId += 1)}`,
      version: 1,
      method: 'desktop.cancel',
      params: { requestId }
    })
    child.stdin.write(`${payload}\n`, () => undefined)
  }

  function spawnChild(): ChildProcessWithoutNullStreams {
    const processChild = spawn(options.command, options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    crashed = false
    buffer = ''
    processChild.stdout.setEncoding('utf8')
    processChild.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > responseLimit) {
        buffer = ''
        failAll(new HelperUnavailable())
        processChild.kill()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          deliver(line)
        }
        newline = buffer.indexOf('\n')
      }
    })
    processChild.on('error', () => {
      crashed = true
      failAll(new HelperUnavailable())
    })
    processChild.on('close', () => {
      if (child !== processChild) {
        return
      }
      crashed = true
      child = null
      failAll(new HelperUnavailable())
    })
    child = processChild
    return processChild
  }

  function deliver(line: string): void {
    let parsed: {
      id?: string
      ok?: boolean
      result?: unknown
      error?: { code?: string; message?: string }
    }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      return
    }
    if (!parsed.id) {
      return
    }
    const entry = pending.get(parsed.id)
    if (!entry) {
      return
    }
    pending.delete(parsed.id)
    clearTimeout(entry.timer)
    if (parsed.ok === true) {
      entry.resolve(parsed.result)
      return
    }
    entry.reject(
      new HelperCallError(
        parsed.error?.code ?? 'helper_error',
        parsed.error?.message ?? 'The helper could not finish that request.'
      )
    )
  }

  function ensureChild(): ChildProcessWithoutNullStreams {
    if (child && !crashed) {
      return child
    }
    return spawnChild()
  }

  async function send(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const payload = JSON.stringify({
      id: `req_${(nextId += 1)}`,
      version: 1,
      method,
      params
    })
    if (payload.length > requestLimit) {
      throw new HelperCallError('request_too_large', 'That request is too large.')
    }
    const current = ensureChild()
    const id = JSON.parse(payload).id as string
    return new Promise((resolve, reject) => {
      const state = { dispatched: false }
      const timer = setTimeout(() => {
        const dispatched = pending.get(id)?.dispatched === true
        pending.delete(id)
        if (dispatched) {
          notifyCancel(id)
        }
        reject(new HelperCallError('timeout', 'That took too long, so I stopped.', dispatched))
      }, timeoutMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        const dispatched = state.dispatched
        pending.delete(id)
        if (dispatched) {
          notifyCancel(id)
        }
        reject(new HelperCallError('aborted', 'Screen access has stopped.', dispatched))
      }
      if (signal?.aborted) {
        clearTimeout(timer)
        reject(new HelperCallError('aborted', 'Screen access has stopped.', false))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
        dispatched: false
      })
      state.dispatched = true
      const entry = pending.get(id)
      if (entry) {
        entry.dispatched = true
      }
      current.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          clearTimeout(timer)
          pending.delete(id)
          signal?.removeEventListener('abort', onAbort)
          crashed = true
          reject(new HelperUnavailable())
        }
      })
    })
  }

  return {
    async request(method, params = {}, options = {}) {
      if (!helperMethods.has(method)) {
        throw new HelperCallError('unknown_method', 'That helper method is not available.')
      }
      const timeoutMs = options.timeoutMs ?? 8_000
      try {
        const result = await send(method, params, timeoutMs, options.signal)
        retried = false
        return result
      } catch (error) {
        const crashed = error instanceof HelperUnavailable
        if (!crashed || retried || oneShotMethods.has(method) || options.signal?.aborted) {
          throw error
        }
        retried = true
        const failed = child
        child = null
        failed?.kill()
        try {
          return await send(method, params, timeoutMs, options.signal)
        } catch (retryError) {
          throw retryError instanceof HelperCallError ? retryError : new HelperUnavailable()
        }
      }
    },
    close() {
      failAll(new HelperUnavailable())
      child?.kill()
      child = null
    }
  }
}

export function createClosedOsBridge(
  message = 'Some screen-help features are unavailable.'
): OsBridge {
  return {
    async request() {
      throw new HelperUnavailable(message)
    },
    close() {
      return undefined
    }
  }
}

export function helperBinaryCandidates(start = process.cwd()): string[] {
  return [
    join(start, 'native/CompanionMacHelper/.build/release/CompanionMacHelper'),
    join(start, '../../native/CompanionMacHelper/.build/release/CompanionMacHelper'),
    join(start, '../../../../native/CompanionMacHelper/.build/release/CompanionMacHelper')
  ]
}

export function resolveHelperCommand(
  env: NodeJS.ProcessEnv = process.env,
  start = process.cwd()
): { command: string; args: string[] } | null {
  const override = env['COMPANION_HELPER_PATH']
  if (override && existsSync(override)) {
    return { command: override, args: [] }
  }
  const found = helperBinaryCandidates(start).find((candidate) => existsSync(candidate))
  return found ? { command: found, args: [] } : null
}
