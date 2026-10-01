import { describe, expect, it } from 'vitest'
import type { ClosedEntry } from '../../session-restore/closed-stack.js'
import type { TabState } from '../../shell/tab-types.js'
import { cleanFavicon, displayHost, FAVICON_BUDGET_CHARS, MAX_CLOSED_ROWS, MAX_FAVICON_CHARS, searchRows } from '../tab-search-model.js'
import type { SearchTabRow, SearchWindow } from '../tab-search-model.js'

const tab = (id: string, extra: Partial<TabState> = {}): TabState => ({
  id, url: `https://${id}.example/`, displayUrl: `https://${id}.example/page`, title: `Title ${id}`, canGoBack: false, canGoForward: false, loading: false,
  favicon: null, isNewTab: false, splitWith: null, isInternal: false, pinned: false, muted: false, audible: false, crashed: null, connection: 'none', ...extra
})
const win = (key: number, current: boolean, tabs: TabState[], activeTabId: string | null = tabs[0]?.id ?? null): SearchWindow => ({ key, current, tabs, activeTabId })
const closedTab = (id: number, title: string, url = 'https://gone.example/'): ClosedEntry => ({ kind: 'tab', id, at: 1000 + id, index: 0, windowKey: 1, tab: { url, title, pinned: false } })
const tabRows = (rows: ReturnType<typeof searchRows>): SearchTabRow[] => rows.filter((row): row is SearchTabRow => row.kind === 'tab')

describe('searchRows order', () => {
  it('keeps the strip order, the current window first, for tabs never seen in front', () => {
    const rows = searchRows({ windows: [win(1, false, [tab('x1'), tab('x2')]), win(2, true, [tab('a'), tab('b'), tab('c')], 'a')], closed: [], lastActive: new Map() })
    expect(tabRows(rows).map((row) => row.id)).toEqual(['b', 'c', 'x1', 'x2', 'a'])
  })

  it('puts the most recently used tab first and the tab the person is on last', () => {
    const lastActive = new Map([['a', 5], ['b', 1], ['c', 9], ['x1', 7]])
    const rows = searchRows({ windows: [win(1, false, [tab('x1')]), win(2, true, [tab('a'), tab('b'), tab('c')], 'a')], closed: [], lastActive })
    expect(tabRows(rows).map((row) => row.id)).toEqual(['c', 'x1', 'b', 'a'])
    expect(tabRows(rows).at(-1)).toMatchObject({ id: 'a', current: true })
  })

  it('marks only the active tab of the current window as current, and numbers the other windows from 1 in opening order', () => {
    const rows = tabRows(searchRows({ windows: [win(10, false, [tab('p')]), win(11, true, [tab('q'), tab('r')], 'r'), win(12, false, [tab('s')])], closed: [], lastActive: new Map() }))
    expect(rows.find((row) => row.id === 'p')).toMatchObject({ current: false, otherWindow: 1, windowKey: 10 })
    expect(rows.find((row) => row.id === 'q')).toMatchObject({ current: false, otherWindow: null })
    expect(rows.find((row) => row.id === 'r')).toMatchObject({ current: true, otherWindow: null })
    expect(rows.find((row) => row.id === 's')).toMatchObject({ otherWindow: 3 })
  })

  it('carries what the marks need', () => {
    const [row] = tabRows(searchRows({ windows: [win(1, true, [tab('a', { pinned: true, audible: true, muted: true })], null)], closed: [], lastActive: new Map() }))
    expect(row).toMatchObject({ pinned: true, audible: true, muted: true })
  })
})

describe('searchRows text', () => {
  it('shows an address without its scheme or trailing slash, and nothing for the new-tab page', () => {
    expect(displayHost('https://example.com/a/b')).toBe('example.com/a/b')
    expect(displayHost('ipfs://bafy123/')).toBe('bafy123')
    const [row] = tabRows(searchRows({ windows: [win(1, true, [tab('n', { isNewTab: true, displayUrl: '', favicon: 'data:image/png;base64,AA' })])], closed: [], lastActive: new Map() }))
    expect(row).toMatchObject({ host: '', favicon: null, isNewTab: true })
  })

  it('reduces a title to one line of bounded length', () => {
    const [row] = tabRows(searchRows({ windows: [win(1, true, [tab('a', { title: `one\n  two ${'x'.repeat(400)}` })])], closed: [], lastActive: new Map() }))
    expect(row?.title.startsWith('one two x')).toBe(true)
    expect(row?.title.length).toBe(300)
  })
})

describe('favicons', () => {
  it('passes an image data URL and refuses anything else or anything large', () => {
    expect(cleanFavicon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(cleanFavicon('https://example.com/favicon.ico')).toBeNull()
    expect(cleanFavicon('data:text/html,<script>')).toBeNull()
    expect(cleanFavicon(`data:image/png;base64,${'A'.repeat(MAX_FAVICON_CHARS)}`)).toBeNull()
    expect(cleanFavicon(null)).toBeNull()
  })

  it('stops handing out icons once one list has used its budget', () => {
    const big = `data:image/png;base64,${'A'.repeat(MAX_FAVICON_CHARS - 100)}`
    const count = Math.ceil(FAVICON_BUDGET_CHARS / big.length) + 2
    const tabs = Array.from({ length: count }, (_, index) => tab(`t${String(index)}`, { favicon: big }))
    const rows = tabRows(searchRows({ windows: [win(1, true, tabs, null)], closed: [], lastActive: new Map() }))
    expect(rows.filter((row) => row.favicon !== null).length).toBe(Math.floor(FAVICON_BUDGET_CHARS / big.length))
    expect(rows.at(-1)?.favicon).toBeNull()
  })
})

describe('closed rows', () => {
  it('lists the newest closed entries, at most eight, after the open tabs', () => {
    const closed = Array.from({ length: 12 }, (_, index) => closedTab(12 - index, `Gone ${String(12 - index)}`))
    const rows = searchRows({ windows: [win(1, true, [tab('a')])], closed, lastActive: new Map() })
    expect(rows.map((row) => row.kind)).toEqual(['tab', ...Array.from({ length: MAX_CLOSED_ROWS }, () => 'closed')])
    expect(rows[1]).toMatchObject({ kind: 'closed', entryId: 12, title: 'Gone 12', host: 'gone.example', at: 1012, count: 1, window: false })
  })

  it('names a closed window after its first tab and how many more it held', () => {
    const entry: ClosedEntry = {
      kind: 'window', id: 3, at: 50,
      window: { bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: [{ url: 'https://one.example/', title: 'One', pinned: false }, { url: 'https://two.example/', title: 'Two', pinned: false }, { url: 'https://three.example/', title: '', pinned: false }] }
    }
    const [row] = searchRows({ windows: [], closed: [entry], lastActive: new Map() })
    expect(row).toMatchObject({ kind: 'closed', entryId: 3, title: 'One and 2 more', host: 'one.example', count: 3, window: true })
  })

  it('falls back to the address for a closed tab with no title', () => {
    const [row] = searchRows({ windows: [], closed: [closedTab(1, '', 'https://bare.example/x')], lastActive: new Map() })
    expect(row).toMatchObject({ title: 'https://bare.example/x' })
  })
})
