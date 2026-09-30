import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { TabRecord } from '../../shell/tab-types.js'
import { boundHistory, MAX_HISTORY_ENTRIES, MAX_TITLE_LENGTH, MAX_URL_LENGTH, rememberOpenedFrom, sanitizeSnapshot, snapshotOf } from '../tab-snapshot.js'

interface FakePage {
  url?: string
  title?: string
  destroyed?: boolean
  entries?: Array<{ url: string, title: string, pageState?: string }>
  active?: number
}

function wcOf (page: FakePage): WebContents {
  return {
    isDestroyed: () => page.destroyed === true,
    getURL: () => page.url ?? 'https://a.example/',
    getTitle: () => page.title ?? 'A',
    navigationHistory: { getAllEntries: () => page.entries ?? [], getActiveIndex: () => page.active ?? 0 }
  } as unknown as WebContents
}

const recordOf = (extra: Partial<TabRecord> = {}): TabRecord => ({ isDashboardTab: false, internalPage: null, pinned: false, ...extra } as unknown as TabRecord)

describe('snapshotOf', () => {
  it('writes down the address, the title and whether the tab is pinned', () => {
    expect(snapshotOf(recordOf({ pinned: true }), wcOf({ url: 'https://a.example/x', title: 'A page' }))).toEqual({ url: 'https://a.example/x', title: 'A page', pinned: true })
  })

  it('does not record the new-tab page, a destroyed page, or an address a tab would refuse', () => {
    expect(snapshotOf(recordOf({ isDashboardTab: true }), wcOf({ url: 'https://localhost:5173/newtab/' }))).toBeNull()
    expect(snapshotOf(recordOf(), wcOf({ destroyed: true }))).toBeNull()
    for (const url of ['view-source:https://a.example/', 'blob:https://a.example/1', 'about:blank', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://gpu']) {
      expect(snapshotOf(recordOf(), wcOf({ url })), url).toBeNull()
    }
  })

  it('keeps a restored tab on the address it was opened from until its page commits, then follows the page', () => {
    const record = recordOf({ pinned: true })
    rememberOpenedFrom(record, { url: 'https://slow.example/a', title: 'Saved title', pinned: false })
    expect(snapshotOf(record, wcOf({ url: '', title: '' }))).toEqual({ url: 'https://slow.example/a', title: 'Saved title', pinned: true })
    expect(snapshotOf(record, wcOf({ url: '', title: 'Now' }))?.title).toBe('Now')
    expect(snapshotOf(record, wcOf({ url: 'https://slow.example/b', title: 'B' }))?.url).toBe('https://slow.example/b')
    // Once committed it is not the address to fall back to again.
    expect(snapshotOf(record, wcOf({ url: '', title: '' }))).toBeNull()
  })

  it('records an internal page by its id and path', () => {
    const snapshot = snapshotOf(recordOf({ internalPage: 'settings' }), wcOf({ url: 'orivon://settings/search?q=zoom', title: 'Settings' }))
    expect(snapshot).toEqual({ url: 'orivon://settings/search?q=zoom', title: 'Settings', pinned: false, internal: { page: 'settings', path: '/search?q=zoom' } })
  })

  it('falls back to the page root when an internal tab shows no address yet, and never records the private start page', () => {
    expect(snapshotOf(recordOf({ internalPage: 'history' }), wcOf({ url: '' }))?.internal).toEqual({ page: 'history', path: '/' })
    expect(snapshotOf(recordOf({ internalPage: 'private' }), wcOf({ url: 'orivon://private/' }))).toBeNull()
  })

  it('caps the title and refuses an oversize address instead of cutting it', () => {
    expect(snapshotOf(recordOf(), wcOf({ title: 'x'.repeat(1000) }))?.title).toHaveLength(MAX_TITLE_LENGTH)
    expect(snapshotOf(recordOf(), wcOf({ url: `https://a.example/${'x'.repeat(MAX_URL_LENGTH)}` }))).toBeNull()
  })

  it('keeps back and forward as address and title only, never the page state', () => {
    const entries = [
      { url: 'https://a.example/1', title: 'One', pageState: 'SECRET-FORM-DATA' },
      { url: 'https://a.example/2', title: 'Two', pageState: 'SECRET-FORM-DATA' },
      { url: 'https://a.example/3', title: 'Three', pageState: 'SECRET-FORM-DATA' }
    ]
    const snapshot = snapshotOf(recordOf(), wcOf({ url: 'https://a.example/2', title: 'Two', entries, active: 1 }))
    expect(snapshot?.index).toBe(1)
    expect(snapshot?.entries).toEqual([{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }, { url: 'https://a.example/3', title: 'Three' }])
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
    expect(JSON.stringify(snapshot)).not.toContain('pageState')
  })

  it('leaves history out for a tab with one entry, and when the history cannot be read', () => {
    expect(snapshotOf(recordOf(), wcOf({ entries: [{ url: 'https://a.example/', title: 'A' }] }))).not.toHaveProperty('entries')
    const broken = wcOf({})
    Object.defineProperty(broken, 'navigationHistory', { get: () => { throw new Error('gone') } })
    expect(snapshotOf(recordOf(), broken)).toEqual({ url: 'https://a.example/', title: 'A', pinned: false })
  })
})

describe('sanitizeSnapshot', () => {
  it('refuses what is not an object, or has no usable address', () => {
    for (const bad of [null, 'x', 4, [], {}, { url: 4 }, { url: 'javascript:alert(1)' }, { url: '' }]) expect(sanitizeSnapshot(bad), JSON.stringify(bad)).toBeNull()
  })

  it('drops history whose shown entry does not match the address, or that has a refused entry in it kept out', () => {
    const base = { url: 'https://a.example/2', title: 'T', pinned: false }
    expect(sanitizeSnapshot({ ...base, entries: [{ url: 'https://a.example/1', title: '' }, { url: 'https://a.example/9', title: '' }], index: 1 })).toEqual(base)
    const kept = sanitizeSnapshot({ ...base, entries: [{ url: 'javascript:1', title: '' }, { url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }], index: 2 })
    expect(kept?.entries).toEqual([{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }])
    expect(kept?.index).toBe(1)
  })

  it('accepts an internal page that exists and refuses one that does not, a path without a slash, or the private start page', () => {
    expect(sanitizeSnapshot({ url: 'x', internal: { page: 'history', path: '/' } })).toMatchObject({ internal: { page: 'history', path: '/' }, url: 'orivon://history/' })
    for (const internal of [{ page: 'nope', path: '/' }, { page: 'settings', path: 'x' }, { page: 'settings', path: 4 }, { page: 'private', path: '/' }, { page: 'settings', path: `/${'x'.repeat(3000)}` }]) {
      expect(sanitizeSnapshot({ url: 'https://a.example/', internal }), JSON.stringify(internal)).toBeNull()
    }
  })

  it('treats anything but true as not pinned', () => {
    expect(sanitizeSnapshot({ url: 'https://a.example/', pinned: 'yes' })?.pinned).toBe(false)
  })
})

describe('boundHistory', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ url: `https://a.example/${String(i)}`, title: '' }))

  it('keeps the entries nearest the one shown, and moves the index with them', () => {
    for (const shown of [0, 60, 119]) {
      const bounded = boundHistory(many, shown)
      expect(bounded.entries).toHaveLength(MAX_HISTORY_ENTRIES)
      expect(bounded.entries[bounded.index]).toBe(many[shown])
    }
  })

  it('leaves a short list alone', () => {
    expect(boundHistory(many.slice(0, 3), 2)).toEqual({ entries: many.slice(0, 3), index: 2 })
  })
})
