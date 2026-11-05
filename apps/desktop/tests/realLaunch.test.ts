import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnCommand } from '../src/main/services/launcher'
import { TaskOrchestrator } from '../src/main/services/taskOrchestrator'
import { openDatabase } from '../src/main/storage/database'

const enabled = process.env.COMPANION_REAL_LAUNCH === '1'

describe.skipIf(!enabled)('real macOS launches', () => {
  it('opens TextEdit, a search, and Displays through the task engine', async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-real-')), 'test.sqlite'))
    const orchestrator = new TaskOrchestrator({
      db,
      run: spawnCommand,
      timeoutMs: 20_000
    })

    const textEdit = await orchestrator.submit('Open TextEdit')
    const search = await orchestrator.submit('Search for gardening tips')
    const settings = await orchestrator.submit('Make everything on my Mac bigger')
    const text = await orchestrator.submit('Make your text bigger')

    expect(textEdit.responseState).toBe('success')
    expect(textEdit.summary).toBe('TextEdit is open.')
    expect(search.responseState).toBe('success')
    expect(search.summary).toContain('gardening tips')
    expect(settings.responseState).toBe('success')
    expect(settings.summary.toLowerCase()).toContain('opened')
    expect(settings.summary.toLowerCase()).not.toContain('i changed')
    expect(text.responseState).toBe('success')
  }, 30_000)
})
