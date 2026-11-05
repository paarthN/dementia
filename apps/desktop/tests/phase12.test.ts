import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launchBundle, launchWebsite } from '../src/main/services/launcher'
import {
  listFavorites,
  loadPreferences,
  openDatabase,
  reorderFavorite,
  saveFavorite,
  savePreferences
} from '../src/main/storage/database'
import { isBundleId, moveSortOrder, parseWebsite } from '../src/shared/favorites'
import { clampScreenPoint, resolveWorkArea, unitToScreen } from '../src/shared/mascotPlacement'
import { defaultPreferences, resetAppearance } from '../src/shared/preferences'
import { systemSettingsUrl } from '../src/shared/systemSettings'

describe('mascot placement', () => {
  const primary = { id: 'main', x: 0, y: 40, width: 1440, height: 800 }
  const secondary = { id: 'side', x: 1440, y: 0, width: 1920, height: 1080 }

  it('keeps a window inside the work area at both edges', () => {
    const size = { width: 220, height: 300 }
    const origin = unitToScreen(primary, 0, 0, size)
    const far = unitToScreen(primary, 1, 1, size)
    expect(origin).toEqual({ x: 0, y: 40 })
    expect(far.x).toBeLessThanOrEqual(primary.x + primary.width - size.width)
    expect(far.y).toBeLessThanOrEqual(primary.y + primary.height - size.height)
    expect(clampScreenPoint(primary, 5000, 5000, size)).toEqual(far)
  })

  it('moves the mascot to the primary display when its monitor is gone', () => {
    const area = resolveWorkArea([primary, secondary], 'unplugged', 'main')
    expect(area.id).toBe('main')
  })
})

describe('favorites and appearance', () => {
  it('rejects unsafe website targets and unknown bundle ids', () => {
    expect(parseWebsite('javascript:alert(1)')).toHaveProperty('error')
    expect(parseWebsite('file:///etc/passwd')).toHaveProperty('error')
    expect(parseWebsite('https://example.com/recipes')).toMatchObject({ domain: 'example.com' })
    expect(isBundleId('notepad')).toBe(false)
    expect(isBundleId('com.apple.TextEdit')).toBe(true)
  })

  it('persists favorites and keeps them when appearance resets', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-')), 'test.sqlite'))
    const saved = saveFavorite(db, {
      kind: 'website',
      title: 'Recipes',
      target: 'https://example.com/recipes'
    })
    expect(saved.status).toBe('saved')
    const rejected = saveFavorite(db, {
      kind: 'website',
      title: 'Bad',
      target: 'javascript:alert(1)'
    })
    expect(rejected.status).toBe('failed')
    const missing = saveFavorite(db, {
      kind: 'application',
      title: 'Missing',
      target: 'not an app'
    })
    expect(missing.status).toBe('failed')

    const first = listFavorites(db)[0]
    expect(first?.title).toBe('Recipes')
    saveFavorite(db, { kind: 'application', title: 'TextEdit', target: 'com.apple.TextEdit' })
    const ids = listFavorites(db).map((favorite) => favorite.id)
    reorderFavorite(db, ids[1] ?? '', 'up')
    expect(listFavorites(db).map((favorite) => favorite.title)).toEqual(['Recipes', 'TextEdit'])
    expect(moveSortOrder(ids, ids[0] ?? '', 'up')).toEqual(ids)

    const changed = {
      ...defaultPreferences,
      appearance: { ...defaultPreferences.appearance, textScale: 'extra-large' as const }
    }
    savePreferences(db, changed)
    savePreferences(db, resetAppearance(loadPreferences(db)))
    expect(loadPreferences(db).appearance.textScale).toBe('comfortable')
    expect(listFavorites(db)).toHaveLength(2)
  })

  it('reorders a favorite within its own list', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'companion-')), 'test.sqlite'))
    saveFavorite(db, { kind: 'application', title: 'Notes', target: 'com.apple.Notes' })
    saveFavorite(db, { kind: 'website', title: 'Recipes', target: 'https://example.com/recipes' })
    saveFavorite(db, { kind: 'application', title: 'TextEdit', target: 'com.apple.TextEdit' })
    const textEdit = listFavorites(db).find((favorite) => favorite.title === 'TextEdit')
    reorderFavorite(db, textEdit?.id ?? '', 'up')
    expect(
      listFavorites(db)
        .filter((favorite) => favorite.kind === 'application')
        .map((favorite) => favorite.title)
    ).toEqual(['TextEdit', 'Notes'])
    expect(listFavorites(db).find((favorite) => favorite.kind === 'website')?.title).toBe('Recipes')
  })

  it('does not report a launch when the opener fails', async () => {
    const failed = await launchBundle('com.apple.TextEdit', async () => 1)
    expect(failed.status).toBe('failed')
    const opened = await launchWebsite('https://example.com', async () => 0)
    expect(opened.summary).toContain('opened')
    expect(systemSettingsUrl('text')).toBe(
      'x-apple.systempreferences:com.apple.Accessibility?Display'
    )
  })
})
