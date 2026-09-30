import { describe, expect, it } from 'vitest'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

function seeded (): { store: SqliteHistoryStore, ids: number[] } {
  const store = new SqliteHistoryStore(':memory:')
  for (const [index, host] of ['a', 'b', 'c', 'd'].entries()) store.record(`https://${host}.example/`, host, index + 1)
  return { store, ids: store.list().map((entry) => entry.id).reverse() }
}

describe('pages by id', () => {
  it('are answered in the order asked, skipping an id with no page and a repeat', () => {
    const { store, ids } = seeded()
    expect(store.pagesByIds([ids[2] as number, 999, ids[0] as number, ids[2] as number]).map((entry) => entry.title)).toEqual(['c', 'a'])
    expect(store.pagesByIds([])).toEqual([])
  })

  it('are forgotten together, with the icon of a site left with no page, and the rest kept', () => {
    const { store, ids } = seeded()
    store.setFavicon('a.example', PNG)
    store.setFavicon('c.example', PNG)
    store.removeMany([ids[0] as number, ids[1] as number, 999])
    expect(store.list().map((entry) => entry.title)).toEqual(['d', 'c'])
    expect(store.count()).toBe(2)
    expect(store.faviconsFor(['a.example', 'c.example'])).toEqual({ 'c.example': PNG })
  })

  it('are found by search no more once forgotten', () => {
    const { store, ids } = seeded()
    store.removeMany([ids[3] as number])
    expect(store.list({ search: 'd.example' })).toEqual([])
  })

  it('name at most as many ids as one call may', () => {
    const { store, ids } = seeded()
    store.removeMany(Array.from({ length: 600 }, (_, n) => ids[n % 4] as number))
    expect(store.count()).toBe(0)
  })
})
