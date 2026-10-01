import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { BookmarkStore } from '../../browsing/bookmarks.js'
import type { DownloadEntry } from '../../downloads/download-types.js'
import type { WindowContext } from '../../shell/window-context.js'
import { PANEL_VIEWS, viewById } from '../panel-views.js'
import { holds, hostOf } from '../panel-types.js'
import { sizeText, stateLine } from '../views/downloads.js'
import { HISTORY_LIMIT } from '../views/history.js'

interface Fake { ctx: WindowContext, store: BookmarkStore, history: Record<string, ReturnType<typeof vi.fn>>, downloads: Record<string, ReturnType<typeof vi.fn>> }

const made: BookmarkStore[] = []
const dir = mkdtempSync(join(tmpdir(), 'orivon-panel-views-'))
// A store writes its file a moment after a change: wait for it, so nothing writes after the directory is gone.
afterEach(async () => { await Promise.all(made.splice(0).map(async (store) => { await store.flushPendingWrite() })) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function fake (downloads: DownloadEntry[] = []): Fake {
  let n = 0
  const store = new BookmarkStore(join(dir, `bookmarks-${String(made.length)}.json`), () => `id${String(++n)}`, () => 1000)
  made.push(store)
  const history = { listOrdered: vi.fn(() => []), pagesByIds: vi.fn(() => []), remove: vi.fn(), onChange: vi.fn(() => () => {}) }
  const list = { list: vi.fn(() => downloads), open: vi.fn(async () => true), onChange: vi.fn(() => () => {}) }
  return { ctx: { window: {}, services: { bookmarks: store, history, downloads: list } } as unknown as WindowContext, store, history, downloads: list }
}

const view = (id: string): NonNullable<ReturnType<typeof viewById>> => viewById(id) as NonNullable<ReturnType<typeof viewById>>

describe('the registry', () => {
  it('lists Orivon views in the order the picker shows them, one id each', () => {
    expect(PANEL_VIEWS.map((entry) => entry.id)).toEqual(['bookmarks', 'history', 'reading', 'downloads'])
    expect(viewById('nope')).toBeUndefined()
  })

  it('says what each empty list will hold', () => {
    expect(PANEL_VIEWS.map((entry) => entry.empty)).toEqual([
      'Bookmarks you save appear here.', 'Pages you visit appear here.', 'Pages you save for later appear here.', 'Files you download appear here.'
    ])
    expect(view('history').emptyPrivate).toBe('Private windows keep no history.')
  })
})

describe('helpers', () => {
  it('names the host of an address, and nothing for text that is not one', () => {
    expect(hostOf('https://docs.example.org/a/b?q=1')).toBe('docs.example.org')
    expect(hostOf('ipfs://bafy/x')).toBe('bafy')
    expect(hostOf('not an address')).toBe('')
  })

  it('holds a query in any of the texts, ignoring case, and holds everything for a blank one', () => {
    expect(holds('NEWS', 'Daily news')).toBe(true)
    expect(holds('x', 'Daily news', 'https://x.example/')).toBe(true)
    expect(holds('zzz', 'Daily news')).toBe(false)
    expect(holds('  ', 'anything')).toBe(true)
  })
})

describe('the bookmarks view', () => {
  function seeded (): Fake {
    const made = fake()
    const folder = made.store.addFolder({ title: 'Recipes', parent: 'bar' })
    made.store.addUrl({ url: 'https://bread.example/loaf', title: 'Loaf', parent: folder?.id ?? 'bar', favicon: null })
    made.store.addUrl({ url: 'https://news.example/', title: 'News front page', parent: 'bar' })
    made.store.addUrl({ url: 'https://other.example/', title: 'Elsewhere', parent: 'other' })
    return made
  }

  it('shows a root folder only when it holds something, and nothing for an empty tree', () => {
    expect(view('bookmarks').rows(fake().ctx, '', new Set(['bar', 'other']))).toEqual([])
    const made = fake()
    made.store.addUrl({ url: 'https://news.example/', title: 'News', parent: 'other' })
    expect(view('bookmarks').rows(made.ctx, '', new Set(['bar', 'other'])).map((row) => row.title)).toEqual(['Other bookmarks', 'News'])
  })

  it('lists the bar and Other bookmarks as folders, expanded only where the page says so', () => {
    const { ctx } = seeded()
    expect(view('bookmarks').rows(ctx, '', new Set()).map((row) => [row.title, row.expanded])).toEqual([['Bookmarks bar', false], ['Other bookmarks', false]])

    const open = view('bookmarks').rows(ctx, '', new Set(['bar', 'other'])).map((row) => [row.title, row.kind, row.level, row.expanded])
    expect(open).toEqual([
      ['Bookmarks bar', 'folder', 0, true], ['Recipes', 'folder', 1, false], ['News front page', 'item', 1, undefined],
      ['Other bookmarks', 'folder', 0, true], ['Elsewhere', 'item', 1, undefined]
    ])
  })

  it('opens a nested folder when the page lists it', () => {
    const { ctx, store } = seeded()
    const recipes = store.children('bar').find((node) => node.title === 'Recipes')?.id ?? ''
    expect(view('bookmarks').rows(ctx, '', new Set(['bar', recipes])).map((row) => row.title)).toEqual(['Bookmarks bar', 'Recipes', 'Loaf', 'News front page', 'Other bookmarks'])
  })

  it('gives a page its host as the second line and never its address as a row field', () => {
    const { ctx } = seeded()
    const news = view('bookmarks').rows(ctx, '', new Set(['bar'])).find((row) => row.title === 'News front page')
    expect(news).toMatchObject({ kind: 'item', sub: 'news.example', favicon: null })
    expect(Object.keys(news ?? {})).not.toContain('url')
  })

  it('answers a query with a flat list of matching pages, in the bar and in Other bookmarks', () => {
    const { ctx } = seeded()
    expect(view('bookmarks').rows(ctx, 'example', new Set()).map((row) => [row.title, row.level])).toEqual([['Loaf', 0], ['News front page', 0], ['Elsewhere', 0]])
    expect(view('bookmarks').rows(ctx, 'news', new Set()).map((row) => row.title)).toEqual(['News front page'])
    expect(view('bookmarks').rows(ctx, 'zzz', new Set())).toEqual([])
  })

  it('looks an address up from the store by id, refusing a folder, a root and an unknown id', () => {
    const { ctx, store } = seeded()
    const news = store.children('bar').find((node) => node.title === 'News front page')?.id ?? ''
    const recipes = store.children('bar').find((node) => node.title === 'Recipes')?.id ?? ''
    expect(view('bookmarks').resolve?.(ctx, news)).toBe('https://news.example/')
    expect(view('bookmarks').resolve?.(ctx, recipes)).toBeNull()
    expect(view('bookmarks').resolve?.(ctx, 'bar')).toBeNull()
    expect(view('bookmarks').resolve?.(ctx, 'missing')).toBeNull()
  })

  it('removes a page, and refuses to remove a folder with what is in it', () => {
    const { ctx, store } = seeded()
    const news = store.children('bar').find((node) => node.title === 'News front page')?.id ?? ''
    const recipes = store.children('bar').find((node) => node.title === 'Recipes')?.id ?? ''
    view('bookmarks').remove?.(ctx, recipes)
    expect(store.node(recipes)).toBeDefined()
    view('bookmarks').remove?.(ctx, news)
    expect(store.node(news)).toBeUndefined()
  })

  it('follows the store', () => {
    const { ctx, store } = seeded()
    const changed = vi.fn()
    const stop = view('bookmarks').watch?.(ctx, changed)
    store.addUrl({ url: 'https://new.example/', title: 'New' })
    expect(changed).toHaveBeenCalledTimes(1)
    stop?.()
    store.addUrl({ url: 'https://newer.example/', title: 'Newer' })
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('the history view', () => {
  const entry = (id: number, url: string, title: string, lastVisit: number): Record<string, unknown> => ({ id, url, title, lastVisit, visitCount: 1, favicon: null })

  it('lists the newest pages with their host, their time and their icon', () => {
    const made = fake()
    made.history['listOrdered']?.mockReturnValue([entry(7, 'https://a.example/x', 'A page', 5000), entry(6, 'https://b.example/', '', 4000)])

    expect(view('history').rows(made.ctx, '', new Set())).toEqual([
      { id: '7', kind: 'item', title: 'A page', sub: 'a.example', at: 5000, favicon: null },
      { id: '6', kind: 'item', title: 'https://b.example/', sub: 'b.example', at: 4000, favicon: null }
    ])
    expect(made.history['listOrdered']).toHaveBeenCalledWith({ limit: HISTORY_LIMIT })
  })

  it('searches by the query', () => {
    const made = fake()
    view('history').rows(made.ctx, '  loaf ', new Set())
    expect(made.history['listOrdered']).toHaveBeenCalledWith({ limit: HISTORY_LIMIT, search: 'loaf' })
  })

  it('looks an address up by id, and takes only an integer id', () => {
    const made = fake()
    made.history['pagesByIds']?.mockReturnValue([entry(7, 'https://a.example/x', 'A', 1)])
    expect(view('history').resolve?.(made.ctx, '7')).toBe('https://a.example/x')
    expect(made.history['pagesByIds']).toHaveBeenCalledWith([7])
    made.history['pagesByIds']?.mockClear()
    expect(view('history').resolve?.(made.ctx, '7; drop')).toBeNull()
    expect(view('history').resolve?.(made.ctx, '-1')).toBeNull()
    expect(made.history['pagesByIds']).not.toHaveBeenCalled()
  })

  it('sends an address that is not a web page nowhere', () => {
    const made = fake()
    made.history['pagesByIds']?.mockReturnValue([entry(7, 'javascript:alert(1)', 'x', 1)])
    expect(view('history').resolve?.(made.ctx, '7')).toBeNull()
  })

  it('removes one entry by its id', () => {
    const made = fake()
    view('history').remove?.(made.ctx, '12')
    view('history').remove?.(made.ctx, 'twelve')
    expect(made.history['remove']).toHaveBeenCalledExactlyOnceWith(12)
  })
})

describe('the reading list view', () => {
  function reading (): Fake {
    const made = fake()
    made.store.addUrl({ url: 'https://one.example/', title: 'One', parent: 'reading' })
    const two = made.store.addUrl({ url: 'https://two.example/', title: 'Two', parent: 'reading' })
    made.store.update(two?.id ?? '', { read: true })
    made.store.addUrl({ url: 'https://bar.example/', title: 'On the bar', parent: 'bar' })
    return made
  }

  it('lists unread pages, then the pages read, each under its heading', () => {
    expect(view('reading').rows(reading().ctx, '', new Set()).map((row) => [row.kind, row.title])).toEqual([
      ['header', 'Unread'], ['item', 'One'], ['header', 'Pages you have read'], ['item', 'Two']
    ])
  })

  it('leaves out a heading with nothing under it, and filters by the query', () => {
    expect(view('reading').rows(reading().ctx, 'two', new Set()).map((row) => row.title)).toEqual(['Pages you have read', 'Two'])
    expect(view('reading').rows(fake().ctx, '', new Set())).toEqual([])
  })

  it('opens only pages of the list, and marks one read once opened', () => {
    const { ctx, store } = reading()
    const one = store.children('reading').find((node) => node.title === 'One')?.id ?? ''
    const onBar = store.children('bar')[0]?.id ?? ''
    expect(view('reading').resolve?.(ctx, one)).toBe('https://one.example/')
    expect(view('reading').resolve?.(ctx, onBar)).toBeNull()
    view('reading').opened?.(ctx, one)
    expect(store.node(one)?.read).toBe(true)
  })

  it('removes a page of the list and never one outside it', () => {
    const { ctx, store } = reading()
    const one = store.children('reading').find((node) => node.title === 'One')?.id ?? ''
    const onBar = store.children('bar')[0]?.id ?? ''
    view('reading').remove?.(ctx, onBar)
    expect(store.node(onBar)).toBeDefined()
    view('reading').remove?.(ctx, one)
    expect(store.node(one)).toBeUndefined()
  })
})

describe('the downloads view', () => {
  const download = (extra: Partial<DownloadEntry>): DownloadEntry => ({
    id: 'd1', url: 'https://x.example/f.zip', referrer: '', fileName: 'f.zip', savePath: '/tmp/f.zip', mime: 'application/zip', total: 0, received: 0,
    state: 'completed', startedAt: 1, danger: false, ...extra
  })
  const MB = 1024 * 1024

  it('words a size in binary units', () => {
    expect(sizeText(0)).toBe('0 B')
    expect(sizeText(1536)).toBe('1.5 KB')
    expect(sizeText(2.1 * MB)).toBe('2.1 MB')
  })

  it('words each state in a line', () => {
    expect(stateLine(download({ state: 'progressing', received: 2.1 * MB, total: 8 * MB }))).toBe('2.1 MB of 8.0 MB')
    expect(stateLine(download({ state: 'progressing', received: 2 * MB }))).toBe('2.0 MB')
    expect(stateLine(download({ state: 'paused', received: MB, total: 2 * MB }))).toBe('Paused, 1.0 MB of 2.0 MB')
    expect(stateLine(download({}))).toBe('Done')
    expect(stateLine(download({ missing: true }))).toBe('Moved or deleted')
    expect(stateLine(download({ state: 'cancelled' }))).toBe('Cancelled')
    expect(stateLine(download({ state: 'interrupted' }))).toBe('Failed')
  })

  it('lists the newest first with a bar for one still running', () => {
    const made = fake([
      download({ id: 'old', fileName: 'old.zip', startedAt: 1 }),
      download({ id: 'run', fileName: 'run.zip', startedAt: 9, state: 'progressing', received: 2 * MB, total: 8 * MB }),
      download({ id: 'unknown', fileName: 'u.zip', startedAt: 5, state: 'progressing', received: MB, total: 0 })
    ])
    expect(view('downloads').rows(made.ctx, '', new Set())).toEqual([
      { id: 'run', kind: 'item', title: 'run.zip', sub: '2.0 MB of 8.0 MB', progress: 0.25 },
      { id: 'unknown', kind: 'item', title: 'u.zip', sub: '1.0 MB', progress: null },
      { id: 'old', kind: 'item', title: 'old.zip', sub: 'Done' }
    ])
  })

  it('filters by file name and opens a file through the service, which refuses a dangerous one', () => {
    const made = fake([download({ fileName: 'report.pdf' }), download({ id: 'd2', fileName: 'song.mp3' })])
    expect(view('downloads').rows(made.ctx, 'song', new Set()).map((row) => row.title)).toEqual(['song.mp3'])
    view('downloads').activate?.(made.ctx, 'd2')
    expect(made.downloads['open']).toHaveBeenCalledWith('d2')
    expect(view('downloads').remove).toBeUndefined()
  })
})
