import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { fakeWindow } from './panel-fakes.js'
import type { FakeWindow } from './panel-fakes.js'
import { createSidePanelHandler, DEFAULT_OPEN, REFRESH_MS, sidePanelOverlay } from '../side-panel-overlay.js'
import { createSidePanel, setGuestEntries, wireSidePanel } from '../side-panel-host.js'
import type { PanelHost } from '../side-panel-host.js'
import { MemorySidePanelStore } from '../side-panel-store.js'
import { registerStore } from '../side-panel-stores.js'

const openAddress = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../shell/bookmarks-bar/open-bookmark.js', () => ({ openAddress }))
const popup = vi.hoisted(() => vi.fn())
const copyLink = vi.hoisted(() => vi.fn())
vi.mock('../row-menu-runner.js', () => ({ popupRowMenu: popup, copyLink }))

interface Watch { changed: () => void, stop: ReturnType<typeof vi.fn> }

let win: FakeWindow
let host: PanelHost
let handler: OverlayHandler
let events: unknown[]
const bookmarkWatch: Watch = { changed: () => {}, stop: vi.fn() }
const nodes = new Map<string, { id: string, parent: string, kind: 'url' | 'folder', title: string, url?: string, favicon: null, added: number }>()
const store = {
  children: (parent: string) => [...nodes.values()].filter((node) => node.parent === parent),
  node: (id: string) => nodes.get(id),
  search: (text: string) => [...nodes.values()].filter((node) => node.kind === 'url' && node.title.toLowerCase().includes(text.toLowerCase())),
  remove: vi.fn((ids: string[]) => { for (const id of ids) nodes.delete(id) }),
  update: vi.fn(),
  onChange: vi.fn((listener: () => void) => { bookmarkWatch.changed = listener; return bookmarkWatch.stop })
}

function seed (): void {
  nodes.clear()
  nodes.set('a', { id: 'a', parent: 'bar', kind: 'url', title: 'Alpha', url: 'https://alpha.example/', favicon: null, added: 1 })
  nodes.set('f', { id: 'f', parent: 'bar', kind: 'folder', title: 'Folder', favicon: null, added: 2 })
}

beforeEach(() => {
  vi.useFakeTimers()
  seed()
  openAddress.mockClear()
  popup.mockClear()
  copyLink.mockClear()
  store.remove.mockClear()
  store.update.mockClear()
  store.onChange.mockClear()
  bookmarkWatch.stop.mockClear()
  win = fakeWindow()
  const services = win.ctx.services as unknown as Record<string, unknown>
  Object.assign(services, { bookmarks: store, history: { listOrdered: vi.fn(() => []), pagesByIds: vi.fn(() => []), remove: vi.fn(), onChange: vi.fn(() => () => {}) }, downloads: { list: () => [], open: vi.fn(), onChange: vi.fn(() => () => {}) } })
  registerStore(services as unknown as ShellServices, new MemorySidePanelStore())
  wireSidePanel(win.ctx.window.window, win.wiring)
  host = createSidePanel(win.ctx)
  setGuestEntries([])
  events = []
  handler = createSidePanelHandler({ ...win.ctx, send: (event) => { events.push(event) }, close: () => { host.close() } } as OverlayWindow)
})

afterEach(() => { vi.useRealTimers() })

const ask = (command: unknown): unknown => handler.request(command)

describe('the overlay declaration', () => {
  it('docks beside the page, stays through tab switches, resizes and blur, and keeps its page warm', () => {
    expect(sidePanelOverlay).toMatchObject({
      name: 'side-panel', placement: { kind: 'dock' }, focus: 'take', layer: 'bar', keep: 'warm',
      closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false }
    })
  })
})

describe('what the page is shown', () => {
  it('lists the views, the entries, the side, the width and its limits, with the rows of the current view', () => {
    setGuestEntries([{ id: 'ext:abcdef', title: 'Notes' }])
    const shown = handler.show?.(undefined) as Record<string, unknown>

    expect(shown).toMatchObject({ view: 'bookmarks', guest: null, side: 'right', width: 360, limits: { min: 280, max: 640, reset: 360 }, isPrivate: false, defaultOpen: DEFAULT_OPEN })
    expect((shown['views'] as Array<{ id: string }>).map((view) => view.id)).toEqual(['bookmarks', 'history', 'reading', 'downloads'])
    expect(shown['guests']).toEqual([{ id: 'ext:abcdef', title: 'Notes' }])
    expect((shown['rows'] as Array<{ title: string }>).map((row) => row.title)).toEqual(['Bookmarks bar', 'Alpha', 'Folder'])
  })

  it('says a private window keeps no history, and an ordinary one what will appear', () => {
    const plain = handler.show?.(undefined) as { views: Array<{ id: string, empty: string, removable: boolean }> }
    expect(plain.views.find((view) => view.id === 'history')?.empty).toBe('Pages you visit appear here.')
    expect(plain.views.map((view) => view.removable)).toEqual([true, true, true, false])

    ;(win.ctx.services as unknown as { isPrivate: boolean }).isPrivate = true
    const priv = handler.show?.(undefined) as { views: Array<{ id: string, empty: string }>, isPrivate: boolean }
    expect(priv.isPrivate).toBe(true)
    expect(priv.views.find((view) => view.id === 'history')?.empty).toBe('Private windows keep no history.')
  })
})

describe('requests', () => {
  it('answers rows for a registered view, and nothing for an unknown one', () => {
    expect(ask({ type: 'rows', view: 'bookmarks', query: 'alp', open: [] })).toEqual({ view: 'bookmarks', rows: [expect.objectContaining({ title: 'Alpha', sub: 'alpha.example' })] })
    expect(ask({ type: 'rows', view: 'bookmarks', query: '', open: ['bar'] })).toMatchObject({ rows: [{ title: 'Bookmarks bar', expanded: true }, { title: 'Alpha' }, { title: 'Folder' }] })
    expect(ask({ type: 'rows', view: 'no-such-view', query: '', open: [] })).toEqual({ view: 'no-such-view', rows: [] })
  })

  it('opens a row from the address its store holds, in the way asked', () => {
    ask({ type: 'open', view: 'bookmarks', id: 'a', how: 'background' })
    expect(openAddress).toHaveBeenCalledWith(expect.anything(), 'https://alpha.example/', 'background')
    host.open()
    ask({ type: 'open', view: 'bookmarks', id: 'a', how: 'current' })
    expect(win.activeFocus).toHaveBeenCalled()
  })

  it('opens nothing for an id the store does not hold, a folder, or a view that is not registered', () => {
    ask({ type: 'open', view: 'bookmarks', id: 'missing', how: 'current' })
    ask({ type: 'open', view: 'bookmarks', id: 'f', how: 'current' })
    ask({ type: 'open', view: 'imaginary', id: 'a', how: 'current' })
    expect(openAddress).not.toHaveBeenCalled()
  })

  it('never takes an address from the page', () => {
    ask({ type: 'open', view: 'bookmarks', id: 'a', how: 'current', url: 'https://evil.example/' })
    expect(openAddress).toHaveBeenCalledWith(expect.anything(), 'https://alpha.example/', 'current')
  })

  it('marks a reading list page read once it opened, and not when it did not', () => {
    nodes.set('r', { id: 'r', parent: 'reading', kind: 'url', title: 'Later', url: 'https://later.example/', favicon: null, added: 3 })
    ask({ type: 'open', view: 'reading', id: 'r', how: 'current' })
    expect(store.update).toHaveBeenCalledWith('r', { read: true })
    openAddress.mockReturnValueOnce(false)
    store.update.mockClear()
    ask({ type: 'open', view: 'reading', id: 'r', how: 'current' })
    expect(store.update).not.toHaveBeenCalled()
  })

  it('removes a row by id in a view that removes', () => {
    ask({ type: 'remove', view: 'bookmarks', id: 'a' })
    expect(store.remove).toHaveBeenCalledWith(['a'])
    ask({ type: 'remove', view: 'downloads', id: 'd1' })
    ask({ type: 'remove', view: 'imaginary', id: 'a' })
  })

  it('switches view, refusing one nobody lists', () => {
    host.open()
    ask({ type: 'view', view: 'history' })
    expect(host.view()).toBe('history')
    ask({ type: 'view', view: 'no-such' })
    ask({ type: 'view', view: 'ext:unlisted' })
    expect(host.view()).toBe('history')
  })

  it('opens the full page of a view that has one, in a tab', () => {
    ask({ type: 'page', view: 'history' })
    expect((win.ctx.window.tabs.openInternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('history')
    ask({ type: 'page', view: 'bookmarks' })
    expect((win.ctx.window.tabs.openInternal as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
  })

  it('clamps a resize in main, closes on request and focuses the page on request', async () => {
    host.open()
    ask({ type: 'resize', width: 1_000_000 })
    await vi.advanceTimersByTimeAsync(5)
    expect(host.width()).toBe(640)
    ask({ type: 'focus-page' })
    expect(win.activeFocus).toHaveBeenCalled()
    ask({ type: 'close' })
    expect(host.isOpen()).toBe(false)
  })

  it('ignores anything it does not list, and a malformed request', () => {
    for (const bad of [undefined, 'close', { type: 'setGuest' }, { type: 'rows', view: 'bookmarks' }, { type: 'resize', width: 'wide' }]) expect(ask(bad)).toBeUndefined()
    expect(openAddress).not.toHaveBeenCalled()
  })
})

describe('the row menu', () => {
  const items = (): Array<{ label?: string, click?: () => void }> => (popup.mock.calls[0] as unknown[])[1] as never

  it('pops a menu for a row that opens an address, with what each item does', () => {
    ask({ type: 'menu', view: 'bookmarks', id: 'a' })
    expect(items().map((item) => item.label)).toEqual(['Open in New Tab', 'Open in New Window', undefined, 'Copy Link', 'Delete'])
    items()[0]?.click?.()
    items()[1]?.click?.()
    items()[3]?.click?.()
    items()[4]?.click?.()
    expect(openAddress).toHaveBeenNthCalledWith(1, expect.anything(), 'https://alpha.example/', 'background')
    expect(openAddress).toHaveBeenNthCalledWith(2, expect.anything(), 'https://alpha.example/', 'window')
    expect(copyLink).toHaveBeenCalledWith('https://alpha.example/')
    expect(store.remove).toHaveBeenCalledWith(['a'])
  })

  it('pops nothing for a folder, an unknown id, a view that opens no address, or an unknown view', () => {
    ask({ type: 'menu', view: 'bookmarks', id: 'f' })
    ask({ type: 'menu', view: 'bookmarks', id: 'missing' })
    ask({ type: 'menu', view: 'downloads', id: 'd1' })
    ask({ type: 'menu', view: 'imaginary', id: 'a' })
    expect(popup).not.toHaveBeenCalled()
  })
})

describe('keeping the list current', () => {
  it('refreshes the open view once for a burst of changes in its store', () => {
    handler.show?.(undefined)
    expect(store.onChange).toHaveBeenCalledTimes(1)
    bookmarkWatch.changed()
    bookmarkWatch.changed()
    bookmarkWatch.changed()
    expect(events).toEqual([])
    vi.advanceTimersByTime(REFRESH_MS)
    expect(events).toEqual([{ type: 'changed', view: 'bookmarks' }])
  })

  it('follows the store of whichever view is showing, and stops following the old one', () => {
    host.open()
    handler.show?.(undefined)
    host.choose('history')
    expect(bookmarkWatch.stop).toHaveBeenCalledTimes(1)
    host.choose('downloads')
  })

  it('stops watching when the panel closes, and tells the host it closed', () => {
    host.open()
    handler.show?.(undefined)
    handler.closed?.('request')
    expect(bookmarkWatch.stop).toHaveBeenCalledTimes(1)
    bookmarkWatch.changed()
    vi.advanceTimersByTime(REFRESH_MS * 2)
    expect(events).toEqual([])
  })

  it('lets the host know the window moved the panel', () => {
    const moved = vi.spyOn(host, 'moved')
    handler.moved?.()
    expect(moved).toHaveBeenCalledTimes(1)
  })
})
