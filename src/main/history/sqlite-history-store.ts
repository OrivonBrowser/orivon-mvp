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
/** The most pages kept. A page can make as many addresses as it likes, and the file must not grow with them: past this the
 * pages least recently visited go, down to nine tenths of it so the trimming is not done on every write. */
const MAX_PAGES = 100_000
/** How many new pages are written between looks at whether there are too many. */
const TRIM_CHECK_EVERY = 1000

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
  private newPagesSinceCheck = 0
  private readonly queue: Change[] = []
  private readonly writer = new DebouncedWriter(async () => { this.drain() }, WRITE_DELAY_MS)
  private readonly statements: {
    findPage: StatementSync
    insertPage: StatementSync
    touchPage: StatementSync
    insertVisit: StatementSync
    setTitle: StatementSync
  }

  /** `path` may be `:memory:`. Throws if the file is not a database this can use. `limits` is for tests. */
  constructor (path: string, private readonly limits: { readonly maxPages: number, readonly checkEvery: number } = { maxPages: MAX_PAGES, checkEvery: TRIM_CHECK_EVERY }) {
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA foreign_keys = ON')
      // Forgotten addresses are overwritten, not only unlisted: what a person clears should not sit readable in the file.
      this.db.exec('PRAGMA secure_delete = ON')
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

  /** Writes every waiting change in one transaction. It is called from event handlers and from every read, so a failure
   * (a full disk, a damaged page) is reported and the changes it held are dropped: history is not worth ending the browser for. */
  private drain (): void {
    if (this.closed || this.queue.length === 0) return
    const changes = this.queue.splice(0)
    const { findPage, insertPage, touchPage, insertVisit, setTitle } = this.statements
    try {
      this.db.exec('BEGIN')
      for (const change of changes) {
        if (change.type === 'title') {
          setTitle.run(change.title, change.url, change.title)
          continue
        }
        const found = findPage.get(change.url) as { id: number } | undefined
        let id: number
        if (found === undefined) {
          id = Number(insertPage.run(change.url, change.title, change.at).lastInsertRowid)
          this.newPagesSinceCheck += 1
        } else {
          id = found.id
          touchPage.run(change.at, id)
          if (change.title !== '') setTitle.run(change.title, change.url, change.title)
        }
        insertVisit.run(id, change.at)
      }
      this.db.exec('COMMIT')
      if (this.newPagesSinceCheck >= this.limits.checkEvery) this.trim()
    } catch (error) {
      this.rollback()
      console.error('[orivon] history could not be written:', error)
    }
  }

  private rollback (): void {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // No transaction was open: the failure was before BEGIN.
    }
  }

  /** Forgets the pages least recently visited when there are more than are kept. */
  private trim (): void {
    this.newPagesSinceCheck = 0
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n
    if (total <= this.limits.maxPages) return
    this.db.prepare('DELETE FROM pages WHERE id IN (SELECT id FROM pages ORDER BY last_visit ASC, id ASC LIMIT ?)').run(total - Math.floor(this.limits.maxPages * 0.9))
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
      this.rollback()
      throw error
    }
    this.dropLog()
  }

  clear (): void {
    this.queue.length = 0
    this.db.exec('DELETE FROM visits; DELETE FROM pages;')
    this.dropLog()
    // Rewrites the file so the space the addresses were in is not left behind.
    this.db.exec('VACUUM')
  }

  /** Moves what the write-ahead log still holds of forgotten rows into the file, where they were overwritten, and empties the log. */
  private dropLog (): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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
