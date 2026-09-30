import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { IdSource } from '../bookmark-tree.js'
import { bookmarksDomain, MAX_IDS, MAX_SEARCH_RESULTS } from '../bookmarks-domain.js'
import type { BookmarksDomainDeps } from '../bookmarks-domain.js'
import { BookmarkStore } from '../bookmarks.js'
import { UNDO_MS } from '../bookmarks-undo.js'

const CALLER = { contents: {} } as unknown as InternalCaller
const WINDOW = { window: { id: 'win' } } as unknown as ShellWindow
const counter = (): IdSource => { let n = 0; return () => `n${String(n++)}` }
const ICON = 'data:image/png;base64,iVBORw0KGgo='

describe('the bookmarks domain', () => {
  let dir: string
  let store: BookmarkStore
  let clock: number
  let deps: { [K in keyof BookmarksDomainDeps]: BookmarksDomainDeps[K] & ReturnType<typeof vi.fn> }
  let call: (command: unknown) => Promise<unknown>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-bookmarks-domain-'))
    store = new BookmarkStore(join(dir, 'bookmarks.json'), counter(), () => 1000)
    clock = 0
    deps = {
      isPrivate: false,
      windowOf: vi.fn(() => WINDOW),
      open: vi.fn(() => true),
      openAll: vi.fn(() => 2),
      copyText: vi.fn(),
      importAvailable: vi.fn(() => true),
      runImport: vi.fn(),
      exportFile: vi.fn(async () => 'saved' as const),
      now: () => clock
    } as never
    const domain = bookmarksDomain(store, deps)
    call = async (command) => await domain.handle(command, CALLER)
  })
  afterEach(async () => {
    await store.flushPendingWrite()
    await rm(dir, { recursive: true, force: true })
  })

  const page = (title: string, parent = 'bar', url = `https://${title.toLowerCase().replace(/\W/g, '')}.example/`) => store.addUrl({ url, title, parent }) as NonNullable<ReturnType<typeof store.addUrl>>
  const folder = (title: string, parent = 'bar') => store.addFolder({ title, parent }) as NonNullable<ReturnType<typeof store.addFolder>>
  const titles = (parent: string): string[] => store.children(parent).map((node) => node.title)

  it('is for the Bookmarks page only', () => {
    expect(bookmarksDomain(store, deps).pages).toEqual(['bookmarks'])
  })

  it('lists the folders of the bar and Other bookmarks with depth and counts, and tells whether the page is private', async () => {
    const work = folder('Work')
    folder('Deep', work.id)
    page('One', work.id)

    const reply = await call({ type: 'tree' }) as { private: boolean, importAvailable: boolean, folders: Array<Record<string, unknown>> }

    expect(reply.private).toBe(false)
    expect(reply.importAvailable).toBe(true)
    expect(reply.folders.map((entry) => [entry['title'], entry['depth'], entry['folders'], entry['items']])).toEqual([
      ['Bookmarks bar', 0, 1, 1], ['Work', 1, 1, 2], ['Deep', 2, 0, 0], ['Other bookmarks', 0, 0, 0]
    ])
  })

  it('reads a folder with its path, in stored order, sending each icon once', async () => {
    const work = folder('Work')
    store.addUrl({ url: 'https://a.example/', title: 'A', favicon: ICON, parent: work.id })
    store.addUrl({ url: 'https://b.example/', title: 'B', favicon: ICON, parent: work.id })
    folder('Sub', work.id)

    const reply = await call({ type: 'children', id: work.id }) as { path: Array<{ title: string }>, rows: Array<Record<string, unknown>>, icons: string[] }

    expect(reply.path.map((part) => part.title)).toEqual(['Bookmarks bar', 'Work'])
    expect(reply.rows.map((row) => row['title'])).toEqual(['A', 'B', 'Sub'])
    expect(reply.icons).toHaveLength(1)
    expect(reply.rows.map((row) => row['icon'])).toEqual([0, 0, null])
    expect(reply.rows[2]).toMatchObject({ kind: 'folder', items: 0, pages: 0 })
  })

  it('refuses a wrong shape, an unknown id, the reading list, and an over-long id', async () => {
    const read = store.addUrl({ url: 'https://later.example/', title: 'Later', parent: 'reading' }) as NonNullable<ReturnType<typeof store.addUrl>>

    expect(await call({ type: 'children', id: 'nope' })).toBeUndefined()
    expect(await call({ type: 'children', id: 5 })).toBeUndefined()
    expect(await call({ type: 'children', id: 'reading' })).toBeUndefined()
    expect(await call({ type: 'children', id: 'x'.repeat(33) })).toBeUndefined()
    expect(await call({ type: 'remove', ids: [read.id] })).toBeUndefined()
    expect(await call({ type: 'nonsense' })).toBeUndefined()
    expect(await call(null)).toBeUndefined()
    expect(store.count()).toBe(1)
  })

  it('searches titles and addresses, with the folder path of each hit, and caps the results', async () => {
    const work = folder('Work')
    page('Design notes', work.id)
    page('Other', 'other')

    const reply = await call({ type: 'search', text: 'DESIGN' }) as { rows: Array<Record<string, unknown>>, more: boolean }

    expect(reply.rows).toHaveLength(1)
    expect(reply.rows[0]).toMatchObject({ title: 'Design notes', parent: work.id, path: ['Bookmarks bar', 'Work'] })
    expect(await call({ type: 'search', text: 7 })).toBeUndefined()

    for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i += 1) page(`bulk ${String(i)}`)
    const many = await call({ type: 'search', text: 'bulk' }) as { rows: unknown[], more: boolean }
    expect(many.rows).toHaveLength(MAX_SEARCH_RESULTS)
    expect(many.more).toBe(true)
  })

  it('adds a folder at an index in a folder of the bar or Other bookmarks only', async () => {
    page('A')

    const made = await call({ type: 'addFolder', parent: 'bar', index: 0, title: 'New folder' }) as { ok: boolean, id: string }

    expect(made.ok).toBe(true)
    expect(titles('bar')).toEqual(['New folder', 'A'])
    expect(await call({ type: 'addFolder', parent: 'reading', title: 'x' })).toBeUndefined()
    expect(await call({ type: 'addFolder', parent: 'bar', title: 5 })).toBeUndefined()
    expect(await call({ type: 'addFolder', parent: store.children('bar')[1]?.id, title: 'in a page' })).toEqual({ ok: false, reason: 'limit' })
  })

  it('updates a title and an address, and says why it did not', async () => {
    const one = page('One')
    const dir2 = folder('Dir')

    expect(await call({ type: 'update', id: one.id, title: 'Renamed' })).toEqual({ ok: true })
    expect(await call({ type: 'update', id: one.id, url: 'https://new.example/' })).toEqual({ ok: true })
    expect(store.node(one.id)).toMatchObject({ title: 'Renamed', url: 'https://new.example/' })
    expect(await call({ type: 'update', id: one.id, url: 'javascript:alert(1)' })).toEqual({ ok: false, reason: 'url' })
    expect(await call({ type: 'update', id: one.id, url: 'data:text/html,hi' })).toEqual({ ok: false, reason: 'url' })
    expect(await call({ type: 'update', id: dir2.id, url: 'https://a.example/' })).toEqual({ ok: false, reason: 'url' })
    expect(await call({ type: 'update', id: 'gone', title: 'x' })).toEqual({ ok: false, reason: 'missing' })
    expect(await call({ type: 'update', id: one.id })).toBeUndefined()
    expect(await call({ type: 'update', id: one.id, title: {} })).toBeUndefined()
    expect(await call({ type: 'update', id: one.id, title: 'x'.repeat(5000) })).toBeUndefined()
    expect(store.node(one.id)?.url).toBe('https://new.example/')
  })

  it('moves rows into a folder at an index, and refuses a folder into itself', async () => {
    const a = page('A')
    const b = page('B')
    const dir2 = folder('Dir')
    const inner = folder('Inner', dir2.id)

    expect(await call({ type: 'move', ids: [a.id], parent: dir2.id })).toEqual({ ok: true })
    expect(titles(dir2.id)).toEqual(['Inner', 'A'])
    expect(await call({ type: 'move', ids: [b.id], parent: dir2.id, index: 0 })).toEqual({ ok: true })
    expect(titles(dir2.id)).toEqual(['B', 'Inner', 'A'])
    expect(await call({ type: 'move', ids: [dir2.id], parent: inner.id })).toEqual({ ok: false })
    expect(await call({ type: 'move', ids: [], parent: 'bar' })).toBeUndefined()
    expect(await call({ type: 'move', ids: [a.id], parent: 'reading' })).toBeUndefined()
    expect(await call({ type: 'move', ids: ['nope'], parent: 'bar' })).toBeUndefined()
    expect(await call({ type: 'move', ids: Array.from({ length: MAX_IDS + 1 }, () => a.id), parent: 'bar' })).toBeUndefined()
  })

  it('removes a subtree, counts every item, and undo puts it back in the same place with the same shape', async () => {
    const a = page('A')
    const work = folder('Work')
    page('In work', work.id)
    store.addUrl({ url: 'https://ic.example/', title: 'Icon', favicon: ICON, parent: work.id })
    page('Z')

    const gone = await call({ type: 'remove', ids: [work.id, a.id] }) as { removed: number, items: number, undo: string }

    expect(gone.removed).toBe(2)
    expect(gone.items).toBe(4)
    expect(titles('bar')).toEqual(['Z'])
    const back = await call({ type: 'undo', token: gone.undo }) as { ok: boolean, ids: string[] }
    expect(back.ok).toBe(true)
    expect(back.ids).toHaveLength(2)
    expect(titles('bar')).toEqual(['A', 'Work', 'Z'])
    const restored = store.children('bar')[1] as NonNullable<ReturnType<typeof store.node>>
    expect(titles(restored.id)).toEqual(['In work', 'Icon'])
    expect(store.children(restored.id)[1]?.favicon).toBe(ICON)
    expect(back.ids).toEqual([store.children('bar')[0]?.id, restored.id])
  })

  it('drops a root from a delete, and answers a stale, repeated or wrong undo token with expired', async () => {
    const a = page('A')
    expect(await call({ type: 'remove', ids: ['bar'] })).toEqual({ removed: 0, items: 0, undo: null })
    expect(store.node('bar')).toBeDefined()

    const gone = await call({ type: 'remove', ids: [a.id] }) as { undo: string }
    expect(await call({ type: 'undo', token: 'wrong' })).toEqual({ ok: false, reason: 'expired' })
    expect(await call({ type: 'undo', token: gone.undo })).toMatchObject({ ok: true })
    expect(await call({ type: 'undo', token: gone.undo })).toEqual({ ok: false, reason: 'expired' })

    const b = page('B')
    const second = await call({ type: 'remove', ids: [b.id] }) as { undo: string }
    clock = UNDO_MS + 1
    expect(await call({ type: 'undo', token: second.undo })).toEqual({ ok: false, reason: 'expired' })
    expect(titles('bar')).toEqual(['A'])
  })

  it('holds only the last delete: an earlier token is no longer good', async () => {
    const work = folder('Work')
    const inside = page('Inside', work.id)
    const first = await call({ type: 'remove', ids: [inside.id] }) as { undo: string }
    await call({ type: 'remove', ids: [work.id] })

    expect(await call({ type: 'undo', token: first.undo })).toEqual({ ok: false, reason: 'expired' })
  })

  it('keeps no undo for a delete too big to hold', async () => {
    const big = folder('Big')
    store.importTree(big.id, Array.from({ length: 2_001 }, (_, i) => ({ kind: 'url' as const, title: String(i), url: `https://h${String(i)}.example/` })))

    const reply = await call({ type: 'remove', ids: [big.id] }) as { removed: number, items: number, undo: string | null }

    expect(reply.removed).toBe(1)
    expect(reply.items).toBe(2_002)
    expect(reply.undo).toBeNull()
  })

  it('opens by id with each disposition through the opener, and refuses others', async () => {
    const one = page('One')
    for (const disposition of ['current', 'tab', 'background', 'window', 'private'] as const) {
      expect(await call({ type: 'open', id: one.id, disposition })).toEqual({ ok: true })
      expect(deps.open).toHaveBeenLastCalledWith(WINDOW, one.id, disposition)
    }
    expect(await call({ type: 'open', id: one.id, disposition: 'popup' })).toBeUndefined()
    expect(await call({ type: 'open', id: 'nope', disposition: 'tab' })).toBeUndefined()
    deps.windowOf.mockReturnValueOnce(undefined)
    expect(await call({ type: 'open', id: one.id, disposition: 'tab' })).toEqual({ ok: false })

    const dir2 = folder('Dir')
    expect(await call({ type: 'openAll', id: dir2.id })).toEqual({ ok: true, opened: 2 })
    expect(deps.openAll).toHaveBeenCalledWith(WINDOW, dir2.id)
  })

  it('copies the addresses of the pages it is given, never a page supplied text', async () => {
    const one = page('One')
    const two = page('Two')
    const dir2 = folder('Dir')

    expect(await call({ type: 'copy', ids: [one.id, dir2.id, two.id] })).toEqual({ ok: true, count: 2 })
    expect(deps.copyText).toHaveBeenCalledWith('https://one.example/\nhttps://two.example/')
    expect(await call({ type: 'copy', ids: ['https://evil.example/'] })).toBeUndefined()
  })

  it('exports the bookmarks through the save dialog and answers cancelled and write failures', async () => {
    page('One')
    folder('Dir')
    page('Two', 'other')

    expect(await call({ type: 'export' })).toEqual({ ok: true, count: 2 })
    expect(deps.exportFile).toHaveBeenCalledWith(WINDOW.window, expect.objectContaining({ bar: expect.any(Array), other: expect.any(Array) }))
    deps.exportFile.mockResolvedValueOnce('cancelled')
    expect(await call({ type: 'export' })).toEqual({ ok: false, reason: 'cancelled' })
    deps.exportFile.mockResolvedValueOnce('write')
    expect(await call({ type: 'export' })).toEqual({ ok: false, reason: 'write' })
  })

  it('runs the import command only while it exists', async () => {
    expect(await call({ type: 'import' })).toEqual({ ok: true })
    expect(deps.runImport).toHaveBeenCalledWith(WINDOW)
    deps.importAvailable.mockReturnValue(false)
    expect(await call({ type: 'import' })).toEqual({ ok: false })
    expect(deps.runImport).toHaveBeenCalledTimes(1)
  })
})
