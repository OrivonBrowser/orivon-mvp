import { describe, expect, it, vi } from 'vitest'
import { asFolderRequest, asFrom, folderModel, MAX_ROWS } from '../folder-model.js'
import { bookmarkFolderOverlay, clickOnFolder } from '../folder-overlay.js'
import type { OverlayWindow } from '../../../overlays/overlay-types.js'
import type { ShellWindow } from '../../window-registry.js'
import { harness, tiny } from './harness.js'

vi.mock('electron', () => ({ Menu: {}, clipboard: {} }))

describe('the folder model', () => {
  it('lists a folder\'s rows with favicons for pages, names the pages Open all would open, and refuses what is not a bar or Other folder', () => {
    const { store } = harness()
    const folder = store.addFolder({ title: 'Work', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>
    store.addUrl({ url: 'https://a.example/', title: 'A', favicon: tiny, parent: folder.id })
    store.addFolder({ title: 'Sub', parent: folder.id })
    const page = store.addUrl({ url: 'https://b.example/', title: 'B', parent: folder.id }) as NonNullable<ReturnType<typeof store.addUrl>>
    const reading = store.addUrl({ url: 'https://r.example/', title: 'R', parent: 'reading' }) as NonNullable<ReturnType<typeof store.addUrl>>

    expect(folderModel(store, folder.id)).toEqual({
      id: folder.id, title: 'Work', more: 0, pages: 2, openAllLimit: 25,
      rows: [
        { id: 'id1', kind: 'url', title: 'A', url: 'https://a.example/', favicon: tiny },
        { id: 'id2', kind: 'folder', title: 'Sub' },
        { id: page.id, kind: 'url', title: 'B', url: 'https://b.example/', favicon: null }
      ]
    })
    expect(folderModel(store, page.id)).toBeNull()
    expect(folderModel(store, 'nope')).toBeNull()
    expect(folderModel(store, 'reading')).toBeNull()
    expect(folderModel(store, reading.id)).toBeNull()
  })

  it('lists the bar from an index for the overflow menu, and caps a very long list', () => {
    const { store } = harness()
    for (let i = 0; i < MAX_ROWS + 5; i += 1) store.addUrl({ url: `https://h${String(i)}.example/`, title: String(i) })

    const overflow = folderModel(store, 'bar', MAX_ROWS)
    expect(overflow?.rows).toHaveLength(5)
    expect(overflow?.from).toBe(MAX_ROWS)
    const all = folderModel(store, 'bar')
    expect(all?.rows).toHaveLength(MAX_ROWS)
    expect(all?.more).toBe(5)
  })

  it('reads a request from the page, and refuses any that is not exactly one it lists', () => {
    expect(asFolderRequest({ type: 'children', id: 'x' })).toEqual({ type: 'children', id: 'x' })
    expect(asFolderRequest({ type: 'children', id: 'x', from: 3 })).toEqual({ type: 'children', id: 'x', from: 3 })
    expect(asFolderRequest({ type: 'open', id: 'x', disposition: 'background' })).toEqual({ type: 'open', id: 'x', disposition: 'background' })
    expect(asFolderRequest({ type: 'openAll', id: 'x' })).toEqual({ type: 'openAll', id: 'x' })
    expect(asFolderRequest({ type: 'menu', id: 'x' })).toEqual({ type: 'menu', id: 'x' })
    expect(asFolderRequest({ type: 'remove', id: 'x' })).toEqual({ type: 'remove', id: 'x' })
    expect(asFolderRequest({ type: 'remove', id: 'x', from: 2 })).toEqual({ type: 'remove', id: 'x', from: 2 })
    for (const bad of [undefined, null, 'x', 7, {}, { type: 'children' }, { type: 'children', id: '' }, { type: 'children', id: 'x', from: -1 }, { type: 'children', id: 'x', from: 1.5 }, { type: 'menu', id: '' }, { type: 'remove', id: '' }, { type: 'remove', id: 'x', from: -1 }, { type: 'menu' },
      { type: 'open', id: 'x' }, { type: 'open', id: 'x', disposition: 'private' }, { type: 'open', id: 3, disposition: 'current' }, { type: 'delete', id: 'x' }]) {
      expect(asFolderRequest(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(asFrom(undefined)).toBeUndefined()
    expect(asFrom('3')).toBeNull()
  })
})

describe('the folder overlay', () => {
  function attached (): { h: ReturnType<typeof harness>, handler: ReturnType<typeof bookmarkFolderOverlay.attach> } {
    const h = harness()
    const win = { ...h.ctx, send: () => {}, close: h.overlays.close } as unknown as OverlayWindow
    return { h, handler: bookmarkFolderOverlay.attach(win) }
  }

  it('answers a show for a folder with its model, and for anything else with nothing', () => {
    const { h, handler } = attached()
    const folder = h.store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof h.store.addFolder>>

    expect(handler.show?.({ id: folder.id })).toMatchObject({ id: folder.id, rows: [] })
    expect(handler.show?.({ id: 'nope' })).toBeNull()
    expect(handler.show?.({ id: folder.id, from: -1 })).toBeNull()
    expect(handler.show?.(null)).toBeNull()
    expect(handler.show?.('x')).toBeNull()
  })

  it('opens a page by id from the store, closing itself, and opens a folder\'s pages with Open all', () => {
    const { h, handler } = attached()
    const folder = h.store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof h.store.addFolder>>
    const page = h.store.addUrl({ url: 'https://a.example/', title: 'A', parent: folder.id }) as NonNullable<ReturnType<typeof h.store.addUrl>>

    handler.request({ type: 'open', id: page.id, disposition: 'current' })
    expect(h.tabs.navigate).toHaveBeenCalledWith('a', 'https://a.example/')
    handler.request({ type: 'openAll', id: folder.id })
    expect(h.tabs.createTab).toHaveBeenCalledWith('https://a.example/', true)
    expect(h.overlays.close).toHaveBeenCalledTimes(2)
  })

  it('does nothing for a request it does not list', () => {
    const { h, handler } = attached()

    expect(handler.request({ type: 'open', id: 'nope', disposition: 'current' })).toBeUndefined()
    expect(handler.request({ type: 'rm -rf' })).toBeUndefined()
    expect(handler.request(null)).toBeUndefined()
    expect(h.tabs.navigate).not.toHaveBeenCalled()
  })

  it('remembers which folder a menu was dismissed from, so the click that caused it is not a second open', () => {
    const { h, handler } = attached()
    const window = h.ctx.window as ShellWindow
    const folder = h.store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof h.store.addFolder>>
    const other = h.store.addFolder({ title: 'G', parent: 'bar' }) as NonNullable<ReturnType<typeof h.store.addFolder>>
    const now = Date.now()

    expect(clickOnFolder(window, folder.id, now)).toBe('show')
    handler.show?.({ id: folder.id })
    h.overlays.isOpen.mockReturnValue(true)
    expect(clickOnFolder(window, folder.id, now)).toBe('close')
    expect(clickOnFolder(window, other.id, now)).toBe('show')

    h.overlays.isOpen.mockReturnValue(false)
    handler.closed?.('blur')
    expect(clickOnFolder(window, folder.id, now)).toBe('ignore')
    expect(clickOnFolder(window, other.id, now)).toBe('show')
    expect(clickOnFolder(window, folder.id, now + 1000)).toBe('show')
  })

  it('judges a click by the press it completes: held long, the press that dismissed the menu still does not reopen it', () => {
    const { h, handler } = attached()
    const window = h.ctx.window as ShellWindow
    const folder = h.store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof h.store.addFolder>>
    const pressedAt = Date.now() - 10
    handler.show?.({ id: folder.id })
    handler.closed?.('blur')
    expect(clickOnFolder(window, folder.id, pressedAt + 2000, pressedAt)).toBe('ignore')
    expect(clickOnFolder(window, folder.id, Date.now() + 2000, Date.now() + 1000)).toBe('show')
  })
})
