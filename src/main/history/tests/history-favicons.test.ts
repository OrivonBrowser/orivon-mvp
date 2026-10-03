import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FAVICON_HOSTS, MAX_HISTORY_FAVICON_CHARS, faviconsForHosts, prepareFaviconStatements, pruneHostFavicons, setHostFavicon, withFavicons } from '../history-favicons.js'
import { migrate } from '../history-schema.js'
import { NullHistoryStore } from '../history-store.js'
import type { HistoryStore } from '../history-store.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const GIF = 'data:image/gif;base64,R0lGODlhAQAB'

/** A distinct icon per `n`: the PNG signature followed by one more byte. */
const icon = (n: number): string => `data:image/png;base64,${Buffer.concat([Buffer.from('iVBORw0KGgo=', 'base64'), Buffer.from([n % 256, Math.floor(n / 256)])]).toString('base64')}`

function database (): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

const page = (db: DatabaseSync, url: string): void => { db.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, 1, 1)').run(url, '') }
const hosts = (db: DatabaseSync): string[] => (db.prepare('SELECT host FROM favicons ORDER BY host').all() as Array<{ host: string }>).map((row) => row.host)

describe('the favicons table', () => {
  it('keeps an icon per host and replaces it when the site changes it', () => {
    const db = database()
    setHostFavicon(db, 'a.example', PNG)
    setHostFavicon(db, 'a.example', GIF)
    expect(faviconsForHosts(db, ['a.example'])).toEqual({ 'a.example': GIF })
  })

  it('notes the time of an icon it already has without changing it, so a site seen again is the last to go', () => {
    const db = database()
    let clock = 10
    setHostFavicon(db, 'a.example', PNG, () => clock)
    clock = 99
    setHostFavicon(db, 'a.example', PNG, () => clock)
    expect(db.prepare('SELECT updated, data FROM favicons').get()).toMatchObject({ updated: 99, data: PNG })
  })

  it('trims the sites seen longest ago, not those whose icon changed longest ago', () => {
    const db = database()
    for (let n = 0; n < MAX_FAVICON_HOSTS; n += 1) setHostFavicon(db, `h${String(n).padStart(5, '0')}.example`, icon(n), () => n)
    // The oldest site is seen again with the icon it has, then one more site arrives.
    setHostFavicon(db, 'h00000.example', icon(0), () => MAX_FAVICON_HOSTS + 1)
    setHostFavicon(db, 'new.example', PNG, () => MAX_FAVICON_HOSTS + 2)
    const kept = hosts(db)
    expect(kept).toHaveLength(MAX_FAVICON_HOSTS)
    expect(kept).toContain('h00000.example')
    expect(kept).not.toContain('h00001.example')
  })

  it('keeps no icon larger than the cap', () => {
    const db = database()
    const big = `data:image/png;base64,iVBORw0KGgo=${'A'.repeat(MAX_HISTORY_FAVICON_CHARS)}`
    setHostFavicon(db, 'big.example', big)
    setHostFavicon(db, 'small.example', PNG)
    expect(hosts(db)).toEqual(['small.example'])
  })

  it('refuses what is not an image, what lies about being one, and what is too large', () => {
    const db = database()
    setHostFavicon(db, 'a.example', 'https://a.example/favicon.ico')
    setHostFavicon(db, 'b.example', 'data:text/html;base64,PHNjcmlwdD4=')
    setHostFavicon(db, 'c.example', 'data:image/png;base64,bm90IGFuIGltYWdl')
    setHostFavicon(db, 'd.example', `data:image/png;base64,${'A'.repeat(60_000)}`)
    setHostFavicon(db, '', PNG)
    expect(hosts(db)).toEqual([])
  })

  it('answers only the hosts it has an icon for', () => {
    const db = database()
    setHostFavicon(db, 'a.example', PNG)
    expect(faviconsForHosts(db, ['a.example', 'unknown.example', ''])).toEqual({ 'a.example': PNG })
    expect(faviconsForHosts(db, [])).toEqual({})
  })

  it('keeps at most the cap, dropping the icons refreshed longest ago', () => {
    const db = database()
    for (let n = 0; n < MAX_FAVICON_HOSTS + 5; n += 1) setHostFavicon(db, `h${String(n).padStart(5, '0')}.example`, icon(n), () => n)
    const kept = hosts(db)
    expect(kept).toHaveLength(MAX_FAVICON_HOSTS)
    expect(kept).not.toContain('h00000.example')
    expect(kept).toContain(`h${String(MAX_FAVICON_HOSTS + 4).padStart(5, '0')}.example`)
  })

  it('forgets the icon of a site with no page left, and keeps the others', () => {
    const db = database()
    page(db, 'https://a.example/x')
    page(db, 'https://b.example:8443/y')
    page(db, 'ipfs://bafy/readme')
    for (const host of ['a.example', 'b.example', 'bafy', 'gone.example']) setHostFavicon(db, host, PNG)
    pruneHostFavicons(db)
    expect(hosts(db)).toEqual(['a.example', 'b.example', 'bafy'])
  })

  it('does not take a host for another that only begins the same way', () => {
    const db = database()
    page(db, 'https://a.example.org/')
    setHostFavicon(db, 'a.example', PNG)
    pruneHostFavicons(db)
    expect(hosts(db)).toEqual([])
  })

  it('draws an entry\'s icon from its site, and leaves an entry of a site with none as it was', () => {
    const db = database()
    setHostFavicon(db, 'a.example', PNG)
    const plain = { id: 1, url: 'https://b.example/', title: '', lastVisit: 1, visitCount: 1 }
    const shown = withFavicons(db, [{ ...plain, id: 2, url: 'https://a.example/z' }, plain])
    expect(shown[0]?.favicon).toBe(PNG)
    expect(shown[1]).toBe(plain)
  })
})

describe('icons in the store', () => {
  it('are listed with their pages, and forgotten with the last page of the site', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.record('https://a.example/one', 'One', 1)
    store.record('https://a.example/two', 'Two', 2)
    store.record('https://b.example/', 'B', 3)
    store.setFavicon('a.example', PNG)
    store.setFavicon('b.example', GIF)
    expect(store.list().map((entry) => entry.favicon)).toEqual([GIF, PNG, PNG])

    const [two, one] = store.list().filter((entry) => entry.url.startsWith('https://a.'))
    store.remove((two as { id: number }).id)
    expect(store.faviconsFor(['a.example'])).toEqual({ 'a.example': PNG })
    store.remove((one as { id: number }).id)
    expect(store.faviconsFor(['a.example', 'b.example'])).toEqual({ 'b.example': GIF })
    store.removeRange(0, 10)
    expect(store.faviconsFor(['b.example'])).toEqual({})
  })

  it('are all forgotten by clear', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.record('https://a.example/', 'A', 1)
    store.setFavicon('a.example', PNG)
    store.clear()
    expect(store.faviconsFor(['a.example'])).toEqual({})
  })

  it('are not kept by the store that keeps nothing', () => {
    const store: HistoryStore = new NullHistoryStore()
    store.setFavicon('a.example', PNG)
    expect(store.faviconsFor(['a.example'])).toEqual({})
    expect(store.listOrdered()).toEqual([])
  })
})

describe('icon writes in the store', () => {
  afterEach(() => { vi.useRealTimers() })

  const updatedOf = (store: SqliteHistoryStore, host: string): number | undefined => {
    const db = (store as unknown as { db: DatabaseSync }).db
    return (db.prepare('SELECT updated FROM favicons WHERE host = ?').get(host) as { updated: number } | undefined)?.updated
  }

  it('skips an icon identical to the one just written for the host', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const store = new SqliteHistoryStore(':memory:')
    store.setFavicon('a.example', PNG)
    store.flush()
    vi.setSystemTime(1_000_000 + 5 * 60_000)
    store.setFavicon('a.example', PNG)
    store.flush()
    expect(updatedOf(store, 'a.example')).toBe(1_000_000)
  })

  it('writes a different icon for the host at once', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const store = new SqliteHistoryStore(':memory:')
    store.setFavicon('a.example', PNG)
    store.flush()
    vi.setSystemTime(1_000_100)
    store.setFavicon('a.example', GIF)
    store.flush()
    expect(store.faviconsFor(['a.example'])).toEqual({ 'a.example': GIF })
    expect(updatedOf(store, 'a.example')).toBe(1_000_100)
  })

  it('refreshes the time of an identical icon once an hour has passed', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const store = new SqliteHistoryStore(':memory:')
    store.setFavicon('a.example', PNG)
    store.flush()
    vi.setSystemTime(1_000_000 + 61 * 60_000)
    store.setFavicon('a.example', PNG)
    store.flush()
    expect(updatedOf(store, 'a.example')).toBe(1_000_000 + 61 * 60_000)
  })

  it('writes an icon again after the history forgot it', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const store = new SqliteHistoryStore(':memory:')
    store.record('https://a.example/', 'A', 1)
    store.setFavicon('a.example', PNG)
    store.flush()
    store.clear()
    store.record('https://a.example/', 'A', 2)
    store.setFavicon('a.example', PNG)
    expect(store.faviconsFor(['a.example'])).toEqual({ 'a.example': PNG })
  })

  it('trims once per write of many icons, not once per icon', () => {
    const store = new SqliteHistoryStore(':memory:')
    const db = (store as unknown as { db: DatabaseSync }).db
    const trim = vi.spyOn(prepareFaviconStatements(db).trim, 'run')
    for (let n = 0; n < 40; n += 1) store.setFavicon(`h${n}.example`, icon(n))
    store.flush()
    expect(trim).toHaveBeenCalledTimes(1)
    expect(Object.keys(store.faviconsFor(Array.from({ length: 40 }, (_, n) => `h${n}.example`)))).toHaveLength(40)
  })
})
