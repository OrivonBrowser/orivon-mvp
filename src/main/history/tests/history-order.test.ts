import { describe, expect, it } from 'vitest'
import { MAX_OFFSET } from '../history-order.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function seeded (): SqliteHistoryStore {
  const store = new SqliteHistoryStore(':memory:')
  // b is the most visited; a was seen last; c has no title.
  store.record('https://a.example/', 'apple pie', 300)
  store.record('https://b.example/', 'Banana', 100)
  store.record('https://b.example/', 'Banana', 110)
  store.record('https://b.example/', 'Banana', 120)
  store.record('https://c.example/', '', 200)
  store.record('https://d.example/', 'cherry', 150)
  return store
}

const urls = (entries: ReadonlyArray<{ url: string }>): string[] => entries.map((entry) => entry.url.replace('https://', '').replace('.example/', ''))

describe('listOrdered', () => {
  it('puts the most visited first, the most recent among equals', () => {
    expect(urls(seeded().listOrdered({ order: 'visits' }))).toEqual(['b', 'a', 'c', 'd'])
  })

  it('sorts by title without regard to case, and puts a page with no title last', () => {
    expect(urls(seeded().listOrdered({ order: 'title' }))).toEqual(['a', 'b', 'd', 'c'])
  })

  it('applies a search in either order', () => {
    const store = seeded()
    expect(urls(store.listOrdered({ order: 'visits', search: 'an' }))).toEqual(['b'])
    expect(urls(store.listOrdered({ order: 'title', search: 'example' }))).toEqual(['a', 'b', 'd', 'c'])
    expect(store.listOrdered({ order: 'title', search: 'nothing like it' })).toEqual([])
  })

  it('pages by offset without repeating or skipping an entry', () => {
    const store = new SqliteHistoryStore(':memory:')
    for (let n = 0; n < 25; n += 1) store.record(`https://site${String(n)}.example/`, n % 3 === 0 ? 'same' : `t${String(n % 5)}`, n)
    for (const order of ['visits', 'title'] as const) {
      const all = store.listOrdered({ order, limit: 25 }).map((entry) => entry.id)
      const paged = [0, 10, 20].flatMap((offset) => store.listOrdered({ order, limit: 10, offset }).map((entry) => entry.id))
      expect(paged).toEqual(all)
      expect(new Set(paged).size).toBe(25)
    }
  })

  it('reads an unknown order as most recent, and clamps a wild offset and limit', () => {
    const store = seeded()
    expect(urls(store.listOrdered({ order: 'sideways' as never }))).toEqual(['a', 'c', 'd', 'b'])
    expect(store.listOrdered({ order: 'visits', offset: -5, limit: 0 })).toHaveLength(1)
    expect(store.listOrdered({ order: 'visits', offset: MAX_OFFSET * 10 })).toEqual([])
    expect(urls(store.listOrdered())).toEqual(['a', 'c', 'd', 'b'])
  })

  it('gives each entry the icon of its site', () => {
    const store = seeded()
    store.setFavicon('b.example', PNG)
    const [first, second] = store.listOrdered({ order: 'visits' })
    expect(first?.favicon).toBe(PNG)
    expect(second?.favicon).toBeUndefined()
  })
})

describe('the cost of the new statements on a full history', () => {
  it('prunes icons and sorts a full history of pages within a couple of seconds', () => {
    const store = new SqliteHistoryStore(':memory:')
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.exec('BEGIN')
    const insert = db.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, ?, ?)')
    for (let n = 0; n < 100_000; n += 1) insert.run(`https://site${String(n % 1500)}.example/p${String(n)}`, `Title ${String((n * 7919) % 100_000)}`, n, 1 + (n % 40))
    db.exec('COMMIT')
    for (let n = 0; n < 1500; n += 1) store.setFavicon(`site${String(n)}.example`, PNG)

    const t0 = performance.now()
    store.pruneFavicons()
    const prune = performance.now() - t0
    const t1 = performance.now()
    store.listOrdered({ order: 'title', offset: 50, limit: 50 })
    const title = performance.now() - t1
    const t2 = performance.now()
    store.listOrdered({ order: 'visits', offset: 50, limit: 50 })
    const visits = performance.now() - t2
    expect(prune).toBeLessThan(2000)
    expect(title).toBeLessThan(2000)
    expect(visits).toBeLessThan(2000)
  }, 60_000)
})
