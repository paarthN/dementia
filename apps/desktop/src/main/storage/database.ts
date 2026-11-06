import { randomUUID } from 'node:crypto'
import { redactSecretText } from '../agent/AgentPrompt'
import { DatabaseSync } from 'node:sqlite'
import {
  domainsDiffer,
  moveSortOrder,
  validateFavoriteTarget,
  type Favorite,
  type FavoriteKind,
  type FavoriteSaveResult
} from '../../shared/favorites'
import { defaultPreferences, readPreferences, type UserPreferences } from '../../shared/preferences'

interface FavoriteRow {
  id: string
  kind: FavoriteKind
  title: string
  target_json: string
  sort_order: number
  last_launch_at: string | null
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('application', 'website', 'task')),
      title TEXT NOT NULL,
      target_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_launch_at TEXT NULL
    );
  `)
  const current = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined
  if (!current) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(1)
  }
  const version = current?.version ?? 1
  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NULL,
        operation TEXT NOT NULL,
        result TEXT NOT NULL,
        safe_summary TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );
    `)
    db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run()
  }
  if (version < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NULL,
        trigger_at_utc TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'fired', 'completed', 'cancelled', 'missed')),
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('user', 'assistant'))
      );
    `)
    db.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run()
  }
  return db
}

export function recordActivity(
  db: DatabaseSync,
  entry: { taskId: string | null; operation: string; result: string; safeSummary: string }
): void {
  db.prepare(
    `INSERT INTO activity_events (id, task_id, operation, result, safe_summary, created_at_utc)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    entry.taskId,
    entry.operation,
    entry.result,
    redactActivitySummary(entry.safeSummary),
    new Date().toISOString()
  )
}

function redactActivitySummary(value: string): string {
  const withoutImages = value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[image omitted]')
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[image omitted]')
  return redactSecretText(withoutImages).replace(/\s+/g, ' ').trim().slice(0, 400)
}

export function loadPreferences(db: DatabaseSync): UserPreferences {
  const row = db
    .prepare('SELECT value_json FROM app_settings WHERE key = ?')
    .get('user_preferences') as { value_json: string } | undefined
  if (!row) {
    savePreferences(db, defaultPreferences)
    return defaultPreferences
  }
  try {
    return readPreferences(JSON.parse(row.value_json))
  } catch {
    return defaultPreferences
  }
}

export function savePreferences(db: DatabaseSync, preferences: UserPreferences): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run('user_preferences', JSON.stringify(preferences), now)
}

export function listFavorites(db: DatabaseSync): Favorite[] {
  const rows = db
    .prepare(
      `SELECT id, kind, title, target_json, sort_order, last_launch_at
       FROM favorites
       ORDER BY sort_order ASC, title ASC`
    )
    .all() as unknown as FavoriteRow[]
  return rows.map(toFavorite)
}

export function saveFavorite(
  db: DatabaseSync,
  input: {
    id?: string
    kind: FavoriteKind
    title: string
    target: string
    confirmDomainChange?: boolean
  }
): FavoriteSaveResult {
  const title = input.title.trim()
  if (!title) {
    return { status: 'failed', summary: 'Give this favorite a name.' }
  }
  const validated = validateFavoriteTarget(input.kind, input.target)
  if ('error' in validated) {
    return { status: 'failed', summary: validated.error }
  }

  const existing = input.id ? findFavorite(db, input.id) : undefined
  if (
    existing &&
    existing.kind === 'website' &&
    input.kind === 'website' &&
    !input.confirmDomainChange &&
    domainsDiffer(existing.target, validated.target)
  ) {
    return {
      status: 'needs_confirmation',
      summary: 'The website domain changed. Save it only if you recognize the new address.'
    }
  }

  const now = new Date().toISOString()
  const id = existing?.id ?? randomUUID()
  const sortOrder = existing?.sortOrder ?? nextSortOrder(db)
  const targetJson = JSON.stringify({ target: validated.target })
  if (existing) {
    db.prepare(
      `UPDATE favorites
       SET kind = ?, title = ?, target_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(input.kind, title, targetJson, now, id)
  } else {
    db.prepare(
      `INSERT INTO favorites
        (id, kind, title, target_json, sort_order, created_at, updated_at, last_launch_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(id, input.kind, title, targetJson, sortOrder, now, now)
  }
  const saved = findFavorite(db, id)
  if (!saved) {
    return { status: 'failed', summary: 'The favorite could not be saved.' }
  }
  return { status: 'saved', favorite: saved }
}

export function deleteFavorite(db: DatabaseSync, id: string): Favorite | null {
  const existing = findFavorite(db, id)
  if (!existing) {
    return null
  }
  db.prepare('DELETE FROM favorites WHERE id = ?').run(id)
  return existing
}

export function reorderFavorite(
  db: DatabaseSync,
  id: string,
  direction: 'up' | 'down'
): Favorite[] {
  const current = listFavorites(db)
  const target = current.find((favorite) => favorite.id === id)
  if (!target) {
    return current
  }
  const sameKind = current
    .filter((favorite) => favorite.kind === target.kind)
    .map((favorite) => favorite.id)
  const reordered = moveSortOrder(sameKind, id, direction)
  const queue = [...reordered]
  const nextIds = current.map((favorite) =>
    favorite.kind === target.kind ? (queue.shift() ?? favorite.id) : favorite.id
  )
  const now = new Date().toISOString()
  nextIds.forEach((favoriteId, index) => {
    db.prepare('UPDATE favorites SET sort_order = ?, updated_at = ? WHERE id = ?').run(
      index,
      now,
      favoriteId
    )
  })
  return listFavorites(db)
}

export function markFavoriteLaunched(db: DatabaseSync, id: string, at: string): void {
  db.prepare('UPDATE favorites SET last_launch_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
}

function findFavorite(db: DatabaseSync, id: string): Favorite | undefined {
  return listFavorites(db).find((favorite) => favorite.id === id)
}

function nextSortOrder(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS value FROM favorites').get() as
    { value: number } | undefined
  return (row?.value ?? -1) + 1
}

function readTarget(json: string): string {
  try {
    const parsed = JSON.parse(json) as { target?: string }
    return parsed.target ?? ''
  } catch {
    return ''
  }
}

function toFavorite(row: FavoriteRow): Favorite {
  const target = readTarget(row.target_json)
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    target,
    sortOrder: row.sort_order,
    lastLaunchAt: row.last_launch_at
  }
}
