import { describe, expect, it } from 'vitest'
import { companionIpcChannels } from '../src/shared/channels'
import { parseCompanionIpcArgs } from '../src/shared/ipcSchemas'

describe('parseCompanionIpcArgs', () => {
  it('accepts an empty payload for named channels', () => {
    expect(parseCompanionIpcArgs(companionIpcChannels.getCapabilities, [])).toEqual({})
    expect(parseCompanionIpcArgs(companionIpcChannels.openPanel, [{}])).toEqual({})
    expect(parseCompanionIpcArgs(companionIpcChannels.closePanel, [])).toEqual({})
  })

  it('rejects unknown channels and extra fields', () => {
    expect(() => parseCompanionIpcArgs('ipcRenderer', [])).toThrow(/Unknown IPC channel/)
    expect(() =>
      parseCompanionIpcArgs(companionIpcChannels.openPanel, [{ command: 'sh' }])
    ).toThrow()
    expect(() => parseCompanionIpcArgs(companionIpcChannels.closePanel, [{}, {}])).toThrow(
      /Unexpected IPC arguments/
    )
  })
})
