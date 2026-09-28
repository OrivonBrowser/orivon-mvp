import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from '../history-store.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const A = 'https://a.example/'
const B = 'https://b.example/page'

const store = (): SqliteHistoryStore => new SqliteHistoryStore(':memory:')

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
})
