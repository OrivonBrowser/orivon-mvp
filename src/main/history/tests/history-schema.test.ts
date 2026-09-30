import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryService } from '../history-service.js'
import { NullHistoryStore } from '../history-store.js'
import { SCHEMA_VERSION, migrate } from '../history-schema.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const A = 'https://a.example/'

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)

describe('the history file schema', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-history-schema-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('is version 3, and a new file is created at it, with the typed count and the favicons table', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(SCHEMA_VERSION).toBe(3)
    expect(version(db)).toBe(3)
    expect(columns(db, 'pages')).toContain('typed_count')
    expect(columns(db, 'favicons')).toEqual(['host', 'data', 'updated'])
    db.close()
  })

  it('opens a version 2 file as version 3 with every row intact, and can search and list it', () => {
    const file = join(dir, 'history.db')
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', last_visit INTEGER NOT NULL, visit_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE visits (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE, at INTEGER NOT NULL);
      CREATE INDEX visits_at ON visits (at);
      CREATE INDEX visits_page ON visits (page_id);
      CREATE INDEX pages_last_visit ON pages (last_visit DESC);
      CREATE VIRTUAL TABLE pages_fts USING fts5(title, url, content='pages', content_rowid='id', tokenize='trigram');
      INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1);
      CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN INSERT INTO pages_fts(rowid, title, url) VALUES (new.id, new.title, new.url); END;
      CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN INSERT INTO pages_fts(pages_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url); END;
      CREATE TRIGGER pages_fts_au AFTER UPDATE ON pages WHEN old.title IS NOT new.title OR old.url IS NOT new.url BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
        INSERT INTO pages_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
      END;
      PRAGMA user_version = 2;
    `)
    old.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, ?, 2)').run(A, 'Kept Alpha', 1000)
    old.prepare('INSERT INTO visits (page_id, at) VALUES (1, 900), (1, 1000)').run()
    old.close()

    const history = new SqliteHistoryStore(file)
    expect(history.list()).toEqual([expect.objectContaining({ url: A, title: 'Kept Alpha', lastVisit: 1000, visitCount: 2 })])
    expect(history.list({ search: 'Alpha' }).map((entry) => entry.url)).toEqual([A])
    const db = (history as unknown as { db: DatabaseSync }).db
    expect(version(db)).toBe(3)
    expect((db.prepare('SELECT typed_count FROM pages').get() as { typed_count: number }).typed_count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: number }).n).toBe(2)
    history.close()
  })

  it('refuses a file from a newer version and leaves it as it was', () => {
    const file = join(dir, 'history.db')
    const other = new DatabaseSync(file)
    other.exec('PRAGMA user_version = 99')
    other.close()
    expect(() => new SqliteHistoryStore(file)).toThrow(/newer version/)
    const again = new DatabaseSync(file)
    expect(version(again)).toBe(99)
    again.close()
  })
})

describe('the members the History page and the importer will fill', () => {
  it('answer empty until their lane lands, on the file store and on the null store', () => {
    for (const history of [new SqliteHistoryStore(':memory:'), new NullHistoryStore()]) {
      history.record(A, 'A', 1)
      expect(() => { history.markTyped(A) }).not.toThrow()
      expect(() => { history.setFavicon('a.example', 'data:image/png;base64,AA==') }).not.toThrow()
      expect(history.faviconsFor(['a.example'])).toEqual({})
      expect(() => { history.pruneFavicons() }).not.toThrow()
      expect(history.listOrdered({ order: 'title', offset: 0 })).toEqual([])
      expect(history.importPages([{ url: A, title: 'A', lastVisit: 1, visitCount: 1 }])).toBe(0)
      history.close()
    }
  })

  it('reaches the service the same way, and tells its listeners only when an import added pages', () => {
    const store = new SqliteHistoryStore(':memory:')
    const service = new HistoryService(store, { get: (() => true) as never, onChange: () => () => {} })
    const changes: string[] = []
    service.onChange((change) => { changes.push(change) })
    expect(service.suggest('a', 3)).toEqual([])
    expect(service.listOrdered()).toEqual([])
    expect(service.faviconsFor([])).toEqual({})
    expect(service.importPages([])).toBe(0)
    expect(changes).toEqual([])
    store.close()
  })
})
