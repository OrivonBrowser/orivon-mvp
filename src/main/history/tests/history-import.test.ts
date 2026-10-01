import { describe, expect, it } from 'vitest'
import { HistoryService } from '../history-service.js'
import { importHistoryRows, MAX_IMPORTED_PAGES, selectImportRows } from '../history-import.js'
import { SqliteHistoryStore } from '../sqlite-history-store.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1000 * DAY
const row = (url: string, lastVisit: number, extra: { title?: string, visitCount?: number } = {}) => ({ url, title: extra.title ?? url, lastVisit, visitCount: extra.visitCount ?? 1 })

describe('selectImportRows', () => {
  const select = (rows: ReturnType<typeof row>[], retentionDays: number | null = null, limit = 100) => selectImportRows(rows, { now: NOW, retentionDays, limit })

  it('keeps the addresses the recorder keeps, and drops the rest', () => {
    const kept = select([
      row('https://a.test/', NOW - 1), row('http://b.test/', NOW - 2), row('ipfs://bafy/x', NOW - 3), row('ipns://k/y', NOW - 4),
      row('javascript:alert(1)', NOW - 5), row('file:///etc/passwd', NOW - 6), row('chrome://settings', NOW - 7), row('about:blank', NOW - 8),
      row('orivon://history', NOW - 9), row('data:text/html,hi', NOW - 10), row('not a url', NOW - 11), row('view-source:https://a.test/', NOW - 12)
    ])
    expect(kept.map((entry) => entry.url)).toEqual(['https://a.test/', 'http://b.test/', 'ipfs://bafy/x', 'ipns://k/y'])
  })

  it('drops a visit in the future, one before the window, and a time that is not a time', () => {
    const kept = select([row('https://future.test/', NOW + 1), row('https://old.test/', NOW - 10 * DAY), row('https://ok.test/', NOW - DAY), row('https://zero.test/', 0), row('https://nan.test/', Number.NaN)], 7)
    expect(kept.map((entry) => entry.url)).toEqual(['https://ok.test/'])
    expect(select([row('https://old.test/', NOW - 900 * DAY)], null)).toHaveLength(1)
  })

  it('keeps the newest rows within the limit, newest first', () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(`https://p${String(index)}.test/`, NOW - index * 1000))
    expect(select([...rows].reverse(), null, 3).map((entry) => entry.url)).toEqual(['https://p0.test/', 'https://p1.test/', 'https://p2.test/'])
    expect(MAX_IMPORTED_PAGES).toBe(20_000)
  })

  it('cuts a title to 512 characters and clamps a visit count', () => {
    const [kept] = select([{ url: 'https://a.test/', title: 'x'.repeat(2000), lastVisit: NOW - 1, visitCount: 1e12 }])
    expect(kept?.title).toHaveLength(512)
    expect(kept?.visitCount).toBe(1_000_000)
    expect(select([{ url: 'https://a.test/', title: '', lastVisit: NOW - 1, visitCount: -4 }])[0]?.visitCount).toBe(1)
  })
})

describe('importHistoryRows', () => {
  it('adds pages with a visit each, so they can be found, listed and forgotten by range', () => {
    const store = new SqliteHistoryStore(':memory:')
    expect(importHistoryRows((store as unknown as { db: never }).db, [row('https://a.test/', 5000, { title: 'Alpha page', visitCount: 4 }), row('https://b.test/', 9000, { title: 'Beta' })])).toBe(2)
    expect(store.list().map((entry) => [entry.url, entry.visitCount, entry.lastVisit])).toEqual([['https://b.test/', 1, 9000], ['https://a.test/', 4, 5000]])
    expect(store.list({ search: 'alpha' }).map((entry) => entry.url)).toEqual(['https://a.test/'])
    store.removeRange(0, 6000)
    expect(store.list().map((entry) => entry.url)).toEqual(['https://b.test/'])
    store.close()
  })

  it('merges into a page that is already there: the later time, the sum of the visits, the title it has', () => {
    const store = new SqliteHistoryStore(':memory:')
    store.record('https://a.test/', 'Mine', 3000)
    store.record('https://blank.test/', '', 3000)
    expect(store.importPages([row('https://a.test/', 7000, { title: 'Theirs', visitCount: 5 }), row('https://blank.test/', 2000, { title: 'Filled', visitCount: 2 })])).toBe(2)
    const [a, blank] = [store.list({ search: 'a.test' })[0], store.list({ search: 'blank.test' })[0]]
    expect(a).toMatchObject({ title: 'Mine', lastVisit: 7000, visitCount: 6 })
    expect(blank).toMatchObject({ title: 'Filled', lastVisit: 3000, visitCount: 3 })
    store.close()
  })

  it('changes nothing when the same rows come in again', () => {
    const store = new SqliteHistoryStore(':memory:')
    const rows = [row('https://a.test/', 5000, { visitCount: 3 }), row('https://b.test/', 6000)]
    store.importPages(rows)
    expect(store.importPages(rows)).toBe(0)
    expect(store.list().map((entry) => entry.visitCount)).toEqual([1, 3])
    expect(store.count()).toBe(2)
    store.close()
  })

  it('never pushes the person\'s own pages out: new pages are added only while there is room under the cap', () => {
    const store = new SqliteHistoryStore(':memory:', { maxPages: 6 })
    for (const name of ['m1', 'm2', 'm3']) store.record(`https://${name}.test/`, name, 100)
    const incoming = Array.from({ length: 10 }, (_, index) => row(`https://i${String(index)}.test/`, 1000 + index))
    expect(store.importPages(incoming)).toBe(3)
    expect(store.count()).toBe(6)
    expect(store.list({ search: 'm1.test' })).toHaveLength(1)
    // A page already kept still takes the visits, cap or not.
    expect(store.importPages([row('https://m1.test/', 5000)])).toBe(1)
    store.close()
  })

  it('writes nothing when one row fails: it is one transaction', () => {
    const store = new SqliteHistoryStore(':memory:')
    const bad = { url: 'https://x.test/', title: Symbol('t') as unknown as string, lastVisit: 1, visitCount: 1 }
    expect(() => store.importPages([row('https://a.test/', 5000), bad])).toThrow()
    expect(store.count()).toBe(0)
    store.close()
  })
})

describe('HistoryService.importPages', () => {
  function setup (values: Record<string, boolean | string> = {}) {
    const settings: Record<string, boolean | string> = { 'history.remember': true, 'history.retentionDays': '90', ...values }
    const store = new SqliteHistoryStore(':memory:')
    const service = new HistoryService(store, { get: ((key: string) => settings[key]) as never, onChange: () => () => {} }, null, () => NOW)
    const changes: string[] = []
    service.onChange((change) => { changes.push(change) })
    return { service, store, changes }
  }

  it('keeps the recent pages, tells its listeners once, and drops the ones outside the retention', () => {
    const { service, store, changes } = setup({ 'history.retentionDays': '30' })
    expect(service.importPages([row('https://new.test/', NOW - DAY), row('https://old.test/', NOW - 60 * DAY), row('javascript:1', NOW - 1)])).toBe(1)
    expect(store.list().map((entry) => entry.url)).toEqual(['https://new.test/'])
    expect(changes).toEqual(['entries'])
    store.close()
  })

  it('keeps everything in the window when history is kept forever', () => {
    const { service, store } = setup({ 'history.retentionDays': 'forever' })
    expect(service.importPages([row('https://old.test/', NOW - 900 * DAY)])).toBe(1)
    store.close()
  })

  it('imports nothing while history is off, and says nothing changed', () => {
    const { service, store, changes } = setup({ 'history.remember': false })
    expect(service.importPages([row('https://a.test/', NOW - 1)])).toBe(0)
    expect(store.count()).toBe(0)
    expect(changes).toEqual([])
    store.close()
  })
})
