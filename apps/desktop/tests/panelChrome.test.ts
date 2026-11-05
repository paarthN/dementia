import { describe, expect, it } from 'vitest'
import {
  classifyMediaAccess,
  mediaPermissionAllowed,
  panelChrome
} from '../src/shared/systemPermissions'

describe('desktop panel chrome', () => {
  it('uses a landscape desktop window rather than a phone-shaped panel', () => {
    expect(panelChrome.width).toBeGreaterThan(panelChrome.height)
    expect(panelChrome.width).toBeGreaterThanOrEqual(960)
    expect(panelChrome.height).toBeGreaterThanOrEqual(640)
    expect(panelChrome.minWidth).toBeGreaterThanOrEqual(800)
    expect(panelChrome.minWidth).toBeLessThan(panelChrome.width)
  })

  it('classifies macOS media access and only allows the microphone prompt', () => {
    expect(classifyMediaAccess('granted')).toBe('granted')
    expect(classifyMediaAccess('denied')).toBe('denied')
    expect(classifyMediaAccess('restricted')).toBe('denied')
    expect(classifyMediaAccess('not-determined')).toBe('unknown')
    expect(mediaPermissionAllowed('media')).toBe(true)
    expect(mediaPermissionAllowed('geolocation')).toBe(false)
    expect(mediaPermissionAllowed('display-capture')).toBe(false)
  })
})
