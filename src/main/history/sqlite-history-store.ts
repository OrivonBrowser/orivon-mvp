// History in one SQLite file. A page is a row, and each time it was reached is
// a row of its own, so a range of time can be forgotten without losing the
// pages visited outside it. Writes wait a moment and go in one transaction, so
// a page that redirects three times is one write, not three.
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_TITLE_LENGTH, MAX_URL_LENGTH } from './history-store.js'
import type { HistoryEntry, HistoryQuery, HistoryStore } from './history-store.js'

const SCHEMA_VERSION = 1
const WRITE_DELAY_MS = 500
/** The most changes held while waiting to write; past it the oldest is written at once. */
const MAX_QUEUED = 500

type Change =
  | { readonly type: 'visit', readonly url: string, readonly title: string, readonly at: number }
  | { readonly type: 'title', readonly url: string, readonly title: string }

interface Row { id: number, url: string, title: string, last_visit: number, visit_count: number }

const toEntry = (row: Row): HistoryEntry => ({ id: row.id, url: row.url, title: row.title, lastVisit: row.last_visit, visitCount: row.visit_count })

/** Escapes what LIKE would read as a pattern. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`

export class SqliteHistoryStore implements HistoryStore {
  readonly kind = 'sqlite'
  private readonly db: DatabaseSync
  private closed = false
  private readonly queue: Change[] = []
  private readonly writer = new DebouncedWriter(async () => { this.drain() }, WRITE_DELAY_MS)
  private readonly statements: {
    findPage: StatementSync
    insertPage: StatementSync
    touchPage: StatementSync
    insertVisit: StatementSync
    setTitle: StatementSync
  }

  /** `path` may be `:memory:`. Throws if the file is not a database this can use. */
  constructor (path: string) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA foreign_keys = ON')
      this.migrate()
      this.statements = {
        findPage: this.db.prepare('SELECT id FROM pages WHERE url = ?'),
        insertPage: this.db.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, ?, 1)'),
        touchPage: this.db.prepare('UPDATE pages SET last_visit = MAX(last_visit, ?), visit_count = visit_count + 1 WHERE id = ?'),
        insertVisit: this.db.prepare('INSERT INTO visits (page_id, at) VALUES (?, ?)'),
        setTitle: this.db.prepare('UPDATE pages SET title = ? WHERE url = ? AND title <> ?')
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate (): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    const version = row?.user_version ?? 0
    if (version > SCHEMA_VERSION) throw new Error(`the history file is from a newer version (${String(version)})`)
    if (version === SCHEMA_VERSION) return
    this.db.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        last_visit INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE visits (
        id INTEGER PRIMARY KEY,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        at INTEGER NOT NULL
      );
      CREATE INDEX visits_at ON visits (at);
      CREATE INDEX visits_page ON visits (page_id);
      CREATE INDEX pages_last_visit ON pages (last_visit DESC);
      PRAGMA user_version = ${String(SCHEMA_VERSION)};
    `)
  }

  record (url: string, title: string, at: number): void {
    if (url.length > MAX_URL_LENGTH) return
    this.enqueue({ type: 'visit', url, title: title.slice(0, MAX_TITLE_LENGTH), at })
  }

  setTitle (url: string, title: string): void {
    if (url.length > MAX_URL_LENGTH) return
    this.enqueue({ type: 'title', url, title: title.slice(0, MAX_TITLE_LENGTH) })
  }

  private enqueue (change: Change): void {
    this.queue.push(change)
    if (this.queue.length >= MAX_QUEUED) this.drain()
    else this.writer.schedule()
  }

  /** Writes every waiting change in one transaction. */
  private drain (): void {
    if (this.closed || this.queue.length === 0) return
    const changes = this.queue.splice(0)
    const { findPage, insertPage, touchPage, insertVisit, setTitle } = this.statements
    this.db.exec('BEGIN')
    try {
      for (const change of changes) {
        if (change.type === 'title') {
          setTitle.run(change.title, change.url, change.title)
          continue
        }
        const found = findPage.get(change.url) as { id: number } | undefined
        let id: number
        if (found === undefined) id = Number(insertPage.run(change.url, change.title, change.at).lastInsertRowid)
        else {
          id = found.id
          touchPage.run(change.at, id)
          if (change.title !== '') setTitle.run(change.title, change.url, change.title)
        }
        insertVisit.run(id, change.at)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list (query: HistoryQuery = {}): HistoryEntry[] {
    this.drain()
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE)
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (query.after !== undefined) {
      conditions.push('(last_visit < ? OR (last_visit = ? AND id < ?))')
      values.push(query.after.lastVisit, query.after.lastVisit, query.after.id)
    }
    const search = query.search?.trim() ?? ''
    if (search !== '') {
      conditions.push("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')")
      values.push(likePattern(search), likePattern(search))
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = this.db.prepare(`SELECT id, url, title, last_visit, visit_count FROM pages ${where} ORDER BY last_visit DESC, id DESC LIMIT ?`).all(...values, limit) as unknown as Row[]
    return rows.map(toEntry)
  }

  count (): number {
    this.drain()
    return (this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n
  }

  remove (id: number): void {
    this.drain()
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id)
  }

  removeRange (from: number, to: number): void {
    this.drain()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM visits WHERE at >= ? AND at <= ?').run(from, to)
      this.db.exec(`
        UPDATE pages SET
          visit_count = (SELECT COUNT(*) FROM visits WHERE page_id = pages.id),
          last_visit = COALESCE((SELECT MAX(at) FROM visits WHERE page_id = pages.id), 0);
        DELETE FROM pages WHERE visit_count = 0;
      `)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clear (): void {
    this.queue.length = 0
    this.db.exec('DELETE FROM visits; DELETE FROM pages;')
  }

  flush (): void {
    this.drain()
  }

  close (): void {
    if (this.closed) return
    try {
      this.drain()
    } finally {
      this.closed = true
      this.db.close()
    }
  }
}
