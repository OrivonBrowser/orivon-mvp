// History in one SQLite file. A page is a row, and each time it was reached is
// a row of its own, so a range of time can be forgotten without losing the
// pages visited outside it. Writes wait a moment and go in one transaction, so
// a page that redirects three times is one write, not three. Every statement
// this runs more than once is prepared once, in the constructor or on first
// use, and reused -- never re-prepared per call. A search of three characters
// or more probes how many rows a trigram FTS5 index would return for it: a
// sparse term is read through that index, a dense one (a common substring
// like "https://") through the LIKE scan instead, which walks the last-visit
// index and can stop at one page rather than gathering every match first.
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_TITLE_LENGTH, MAX_URL_LENGTH } from './history-store.js'
import type { HistoryEntry, HistoryQuery, HistoryStore } from './history-store.js'

const SCHEMA_VERSION = 2
const WRITE_DELAY_MS = 500
/** The most changes held while waiting to write; past it the oldest is written at once. */
const MAX_QUEUED = 500
/** The most pages kept. A page can make as many addresses as it likes, and the file must not grow with them: past this the
 * pages least recently visited go, down to nine tenths of it so the trimming is not done on every write. */
const MAX_PAGES = 100_000
/** How many new pages are written between looks at whether there are too many. */
const TRIM_CHECK_EVERY = 1000
/** Below this, the trigram index cannot resolve a match, so `list` keeps the plain `LIKE` scan. */
const FTS_MIN_SEARCH_LENGTH = 3
/** A term this common or more (probed before every FTS search) reads through `LIKE` instead: MATCH would
 * gather most of the table before ORDER BY/LIMIT could cut it off, where LIKE walks the last-visit index
 * and stops at one page. */
const FTS_DENSITY_LIMIT = 500

type Change =
  | { readonly type: 'visit', readonly url: string, readonly title: string, readonly at: number }
  | { readonly type: 'title', readonly url: string, readonly title: string }

interface Row { id: number, url: string, title: string, last_visit: number, visit_count: number }

const toEntry = (row: Row): HistoryEntry => ({ id: row.id, url: row.url, title: row.title, lastVisit: row.last_visit, visitCount: row.visit_count })

/** Escapes what LIKE would read as a pattern. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`

/** Escapes what FTS5's query syntax would read as a phrase delimiter, so `search` is matched
 * as the literal text it is -- never as MATCH syntax (AND, OR, NOT, column filters, `*`). */
const ftsPhrase = (text: string): string => `"${text.replace(/"/g, '""')}"`

const LIST_COLUMNS = 'id, url, title, last_visit, visit_count'
const LIST_ORDER = 'ORDER BY last_visit DESC, id DESC LIMIT ?'
const AFTER_CONDITION = '(last_visit < ? OR (last_visit = ? AND id < ?))'
const LIKE_CONDITION = "(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')"

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
    count: StatementSync
    trimDelete: StatementSync
    remove: StatementSync
    removeRangeDeleteVisits: StatementSync
    removeRangeUpdatePages: StatementSync
    removeRangeDeleteEmptyPages: StatementSync
    /** How many rows (up to `searchDensityLimit`) a trigram search would return: what `list` checks to choose
     * the FTS path or the LIKE fallback. */
    searchDensityProbe: StatementSync
    /** One per WHERE shape `list` can need: with or without `after`, and none/LIKE/FTS for `search`. */
    list: {
      plain: StatementSync
      after: StatementSync
      like: StatementSync
      likeAfter: StatementSync
      fts: StatementSync
      ftsAfter: StatementSync
    }
  }

  private readonly limits: { readonly maxPages: number, readonly checkEvery: number, readonly searchDensityLimit: number }

  /** `path` may be `:memory:`. Throws if the file is not a database this can use. `limits` is for tests: any
   * field left out keeps its production default. */
  constructor (path: string, limits: { readonly maxPages?: number, readonly checkEvery?: number, readonly searchDensityLimit?: number } = {}) {
    this.limits = {
      maxPages: limits.maxPages ?? MAX_PAGES,
      checkEvery: limits.checkEvery ?? TRIM_CHECK_EVERY,
      searchDensityLimit: limits.searchDensityLimit ?? FTS_DENSITY_LIMIT
    }
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
        setTitle: this.db.prepare('UPDATE pages SET title = ? WHERE url = ? AND title <> ?'),
        count: this.db.prepare('SELECT COUNT(*) AS n FROM pages'),
        trimDelete: this.db.prepare('DELETE FROM pages WHERE id IN (SELECT id FROM pages ORDER BY last_visit ASC, id ASC LIMIT ?)'),
        remove: this.db.prepare('DELETE FROM pages WHERE id = ?'),
        removeRangeDeleteVisits: this.db.prepare('DELETE FROM visits WHERE at >= ? AND at <= ?'),
        removeRangeUpdatePages: this.db.prepare(`
          UPDATE pages SET
            visit_count = (SELECT COUNT(*) FROM visits WHERE page_id = pages.id),
            last_visit = COALESCE((SELECT MAX(at) FROM visits WHERE page_id = pages.id), 0)
        `),
        removeRangeDeleteEmptyPages: this.db.prepare('DELETE FROM pages WHERE visit_count = 0'),
        searchDensityProbe: this.db.prepare(
          `SELECT COUNT(*) AS n FROM (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ? LIMIT ${String(this.limits.searchDensityLimit)})`
        ),
        list: {
          plain: this.db.prepare(`SELECT ${LIST_COLUMNS} FROM pages ${LIST_ORDER}`),
          after: this.db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${AFTER_CONDITION} ${LIST_ORDER}`),
          like: this.db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${LIKE_CONDITION} ${LIST_ORDER}`),
          likeAfter: this.db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${AFTER_CONDITION} AND ${LIKE_CONDITION} ${LIST_ORDER}`),
          fts: this.db.prepare(`
            SELECT p.id, p.url, p.title, p.last_visit, p.visit_count FROM pages p
            JOIN pages_fts f ON f.rowid = p.id WHERE pages_fts MATCH ?
            ORDER BY p.last_visit DESC, p.id DESC LIMIT ?
          `),
          ftsAfter: this.db.prepare(`
            SELECT p.id, p.url, p.title, p.last_visit, p.visit_count FROM pages p
            JOIN pages_fts f ON f.rowid = p.id
            WHERE (p.last_visit < ? OR (p.last_visit = ? AND p.id < ?)) AND pages_fts MATCH ?
            ORDER BY p.last_visit DESC, p.id DESC LIMIT ?
          `)
        }
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate (): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
    let version = row?.user_version ?? 0
    if (version > SCHEMA_VERSION) throw new Error(`the history file is from a newer version (${String(version)})`)
    if (version < 1) {
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
        PRAGMA user_version = 1;
      `)
      version = 1
    }
    if (version < 2) this.migrateToSearchIndex()
  }

  /** Adds the trigram FTS5 index over `pages(title, url)` and the triggers that keep it in step with every
   * insert, update and delete on `pages` -- including the bulk UPDATE/DELETE `removeRange` runs, which fire
   * the same row-level triggers as a single-row change. `content=` makes it an external-content table: the
   * text is never duplicated, only indexed, and `rebuild` builds that index from every row already there. */
  private migrateToSearchIndex (): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE pages_fts USING fts5(title, url, content='pages', content_rowid='id', tokenize='trigram');
        CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
          INSERT INTO pages_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
        END;
        CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
        END;
        CREATE TRIGGER pages_fts_au AFTER UPDATE ON pages WHEN old.title IS NOT new.title OR old.url IS NOT new.url BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
          INSERT INTO pages_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
        END;
        INSERT INTO pages_fts(pages_fts) VALUES ('rebuild');
        PRAGMA user_version = 2;
      `)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollback()
      throw error
    }
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
    const total = (this.statements.count.get() as { n: number }).n
    if (total <= this.limits.maxPages) return
    this.statements.trimDelete.run(total - Math.floor(this.limits.maxPages * 0.9))
  }

  list (query: HistoryQuery = {}): HistoryEntry[] {
    this.drain()
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE)
    const after = query.after
    const search = query.search?.trim() ?? ''
    let rows: Row[]
    if (search.length >= FTS_MIN_SEARCH_LENGTH) {
      const term = ftsPhrase(search)
      rows = this.isDense(term) ? this.queryLike(likePattern(search), after, limit) : this.queryFts(term, after, limit)
    } else if (search !== '') {
      rows = this.queryLike(likePattern(search), after, limit)
    } else {
      const { list } = this.statements
      rows = (after === undefined
        ? list.plain.all(limit)
        : list.after.all(after.lastVisit, after.lastVisit, after.id, limit)) as unknown as Row[]
    }
    return rows.map(toEntry)
  }

  /** Whether `term` (an already-escaped FTS phrase) would return `searchDensityLimit` rows or more: too many
   * for MATCH's join to sort and cut off with LIMIT as cheaply as the LIKE scan, which stops at one page.
   * Ignores `after`: it estimates how common the term is, not how many pages of it remain. */
  private isDense (term: string): boolean {
    return (this.statements.searchDensityProbe.get(term) as { n: number }).n >= this.limits.searchDensityLimit
  }

  private queryLike (pattern: string, after: HistoryQuery['after'], limit: number): Row[] {
    const { list } = this.statements
    return (after === undefined
      ? list.like.all(pattern, pattern, limit)
      : list.likeAfter.all(after.lastVisit, after.lastVisit, after.id, pattern, pattern, limit)) as unknown as Row[]
  }

  private queryFts (term: string, after: HistoryQuery['after'], limit: number): Row[] {
    const { list } = this.statements
    return (after === undefined
      ? list.fts.all(term, limit)
      : list.ftsAfter.all(after.lastVisit, after.lastVisit, after.id, term, limit)) as unknown as Row[]
  }

  count (): number {
    this.drain()
    return (this.statements.count.get() as { n: number }).n
  }

  remove (id: number): void {
    this.drain()
    this.statements.remove.run(id)
  }

  removeRange (from: number, to: number): void {
    this.drain()
    this.db.exec('BEGIN')
    try {
      this.statements.removeRangeDeleteVisits.run(from, to)
      this.statements.removeRangeUpdatePages.run()
      this.statements.removeRangeDeleteEmptyPages.run()
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
