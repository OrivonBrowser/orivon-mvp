import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryService } from '../history-service.js'
import { NullHistoryStore } from '../history-store.js'
import { markPageTyped, suggestPages } from '../history-suggest.js'
import { migrate } from '../history-schema.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

function memory (): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

function add (db: DatabaseSync, url: string, title: string, visits: number, lastVisit: number, typed = 0): void {
  db.prepare('INSERT INTO pages (url, title, last_visit, visit_count, typed_count) VALUES (?, ?, ?, ?, ?)').run(url, title, lastVisit, visits, typed)
}

describe('suggestPages', () => {
  it('finds pages whose address or title contain the text, without regard to case', () => {
    const db = memory()
    add(db, 'https://example.com/', 'Nothing', 1, 1)
    add(db, 'https://other.org/', 'An EXAMPLE title', 1, 2)
    add(db, 'https://unrelated.net/', 'Nope', 1, 3)
    expect(suggestPages(db, 'exam', 10).map((page) => page.url).sort()).toEqual(['https://example.com/', 'https://other.org/'])
  })

  it('needs every word, each anywhere in the address or the title', () => {
    const db = memory()
    add(db, 'https://docs.example.com/a', 'Guide to cats', 1, 1)
    add(db, 'https://docs.example.com/b', 'Guide to dogs', 1, 2)
    expect(suggestPages(db, 'cats docs', 10).map((page) => page.url)).toEqual(['https://docs.example.com/a'])
    expect(suggestPages(db, '  docs   guide ', 10)).toHaveLength(2)
  })

  it('reads a percent sign, an underscore and a backslash as themselves', () => {
    const db = memory()
    add(db, 'https://a.org/100%25', 'pct', 1, 1)
    add(db, 'https://a.org/100x', 'x', 1, 2)
    add(db, 'https://a.org/a_b', 'under', 1, 3)
    add(db, 'https://a.org/axb', 'any', 1, 4)
    add(db, 'https://a.org/c\\d', 'slash', 1, 5)
    expect(suggestPages(db, '100%', 10).map((page) => page.url)).toEqual(['https://a.org/100%25'])
    expect(suggestPages(db, 'a_b', 10).map((page) => page.url)).toEqual(['https://a.org/a_b'])
    expect(suggestPages(db, 'c\\d', 10).map((page) => page.url)).toEqual(['https://a.org/c\\d'])
  })

  it('orders by how often an address was typed, then visited, then how recently', () => {
    const db = memory()
    add(db, 'https://a.test/recent', 't', 1, 900)
    add(db, 'https://a.test/visited', 't', 5, 100)
    add(db, 'https://a.test/typed', 't', 1, 50, 2)
    add(db, 'https://a.test/older', 't', 1, 10)
    expect(suggestPages(db, 'a.test', 10).map((page) => page.url)).toEqual([
      'https://a.test/typed', 'https://a.test/visited', 'https://a.test/recent', 'https://a.test/older'
    ])
  })

  it('answers what a row holds, and no more than the limit', () => {
    const db = memory()
    for (let n = 0; n < 5; n += 1) add(db, `https://a.test/${String(n)}`, 'T', 1, n)
    expect(suggestPages(db, 'a.test', 2)).toHaveLength(2)
    expect(suggestPages(db, 'a.test', 1)[0]).toEqual({ url: 'https://a.test/4', title: 'T', visitCount: 1, typedCount: 0, lastVisit: 4 })
  })

  it.each(['', '   ', '\n'])('has nothing for the text %j', (text) => {
    const db = memory()
    add(db, 'https://a.test/', 'T', 1, 1)
    expect(suggestPages(db, text, 10)).toEqual([])
  })

  it('has nothing for a limit below one, and looks for no more than four words', () => {
    const db = memory()
    add(db, 'https://a.test/b/c/d/e', 'T', 1, 1)
    expect(suggestPages(db, 'a', 0)).toEqual([])
    expect(suggestPages(db, 'a b c d zzz', 10)).toHaveLength(1)
  })
})

describe('markPageTyped', () => {
  it('counts one more each time, and says whether the page was there', () => {
    const db = memory()
    add(db, 'https://a.test/', 'T', 1, 1)
    expect(markPageTyped(db, 'https://a.test/')).toBe(true)
    expect(markPageTyped(db, 'https://a.test/')).toBe(true)
    expect(markPageTyped(db, 'https://missing.test/')).toBe(false)
    expect(suggestPages(db, 'a.test', 1)[0]?.typedCount).toBe(2)
  })

  it('leaves the search index alone, so the page is still found by its words', () => {
    const db = memory()
    add(db, 'https://a.test/', 'Unique words', 1, 1)
    markPageTyped(db, 'https://a.test/')
    const found = db.prepare("SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH '\"unique\"'").get() as { n: number }
    expect(found.n).toBe(1)
  })
})

describe('the file store', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }) })
  afterEach(() => { vi.useRealTimers() })

  it('counts an address typed after its page was recorded, once the write has run', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.record('https://a.test/', 'A', 1000)
    store.markTyped('https://a.test/')
    expect(store.suggest('a.test', 5)[0]?.typedCount).toBe(1)
    store.close()
  })

  it('counts an address typed before its page loaded, when the page is recorded', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.markTyped('https://a.test/')
    expect(store.suggest('a.test', 5)).toEqual([])
    store.record('https://a.test/', 'A', 1_000_500)
    expect(store.suggest('a.test', 5)[0]).toMatchObject({ typedCount: 1, visitCount: 1 })
    store.record('https://a.test/', 'A', 1_000_900)
    expect(store.suggest('a.test', 5)[0]).toMatchObject({ typedCount: 1, visitCount: 2 })
    store.close()
  })

  it('forgets an address whose page never loaded within a minute', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.markTyped('https://a.test/')
    store.flush()
    store.record('https://a.test/', 'A', 1_000_000 + 61_000)
    expect(store.suggest('a.test', 5)[0]?.typedCount).toBe(0)
    store.close()
  })

  it('counts nothing for an address that is too long to be kept', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.markTyped(`https://a.test/${'x'.repeat(5000)}`)
    expect(store.count()).toBe(0)
    store.close()
  })

  it('is forgotten with the rest on clear', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.markTyped('https://a.test/')
    store.flush()
    store.clear()
    store.record('https://a.test/', 'A', 1_000_100)
    expect(store.suggest('a.test', 5)[0]?.typedCount).toBe(0)
    store.close()
  })

  it('answers nothing on the null store', () => {
    expect(new NullHistoryStore().suggest()).toEqual([])
  })

  it('writes down no typed address while history is off', () => {
    const store = new SqliteHistoryStore(':memory:')
    let remember = true
    const service = new HistoryService(store, { get: (() => remember) as never, onChange: () => () => {} })
    store.record('https://a.test/', 'A', 1000)
    remember = false
    service.markTyped('https://a.test/')
    expect(service.suggest('a.test', 5)[0]?.typedCount).toBe(0)
    remember = true
    service.markTyped('https://a.test/')
    expect(service.suggest('a.test', 5)[0]?.typedCount).toBe(1)
    store.close()
  })
})
