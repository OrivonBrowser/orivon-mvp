import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from '../history-store.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const A = 'https://a.example/'
const B = 'https://b.example/page'

const store = (): SqliteHistoryStore => new SqliteHistoryStore(':memory:')

/** pages_fts_data's own footprint: a trigram tokenizer never stores more than three original characters
 * contiguously, so there is no literal substring to grep for, but a forgotten row's postings that are not
 * actually erased (no secure-delete, or a bulk path that does not truly drop and rebuild) leave bytes here
 * that a row erased cleanly does not. */
function ftsDataFootprint (path: string): number {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare('SELECT SUM(LENGTH(block)) AS n FROM pages_fts_data').get() as { n: number | null }).n ?? 0
  } finally {
    db.close()
  }
}

describe('the SQLite history store', () => {
  it('keeps a page once, with how many times and when it was last reached', () => {
    const history = store()
    history.record(A, 'A', 1000)
    history.record(B, 'B', 2000)
    history.record(A, 'A', 3000)
    expect(history.list()).toEqual([
      expect.objectContaining({ url: A, title: 'A', lastVisit: 3000, visitCount: 2 }),
      expect.objectContaining({ url: B, title: 'B', lastVisit: 2000, visitCount: 1 })
    ])
    expect(history.count()).toBe(2)
  })

  it('takes the title a page settles on, and keeps the old one when a visit has none', () => {
    const history = store()
    history.record(A, '', 1000)
    history.setTitle(A, 'Loaded title')
    history.record(A, '', 2000)
    expect(history.list()[0]).toMatchObject({ title: 'Loaded title', visitCount: 2 })
  })

  it('finds by part of the title or the address without regard to case, and never reads a % or _ as a pattern', () => {
    const history = store()
    history.record('https://docs.example/guide', 'The Orivon Guide', 1)
    history.record('https://other.example/100%_done', 'Progress', 2)
    history.record('https://other.example/plain', 'Plain', 3)
    expect(history.list({ search: 'orivon' }).map((entry) => entry.title)).toEqual(['The Orivon Guide'])
    expect(history.list({ search: 'DOCS.example' }).map((entry) => entry.title)).toEqual(['The Orivon Guide'])
    expect(history.list({ search: '100%_' }).map((entry) => entry.title)).toEqual(['Progress'])
    expect(history.list({ search: '%' }).map((entry) => entry.title)).toEqual(['Progress'])
    expect(history.list({ search: '   ' })).toHaveLength(3)
  })

  it('pages through the list without skipping or repeating a page reached in the same instant', () => {
    const history = store()
    for (let n = 0; n < 7; n += 1) history.record(`https://site${String(n)}.example/`, `Site ${String(n)}`, n < 4 ? 100 : 200 + n)
    const seen: string[] = []
    let after: { lastVisit: number, id: number } | undefined
    for (;;) {
      const page = history.list({ limit: 3, ...(after === undefined ? {} : { after }) })
      if (page.length === 0) break
      seen.push(...page.map((entry) => entry.url))
      const last = page.at(-1)
      if (last === undefined) break
      after = { lastVisit: last.lastVisit, id: last.id }
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('forgets one page with its visits', () => {
    const history = store()
    history.record(A, 'A', 1)
    history.record(B, 'B', 2)
    history.remove(history.list().find((entry) => entry.url === A)?.id ?? -1)
    expect(history.list().map((entry) => entry.url)).toEqual([B])
  })

  it('forgets a range of time, keeps what lies outside it, and recounts a page that straddles it', () => {
    const history = store()
    history.record(A, 'A', 1000)
    history.record(A, 'A', 5000)
    history.record(B, 'B', 3000)
    history.removeRange(2000, 4000)
    expect(history.list()).toEqual([
      expect.objectContaining({ url: A, lastVisit: 5000, visitCount: 2 })
    ])
    history.removeRange(4500, 6000)
    expect(history.list()).toEqual([expect.objectContaining({ url: A, lastVisit: 1000, visitCount: 1 })])
    history.removeRange(0, 10_000)
    expect(history.count()).toBe(0)
  })

  it('forgets everything, including what has not been written yet', () => {
    const history = store()
    history.record(A, 'A', 1)
    history.clear()
    expect(history.count()).toBe(0)
    history.record(B, 'B', 2)
    expect(history.count()).toBe(1)
  })

  it('refuses an address that is too long and cuts a title that is', () => {
    const history = store()
    history.record(`https://a.example/${'x'.repeat(MAX_URL_LENGTH)}`, 'Long', 1)
    history.record(A, 'T'.repeat(MAX_TITLE_LENGTH + 50), 2)
    const [entry] = history.list()
    expect(history.count()).toBe(1)
    expect(entry?.title).toHaveLength(MAX_TITLE_LENGTH)
  })

  it('keeps writing when a great many visits arrive at once', () => {
    const history = store()
    for (let n = 0; n < 1200; n += 1) history.record(`https://site${String(n % 300)}.example/`, '', n)
    expect(history.count()).toBe(300)
    expect(history.list({ limit: 1000 }).reduce((total, entry) => total + entry.visitCount, 0)).toBe(1200)
  })

  it('caches one prepared statement per WHERE shape of list(), instead of preparing SQL on every call', () => {
    const history = store()
    history.record(A, 'Alpha', 1000)
    history.record(B, 'Beta', 2000)
    history.flush()

    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare')
    for (let n = 0; n < 5; n += 1) {
      history.count()
      history.list()
      history.list({ after: { lastVisit: 2000, id: 1 } })
      history.list({ search: 'al' }) // under three characters: the LIKE path
      history.list({ search: 'al', after: { lastVisit: 2000, id: 1 } })
      history.list({ search: 'alpha' }) // three characters or more: the FTS path
      history.list({ search: 'alpha', after: { lastVisit: 2000, id: 1 } })
    }
    expect(prepareSpy).not.toHaveBeenCalled()
    prepareSpy.mockRestore()
  })
})

describe('search: substrings, case, literal % and _, agreement between the FTS and LIKE paths', () => {
  it('a search of three characters or more finds what the old unindexed LIKE search would', () => {
    const history = store()
    const pages: Array<[string, string]> = [
      [A, 'Weekly Review'],
      [B, 'Deploy Notes'],
      ['https://c.example/', 'Coffee and Cream'],
      ['https://d.example/100%_done', 'Progress Update'],
      ['https://e.example/plain', 'Plain Page']
    ]
    pages.forEach(([url, title], index) => history.record(url, title, index))
    history.flush()

    const db = (history as unknown as { db: DatabaseSync }).db
    const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    for (const term of ['dep', 'WEEKLY', 'coffee', '100%_', 'notes', 'xyz-nomatch']) {
      const viaSearch = history.list({ search: term }).map((entry) => entry.id).sort()
      const viaLike = (db.prepare("SELECT id FROM pages WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'")
        .all(likePattern(term), likePattern(term)) as Array<{ id: number }>).map((row) => row.id).sort()
      expect(viaSearch, term).toEqual(viaLike)
    }
  })

  it('a page removed, or whose visits are all forgotten by a range, drops out of search', () => {
    const history = store()
    history.record(A, 'Searchable Alpha', 1000)
    history.record(B, 'Searchable Beta', 2000)
    expect(history.list({ search: 'searchable' }).map((entry) => entry.url).sort()).toEqual([A, B].sort())

    const alphaId = history.list().find((entry) => entry.url === A)?.id ?? -1
    history.remove(alphaId)
    expect(history.list({ search: 'searchable' }).map((entry) => entry.url)).toEqual([B])

    history.removeRange(0, 10_000)
    expect(history.list({ search: 'searchable' })).toEqual([])
  })

  it('counts Unicode characters, not UTF-16 code units, deciding whether a search reaches the FTS threshold', () => {
    // '😀x' is two characters but three UTF-16 code units (the emoji is a surrogate pair): .length says 3,
    // [...search].length says 2. At three code units the old check wrongly took the FTS path, where the
    // trigram tokenizer -- needing three actual characters -- never matches a two-character query.
    const history = store()
    history.record('https://a.example/emoji', 'A page titled 😀x here', 1000)
    expect(history.list({ search: '😀x' }).map((entry) => entry.title)).toEqual(['A page titled 😀x here'])
  })

  it('folds case the way LIKE does (ASCII only), the same on the FTS-accelerated path as on the forced LIKE path', () => {
    // LIKE folds only ASCII a-z/A-Z; the trigram tokenizer folds Unicode, so ' cole' (lowercase e-acute)
    // would match "cole" (title's E-acute) through FTS but not through a bare LIKE. Since FTS is meant to
    // be an accelerator, not a second definition of "matches", searching for it should find nothing either
    // way -- LIKE's fold decides, whichever path actually ran the query.
    const accented = 'École Française'
    const upper = 'ÉCOLE' // ASCII-fold of the rest of the word still applies; only the accented letter itself differs by case
    const lower = 'école'

    const sparse = store() // default threshold: plenty of headroom to stay on the FTS-accelerated path
    sparse.record('https://a.example/', accented, 1000)
    expect(sparse.list({ search: upper }).map((entry) => entry.title)).toEqual([accented])
    expect(sparse.list({ search: lower }).map((entry) => entry.title)).toEqual([])

    const dense = new SqliteHistoryStore(':memory:', { searchDensityLimit: 0 }) // forces every search dense: the LIKE fallback
    dense.record('https://a.example/', accented, 1000)
    expect(dense.list({ search: upper }).map((entry) => entry.title)).toEqual([accented])
    expect(dense.list({ search: lower }).map((entry) => entry.title)).toEqual([])
  })

  /** Runs the same query list() runs, but as one plain LIKE statement -- the thing both the sparse (FTS) and
   * dense (LIKE fallback) paths are checked against, so the check does not depend on which path list() took. */
  function rawLike (db: DatabaseSync, term: string, after?: { lastVisit: number, id: number }): number[] {
    const pattern = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    const where = after === undefined
      ? "(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')"
      : "(last_visit < ? OR (last_visit = ? AND id < ?)) AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')"
    const params = after === undefined ? [pattern, pattern] : [after.lastVisit, after.lastVisit, after.id, pattern, pattern]
    return (db.prepare(`SELECT id FROM pages WHERE ${where} ORDER BY last_visit DESC, id DESC LIMIT 200`).all(...params) as Array<{ id: number }>)
      .map((row) => row.id)
  }

  /** The statements object is private; tests reach it to spy on which one a call actually reached -- proof
   * the equivalence checks below exercise the path they claim to, not two paths that happen to agree. */
  function statementsOf (history: SqliteHistoryStore): { list: { fts: StatementSync, like: StatementSync } } {
    return (history as unknown as { statements: { list: { fts: StatementSync, like: StatementSync } } }).statements
  }

  it('a sparse term (below the density threshold) returns what a raw LIKE query would, with and without after, reading it through the FTS join', () => {
    const history = store()
    history.record(A, 'Weekly Review', 1000)
    history.record(B, 'Monthly Review', 2000)
    history.record('https://c.example/', 'Quarterly Review', 3000)
    history.record('https://d.example/', 'Unrelated', 4000)
    history.flush()
    const db = (history as unknown as { db: DatabaseSync }).db
    const { fts, like } = statementsOf(history).list
    const ftsSpy = vi.spyOn(fts, 'all')
    const likeSpy = vi.spyOn(like, 'all')

    expect(history.list({ search: 'review' }).map((entry) => entry.id).sort())
      .toEqual(rawLike(db, 'review').sort())

    const after = { lastVisit: 3000, id: history.list().find((entry) => entry.lastVisit === 3000)?.id ?? -1 }
    expect(history.list({ search: 'review', after }).map((entry) => entry.id))
      .toEqual(rawLike(db, 'review', after))

    expect(ftsSpy).toHaveBeenCalledTimes(1) // the plain history.list() above; `after` uses ftsAfter instead
    expect(likeSpy).not.toHaveBeenCalled()
    ftsSpy.mockRestore()
    likeSpy.mockRestore()
  })

  it('a dense term (at or above the density threshold) returns what a raw LIKE query would, with and without after, reading it through the LIKE fallback', () => {
    // With the threshold lowered to 5, six pages sharing "common" make the term dense: the probe (LIMIT 5)
    // finds 5 without exhausting the true count, so list() takes the LIKE fallback instead of the FTS join.
    const history = new SqliteHistoryStore(':memory:', { searchDensityLimit: 5 })
    for (let n = 0; n < 6; n += 1) history.record(`https://site${String(n)}.example/`, `Common Page ${String(n)}`, 1000 + n)
    history.record('https://other.example/', 'Something else', 5000)
    history.flush()
    const db = (history as unknown as { db: DatabaseSync }).db
    const { fts, like } = statementsOf(history).list
    const ftsSpy = vi.spyOn(fts, 'all')
    const likeSpy = vi.spyOn(like, 'all')

    expect(history.list({ search: 'common' }).map((entry) => entry.id).sort())
      .toEqual(rawLike(db, 'common').sort())

    const after = { lastVisit: 1003, id: history.list().find((entry) => entry.lastVisit === 1003)?.id ?? -1 }
    expect(history.list({ search: 'common', after }).map((entry) => entry.id))
      .toEqual(rawLike(db, 'common', after))

    expect(likeSpy).toHaveBeenCalledTimes(1) // the plain history.list() above; `after` uses likeAfter instead
    expect(ftsSpy).not.toHaveBeenCalled()
    ftsSpy.mockRestore()
    likeSpy.mockRestore()
  })

  it('the dense (LIKE fallback) path still pages correctly: no page skips or repeats a match', () => {
    const history = new SqliteHistoryStore(':memory:', { searchDensityLimit: 5 })
    for (let n = 0; n < 20; n += 1) history.record(`https://site${String(n)}.example/`, `Common Page ${String(n)}`, 1000 + n)
    history.flush()

    const seen: number[] = []
    let after: { lastVisit: number, id: number } | undefined
    for (;;) {
      const page = history.list({ search: 'common', limit: 3, ...(after === undefined ? {} : { after }) })
      if (page.length === 0) break
      seen.push(...page.map((entry) => entry.id))
      const last = page.at(-1)
      if (last === undefined) break
      after = { lastVisit: last.lastVisit, id: last.id }
    }
    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
  })
})

describe('the history file', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-history-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('keeps what was written after it is closed and opened again', () => {
    const file = join(dir, 'history.db')
    const first = new SqliteHistoryStore(file)
    first.record(A, 'A', 1)
    first.close()
    const second = new SqliteHistoryStore(file)
    expect(second.list()).toEqual([expect.objectContaining({ url: A, title: 'A' })])
    second.close()
  })

  it('upgrades a database written before the search index existed, and can search it once opened', () => {
    const file = join(dir, 'history.db')
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', last_visit INTEGER NOT NULL, visit_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE visits (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE, at INTEGER NOT NULL);
      CREATE INDEX visits_at ON visits (at);
      CREATE INDEX visits_page ON visits (page_id);
      CREATE INDEX pages_last_visit ON pages (last_visit DESC);
      PRAGMA user_version = 1;
    `)
    old.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, ?, 1)').run(A, 'Preexisting Alpha', 1000)
    old.prepare('INSERT INTO visits (page_id, at) VALUES (1, 1000)').run()
    old.close()

    const history = new SqliteHistoryStore(file)
    expect(history.list({ search: 'existing' }).map((entry) => entry.url)).toEqual([A])

    const db = (history as unknown as { db: DatabaseSync }).db
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(2)
    expect((db.prepare("SELECT rowid FROM pages_fts WHERE pages_fts MATCH '\"existing\"'").all() as unknown[]).length).toBe(1)
    history.close()
  })

  it('is left as it was when it is not a database this can use', async () => {
    const file = join(dir, 'history.db')
    await writeFile(file, 'this is not a database, it is a shopping list'.repeat(50))
    expect(() => new SqliteHistoryStore(file)).toThrow()
  })

  it('is refused when it comes from a newer version', () => {
    const file = join(dir, 'history.db')
    const other = new DatabaseSync(file)
    other.exec('PRAGMA user_version = 99')
    other.close()
    expect(() => new SqliteHistoryStore(file)).toThrow(/newer version/)
  })

  it('does nothing further once closed', () => {
    const history = new SqliteHistoryStore(join(dir, 'history.db'))
    history.record(A, 'A', 1)
    history.close()
    expect(() => { history.flush() }).not.toThrow()
    expect(() => { history.close() }).not.toThrow()
  })
})

describe('a store that cannot write', () => {
  it('reports it and goes on, so that a failing write is never an uncaught exception in an event handler', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const history = store()
    ;(history as unknown as { db: DatabaseSync }).db.exec('DROP TABLE visits')

    history.record(A, 'A', 1)
    expect(() => { history.flush() }).not.toThrow()
    expect(complaint).toHaveBeenCalled()
    expect(() => { history.record(B, 'B', 2); history.flush() }).not.toThrow()
    complaint.mockRestore()
  })
})

describe('a store with too many pages', () => {
  it('forgets the pages visited longest ago and keeps the newest', () => {
    const history = new SqliteHistoryStore(':memory:', { maxPages: 100, checkEvery: 10 })
    for (let n = 0; n < 130; n += 1) history.record(`https://a.example/${String(n)}`, '', 1000 + n)
    history.flush()

    const urls = history.list({ limit: 500 }).map((entry) => entry.url)
    expect(urls.length).toBeLessThanOrEqual(100)
    expect(urls.length).toBeGreaterThanOrEqual(80)
    expect(urls[0]).toBe('https://a.example/129')
    expect(urls).not.toContain('https://a.example/0')
  })
})

describe('what clearing leaves in the file', () => {
  it('is none of the addresses that were cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orivon-history-file-'))
    try {
      const path = join(dir, 'history.db')
      const history = new SqliteHistoryStore(path)
      for (let n = 0; n < 50; n += 1) history.record(`https://visited-marker.example/${String(n)}`, 'a title to forget', n)
      history.flush()
      history.clear()
      history.close()

      for (const name of ['history.db', 'history.db-wal']) {
        const bytes = await readFile(join(dir, name)).catch(() => Buffer.alloc(0))
        expect(bytes.includes('visited-marker'), name).toBe(false)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is none of a single page remove() forgot either, and not only once the store is closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orivon-history-remove-wal-'))
    try {
      const path = join(dir, 'history.db')
      const history = new SqliteHistoryStore(path)
      history.record('https://a.example/visited-marker', 'A title to forget', 1000)
      history.flush()
      const id = history.list()[0]?.id ?? -1
      history.remove(id)
      // Checked while the store is still open -- remove() must checkpoint the WAL itself, the way
      // removeRange() and clear() already do, rather than leaving a forgotten page there until close().
      for (const name of ['history.db', 'history.db-wal']) {
        const bytes = await readFile(join(dir, name)).catch(() => Buffer.alloc(0))
        expect(bytes.includes('visited-marker'), name).toBe(false)
      }
      history.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('what forgetting a page leaves in the FTS5 index', () => {
  // FTS5's ordinary delete, on an external-content table, only writes a tombstone into the segment
  // b-tree; the original posting -- which trigrams a now-forgotten rowid had -- stays in already-allocated
  // pages until a later merge discards it, so `secure_delete`/VACUUM on the surrounding pages/visits
  // tables (proven above) does nothing for it. `pages_fts(pages_fts, rank) VALUES('secure-delete', 1)`,
  // set once in the v2 migration, makes FTS5 erase the posting itself at delete time instead. It has no
  // literal substring to grep for (a trigram tokenizer never stores more than three original characters
  // contiguously), so what this checks instead is pages_fts_data's own footprint: with the tombstone left
  // behind, forgotten rows accumulate bytes there indefinitely; with secure-delete, forgetting a row costs
  // it nothing, so the shadow table stays near its empty, structural size however many rows were forgotten.
  const NEAR_EMPTY_FOOTPRINT = 2000

  async function forgetsCleanly (name: string, rows: number, forget: (history: SqliteHistoryStore) => void): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), `orivon-history-fts-privacy-${name}-`))
    try {
      const path = join(dir, 'history.db')
      const history = new SqliteHistoryStore(path)
      for (let n = 0; n < rows; n += 1) history.record(`https://churn${String(n)}.example/marker${String(n)}`, `Churn Title ${String(n)}`, n)
      history.flush()
      forget(history)
      history.close()
      expect(ftsDataFootprint(path), name).toBeLessThan(NEAR_EMPTY_FOOTPRINT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('remove(), one page at a time, does not accumulate stale postings', async () => {
    // Fewer rows than the other two below: remove() now checkpoints the WAL on every call (dropLog(), the
    // same as removeRange()/clear()), so this one pays that cost once per page rather than once overall.
    await forgetsCleanly('remove', 60, (history) => {
      for (const entry of history.list({ limit: 60 })) history.remove(entry.id)
    })
  }, 15_000)

  it('removeRange(), over everything, does not accumulate stale postings', async () => {
    await forgetsCleanly('removeRange', 400, (history) => { history.removeRange(0, 10_000) })
  })

  it('clear() does not accumulate stale postings', async () => {
    await forgetsCleanly('clear', 400, (history) => { history.clear() })
  })
})

describe('the bulk delete path (dropping and rebuilding the FTS5 index, instead of the per-row trigger)', () => {
  const NEAR_EMPTY_FOOTPRINT = 2000

  function rawLike (db: DatabaseSync, term: string): number[] {
    const pattern = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    return (db.prepare("SELECT id FROM pages WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'")
      .all(pattern, pattern) as Array<{ id: number }>).map((row) => row.id).sort()
  }

  it('a bulk delete (forced, with plenty of rows left over) leaves no more behind than starting fresh with just the survivors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orivon-history-bulk-privacy-'))
    try {
      const path = join(dir, 'history.db')
      // Ratio 1: bulk as soon as toDelete alone exceeds what remains, not just when nothing remains --
      // deleting 200 of 300 (100 left) clears that bar and still leaves most of the table in place, so the
      // 100 rows that survive still cost real index bytes; what this checks is that the 200 forgotten ones
      // do not cost anything on top of that.
      const history = new SqliteHistoryStore(path, { bulkDeleteRowRatio: 1 })
      for (let n = 0; n < 300; n += 1) history.record(`https://churn${String(n)}.example/marker${String(n)}`, `Churn Title ${String(n)}`, n)
      history.flush()
      history.removeRange(0, 199) // deletes the earliest 200 of 300 -- 100 remain, comfortably bulk at ratio 1
      expect(history.count()).toBe(100)
      history.close()

      const freshDir = await mkdtemp(join(tmpdir(), 'orivon-history-bulk-privacy-fresh-'))
      try {
        const freshPath = join(freshDir, 'history.db')
        const fresh = new SqliteHistoryStore(freshPath)
        for (let n = 200; n < 300; n += 1) fresh.record(`https://churn${String(n)}.example/marker${String(n)}`, `Churn Title ${String(n)}`, n)
        fresh.flush()
        fresh.close()
        // Some slack for structural/segment-count differences unrelated to the 200 forgotten rows; the
        // stale-tombstone leak this guards against is one order of magnitude, not a few hundred bytes.
        expect(ftsDataFootprint(path)).toBeLessThan(ftsDataFootprint(freshPath) * 2)
      } finally {
        await rm(freshDir, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a clear of many pages leaves pages_fts empty, and a page recorded afterward is still searchable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orivon-history-bulk-clear-'))
    try {
      const path = join(dir, 'history.db')
      const history = new SqliteHistoryStore(path)
      for (let n = 0; n < 1000; n += 1) history.record(`https://churn${String(n)}.example/marker${String(n)}`, `Churn Title ${String(n)}`, n)
      history.flush()
      history.clear()
      expect(history.count()).toBe(0)
      expect(history.list({ search: 'churn' })).toEqual([])

      history.record('https://after.example/', 'Recorded After Clearing', 5000)
      history.flush()
      expect(history.list({ search: 'recorded' }).map((entry) => entry.url)).toEqual(['https://after.example/'])

      history.close()
      expect(ftsDataFootprint(path)).toBeLessThan(NEAR_EMPTY_FOOTPRINT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a bulk removeRange and a per-row removeRange give the same search results as a raw LIKE query', () => {
    const build = (bulkDeleteRowRatio: number): SqliteHistoryStore => {
      const history = new SqliteHistoryStore(':memory:', { bulkDeleteRowRatio })
      for (let n = 0; n < 300; n += 1) history.record(`https://site${String(n)}.example/`, `Common Marker ${String(n)}`, n)
      history.flush()
      return history
    }
    // Ratio 1 makes any nonzero delete against fewer remaining rows bulk; ratio 1,000,000 makes the same
    // delete stay per-row (no realistic toDelete clears that bar).
    const bulk = build(1)
    const perRow = build(1_000_000)
    for (const history of [bulk, perRow]) history.removeRange(0, 199) // both remove the same 200 of 300

    const db = (bulk as unknown as { db: DatabaseSync }).db
    const expected = rawLike(db, 'marker')
    expect(bulk.list({ search: 'marker', limit: 500 }).map((entry) => entry.id).sort()).toEqual(expected)
    expect(perRow.list({ search: 'marker', limit: 500 }).map((entry) => entry.id).sort()).toEqual(expected)
  })

  it('the FTS index never disagrees with pages, through either delete path, including trim()', () => {
    // maxPages/checkEvery small enough that recording past 150 pages makes trim() fire for real (private,
    // reached only through record()/flush() -- not called directly); bulkDeleteRowRatio 1 forces its
    // delete, and remove()'s and removeRange()'s below, onto the bulk path whenever there is anything to
    // delete at all.
    const history = new SqliteHistoryStore(':memory:', { maxPages: 150, checkEvery: 10, bulkDeleteRowRatio: 1 })
    for (let n = 0; n < 200; n += 1) history.record(`https://site${String(n)}.example/`, `Word${String(n % 7)} Title ${String(n)}`, n)
    history.flush()
    expect(history.count()).toBeLessThanOrEqual(150) // trim() already ran during the recording above

    history.remove(history.list()[0]?.id ?? -1) // a single id, not through removeRange/trim/clear
    history.removeRange(120, 160)

    const db = (history as unknown as { db: DatabaseSync }).db
    for (const term of ['word0', 'word3', 'word6', 'title']) {
      expect(history.list({ search: term, limit: 500 }).map((entry) => entry.id).sort(), term)
        .toEqual(rawLike(db, term))
    }
  })
})
