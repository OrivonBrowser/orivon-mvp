import { describe, expect, it, vi } from 'vitest'
import type { WindowContext } from '../../window-context.js'
import { BookmarkStore } from '../../../browsing/bookmarks.js'
import { asAnchor, bookmarkEdit } from '../edit-action.js'

const anchor = { x: 10, y: 20, width: 30, height: 40 }

function setup (active: Record<string, unknown> | undefined = { id: 't', url: 'https://a.example/', title: 'A', isNewTab: false, isInternal: false }): { ctx: WindowContext, store: BookmarkStore, show: ReturnType<typeof vi.fn>, toggle: ReturnType<typeof vi.fn> } {
  let n = 0
  const store = new BookmarkStore('/nowhere/bookmarks.json', () => `id${String(n++)}`, () => 1)
  const show = vi.fn()
  const toggle = vi.fn()
  const window = {
    tabs: { getState: () => ({ tabs: active === undefined ? [] : [active], activeTabId: active?.['id'] ?? null }), faviconFor: () => null },
    overlays: { show, toggle }
  }
  return { ctx: { window, services: { bookmarks: store } } as unknown as WindowContext, store, show, toggle }
}

describe('bookmarks.edit', () => {
  it('checks the rectangle field by field', () => {
    expect(asAnchor(anchor)).toEqual(anchor)
    for (const bad of [undefined, null, 'x', {}, { ...anchor, x: NaN }, { ...anchor, width: '3' }, { ...anchor, height: Infinity }]) expect(asAnchor(bad)).toBeUndefined()
  })

  it('saves the page on the star click, says so, and toggles the bubble under the star', () => {
    const { ctx, store, toggle } = setup()
    bookmarkEdit({ anchor, add: true, toggle: true }, ctx)
    const saved = store.findByUrl('https://a.example/')
    expect(saved).toHaveLength(1)
    expect(toggle).toHaveBeenCalledWith('bookmark-edit', anchor, { mode: 'added', id: saved[0]?.id }, undefined)
  })

  it('judges the star\'s click by the press it completes, so a held click that closed the bubble leaves it closed', () => {
    const { ctx, store, toggle } = setup()
    store.addUrl({ url: 'https://a.example/', title: 'A' })
    const takePress = vi.fn(() => 1234)
    bookmarkEdit({ anchor, add: true, toggle: true }, { ...ctx, takePress })
    expect(takePress).toHaveBeenCalledWith('bookmark-edit')
    expect(toggle.mock.calls[0]?.[3]).toBe(1234)
  })

  it('opens the bubble on a saved page without saving it again or removing it, titled for editing', () => {
    const { ctx, store, show, toggle } = setup()
    const node = store.addUrl({ url: 'https://a.example/', title: 'A' }) as { id: string }
    bookmarkEdit({ anchor, add: true, toggle: true }, ctx)
    bookmarkEdit({ anchor }, ctx)
    expect(store.findByUrl('https://a.example/')).toHaveLength(1)
    expect(toggle).toHaveBeenCalledWith('bookmark-edit', anchor, { mode: 'edit', id: node.id }, undefined)
    expect(show).toHaveBeenCalledWith('bookmark-edit', anchor, { mode: 'edit', id: node.id })
  })

  it('does nothing for a page with no site, an unsaved page that was not asked to be saved, or a bad payload', () => {
    const blank = setup({ id: 't', url: 'about:blank', title: '', isNewTab: true, isInternal: false })
    bookmarkEdit({ anchor, add: true }, blank.ctx)
    const internal = setup({ id: 't', url: 'orivon://settings', title: 'S', isNewTab: false, isInternal: true })
    bookmarkEdit({ anchor, add: true }, internal.ctx)
    const plain = setup()
    bookmarkEdit({ anchor }, plain.ctx)
    for (const bad of [undefined, null, 'x', { id: 4 }, { mode: 'remove' }, { id: 'gone' }]) bookmarkEdit(bad, plain.ctx)
    for (const { show, toggle, store } of [blank, internal, plain]) {
      expect(show).not.toHaveBeenCalled()
      expect(toggle).not.toHaveBeenCalled()
      expect(store.count()).toBe(0)
    }
  })

  it('opens the bubble for a bookmark by id, and for a folder by the modes it lists', () => {
    const { ctx, store, show } = setup()
    const folder = store.addFolder({ title: 'F', parent: 'bar' }) as { id: string }
    bookmarkEdit({ id: folder.id, mode: 'rename-folder' }, ctx)
    expect(show).toHaveBeenCalledWith('bookmark-edit', undefined, { mode: 'rename-folder', id: folder.id })
  })
})
