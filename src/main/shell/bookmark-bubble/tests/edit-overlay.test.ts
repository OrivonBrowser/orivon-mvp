import { describe, expect, it, vi } from 'vitest'
import { BookmarkStore } from '../../../browsing/bookmarks.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../../../overlays/overlay-types.js'
import { ALL_TABS_OVERLAY, EDIT_OVERLAY, lastFolderOf } from '../bubble-state.js'
import { bookmarkAllTabsOverlay, bookmarkEditOverlay } from '../edit-overlay.js'

const tiny = 'data:image/png;base64,iVBORw0KGgo='

function setup (def: OverlayDef, tabs: Array<Record<string, unknown>> = []): { handler: OverlayHandler, store: BookmarkStore, close: ReturnType<typeof vi.fn>, changes: () => number } {
  let n = 0
  const store = new BookmarkStore('/nowhere/bookmarks.json', () => `id${String(n++)}`, () => 1)
  let changes = 0
  store.onChange(() => { changes += 1 })
  const close = vi.fn()
  const win = {
    window: { tabs: { getState: () => ({ tabs, activeTabId: null }), faviconFor: (id: string) => id === 'a' ? tiny : null } },
    services: { bookmarks: store },
    send: vi.fn(),
    close
  } as unknown as OverlayWindow
  return { handler: def.attach(win), store, close, changes: () => changes }
}

const page = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, url: `https://${id}.example/`, title: id, isNewTab: false, isInternal: false, ...extra })

describe('the bookmark bubble overlay', () => {
  it('is declared as a bubble under the star and a sheet at the top of the page, both closing on navigation', () => {
    expect(bookmarkEditOverlay).toMatchObject({ name: EDIT_OVERLAY, placement: { kind: 'anchor', width: 320, align: 'left' }, focus: 'take', layer: 'popup', keep: 'fresh' })
    expect(bookmarkAllTabsOverlay).toMatchObject({ name: ALL_TABS_OVERLAY, placement: { kind: 'area', at: 'top-center', width: 360 }, focus: 'take', layer: 'popup', keep: 'fresh' })
    expect(bookmarkEditOverlay.closeOn.navigation).toBe(true)
    expect(bookmarkAllTabsOverlay.closeOn.navigation).toBe(true)
  })

  it('shows a bookmark, and nothing for a bad payload or one that is gone', () => {
    const { handler, store } = setup(bookmarkEditOverlay)
    const node = store.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    expect(handler.show?.({ mode: 'added', id: node.id })).toMatchObject({ mode: 'added', id: node.id, title: 'A' })
    for (const bad of [undefined, null, {}, { mode: 'edit' }, { mode: 'nope', id: node.id }, { mode: 'edit', id: 4 }, { mode: 'edit', id: 'gone' }]) expect(handler.show?.(bad), JSON.stringify(bad)).toBeUndefined()
  })

  it('saves the name and the folder of the bookmark it was opened for, and remembers the folder', () => {
    const { handler, store } = setup(bookmarkEditOverlay)
    const work = store.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const node = store.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    handler.show?.({ mode: 'edit', id: node.id })
    expect(handler.request({ type: 'save', id: node.id, title: 'B', parent: work.id })).toEqual({ ok: true })
    expect(store.node(node.id)).toMatchObject({ title: 'B', parent: work.id })
    expect(lastFolderOf(store)).toBe(work.id)
  })

  it('answers nothing to a command for another bookmark, before a show, or of a shape it does not list', () => {
    const { handler, store, changes } = setup(bookmarkEditOverlay)
    const node = store.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    const other = store.addUrl({ url: 'https://b.example/', title: 'B' }) as { id: string }
    const before = changes()
    expect(handler.request({ type: 'remove', id: node.id })).toBeUndefined()
    handler.show?.({ mode: 'edit', id: node.id })
    for (const bad of [{ type: 'save', id: other.id, title: 'x', parent: 'bar' }, { type: 'remove', id: other.id }, { type: 'saveAll', title: 'x', parent: 'bar' },
      { type: 'saveFolder', title: 'x' }, { type: 'save', id: node.id, title: 'x', parent: 'bar', url: 'javascript:1' }, 'save', null]) {
      expect(handler.request(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(changes()).toBe(before)
    expect(store.node(other.id)?.title).toBe('B')
  })

  it('removes the bookmark, closes, and leaves a missing id alone', () => {
    const { handler, store, close } = setup(bookmarkEditOverlay)
    const first = store.addUrl({ url: 'https://a.example/', title: 'first' }) as { id: string }
    const second = store.addUrl({ url: 'https://a.example/', title: 'second' }) as { id: string }
    handler.show?.({ mode: 'edit', id: second.id })
    expect(handler.request({ type: 'remove', id: second.id })).toEqual({ ok: true })
    expect(close).toHaveBeenCalledTimes(1)
    expect(store.findByUrl('https://a.example/').map((node) => node.id)).toEqual([first.id])
    // Already gone: a second remove reports it and changes nothing.
    expect(handler.request({ type: 'remove', id: second.id })).toEqual({ ok: false })
  })

  it('renames a folder, and makes a new one in the place it was opened for, closing after', () => {
    const rename = setup(bookmarkEditOverlay)
    const work = rename.store.addFolder({ title: 'Work', parent: 'bar' }) as { id: string }
    const other = rename.store.addFolder({ title: 'Other', parent: 'bar' }) as { id: string }
    rename.handler.show?.({ mode: 'rename-folder', id: work.id })
    expect(rename.handler.request({ type: 'saveFolder', id: other.id, title: 'Hijack' })).toEqual({ ok: false })
    expect(rename.handler.request({ type: 'saveFolder', id: work.id, title: 'Jobs' })).toEqual({ ok: true })
    expect(rename.store.node(work.id)?.title).toBe('Jobs')
    expect(rename.store.node(other.id)?.title).toBe('Other')
    expect(rename.close).toHaveBeenCalledTimes(1)

    const made = setup(bookmarkEditOverlay)
    made.handler.show?.({ mode: 'new-folder', id: 'bar' })
    // The page may name a parent: it is ignored, the folder goes where the bubble was opened.
    expect(made.handler.request({ type: 'saveFolder', parent: 'other', title: 'Fresh' })).toMatchObject({ ok: true })
    expect(made.store.children('bar').map((node) => node.title)).toEqual(['Fresh'])
    expect(made.handler.request({ type: 'save', id: 'x', title: 'y', parent: 'bar' })).toBeUndefined()
  })

  it('forgets what it showed when it closes', () => {
    const { handler, store } = setup(bookmarkEditOverlay)
    const node = store.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    handler.show?.({ mode: 'edit', id: node.id })
    handler.closed?.('blur')
    expect(handler.request({ type: 'remove', id: node.id })).toBeUndefined()
  })
})

describe('the bookmark all tabs overlay', () => {
  it('counts the tabs with a site on show, and offers nothing when none has', () => {
    const tabs = [page('a'), page('n', { isNewTab: true }), page('b')]
    const shown = setup(bookmarkAllTabsOverlay, tabs).handler.show?.(undefined) as { count: number, title: string, parent: string }
    expect(shown).toMatchObject({ count: 2, parent: 'bar' })
    expect(shown.title).toMatch(/^Tabs from /)
    expect(setup(bookmarkAllTabsOverlay, [page('n', { isNewTab: true })]).handler.show?.(undefined)).toBeUndefined()
  })

  it('saves in one store change, reading the tabs again in main, and closes', () => {
    const tabs = [page('a'), page('n', { isNewTab: true }), page('b')]
    const { handler, store, close, changes } = setup(bookmarkAllTabsOverlay, tabs)
    const before = changes()
    expect(handler.request({ type: 'saveAll', title: 'Everything', parent: 'other' })).toEqual({ ok: true, saved: 2 })
    expect(changes() - before).toBe(1)
    const folder = store.children('other')[0]
    expect(folder?.title).toBe('Everything')
    expect(store.children(folder?.id as string).map((node) => node.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('refuses a command that is not saveAll, the reading list, and a count the page made up', () => {
    const { handler, store, close } = setup(bookmarkAllTabsOverlay, [page('a')])
    expect(handler.request({ type: 'remove', id: 'a' })).toBeUndefined()
    expect(handler.request({ type: 'saveAll', title: 'x', parent: 'reading', count: 50 })).toBeUndefined()
    expect(handler.request({ type: 'saveAll', title: 'x', parent: 'reading' })).toEqual({ ok: false, saved: 0 })
    expect(store.children('reading')).toEqual([])
    expect(close).not.toHaveBeenCalled()
  })
})
