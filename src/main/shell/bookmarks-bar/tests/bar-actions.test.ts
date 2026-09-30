import { beforeEach, describe, expect, it, vi } from 'vitest'

const popups: Array<{ template: Array<{ label?: string, click?: () => void }>, options: unknown }> = []
const copied: string[] = []
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: never) => ({ popup: (options: unknown) => { popups.push({ template, options }) } }) },
  clipboard: { writeText: (text: string) => { copied.push(text) } }
}))

const { CHROME_ACTIONS, runChromeAction } = await import('../../chrome-actions.js')
const { bookmarkEdit } = await import('../../bookmark-bubble/edit-action.js')
const { barFolder, barItems, barMenu, barMove, barOpen } = await import('../bar-actions.js')
const { harness } = await import('./harness.js')
const { commandById } = await import('../../../shortcuts/commands.js')

// The menu lists the manager row once its command stops being a stub.
const MANAGER = commandById('bookmarks.open')?.pending === true ? [] : ['Bookmark Manager']

const anchor = { x: 10, y: 50, width: 80, height: 28 }

beforeEach(() => { popups.length = 0; copied.length = 0 })

describe('the bookmarks chrome actions', () => {
  it('are registered under their names', () => {
    expect(CHROME_ACTIONS['bookmarks.bar']).toBe(barItems)
    expect(CHROME_ACTIONS['bookmarks.edit']).toBe(bookmarkEdit)
    expect(CHROME_ACTIONS['bookmarks.folder']).toBe(barFolder)
    expect(CHROME_ACTIONS['bookmarks.menu']).toBe(barMenu)
    expect(CHROME_ACTIONS['bookmarks.move']).toBe(barMove)
    expect(CHROME_ACTIONS['bookmarks.open']).toBe(barOpen)
  })

  it('bookmarks.bar returns the bar\'s items', () => {
    const { ctx, store } = harness()
    store.addUrl({ url: 'https://a.example/', title: 'A' })

    expect(runChromeAction('bookmarks.bar', undefined, ctx)).toEqual([{ id: 'id0', kind: 'url', title: 'A', url: 'https://a.example/', favicon: null }])
  })

  it('bookmarks.open opens by id with the disposition asked, and refuses a bad payload or an unknown id', () => {
    const { ctx, store, tabs } = harness()
    const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>

    runChromeAction('bookmarks.open', { id: page.id, disposition: 'background' }, ctx)
    expect(tabs.createTab).toHaveBeenCalledWith('https://a.example/', false)
    for (const bad of [undefined, null, {}, { id: page.id }, { id: page.id, disposition: 'private' }, { id: page.id, disposition: 'sideways' }, { id: 7, disposition: 'current' }, { id: 'nope', disposition: 'current' }, 'x']) {
      runChromeAction('bookmarks.open', bad, ctx)
    }
    expect(tabs.createTab).toHaveBeenCalledTimes(1)
    expect(tabs.navigate).not.toHaveBeenCalled()
  })

  it('bookmarks.move moves, and refuses a bad payload, an unknown id and a folder into itself', () => {
    const { ctx, store } = harness()
    const a = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>
    const b = store.addUrl({ url: 'https://b.example/', title: 'B' }) as NonNullable<ReturnType<typeof store.addUrl>>
    const folder = store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>

    runChromeAction('bookmarks.move', { id: a.id, parent: 'bar', index: 2 }, ctx)
    expect(store.children('bar').map((node) => node.id)).toEqual([b.id, a.id, folder.id])
    runChromeAction('bookmarks.move', { id: b.id, parent: folder.id }, ctx)
    expect(store.children(folder.id).map((node) => node.id)).toEqual([b.id])
    for (const bad of [undefined, {}, { id: a.id }, { parent: 'bar', index: 0 }, { id: a.id, parent: 'bar', index: -1 }, { id: a.id, parent: 'bar', index: 'x' }, { id: a.id, parent: 'bar', index: NaN }, { id: folder.id, parent: folder.id, index: 0 }, { id: 'bar', parent: 'other', index: 0 }, { id: a.id, parent: 'nope', index: 0 }]) {
      runChromeAction('bookmarks.move', bad, ctx)
    }
    expect(store.children('bar').map((node) => node.id)).toEqual([a.id, folder.id])
    expect(store.children('other')).toEqual([])
  })

  it('bookmarks.folder shows the folder overlay at the anchor, toggles it shut, and refuses a page, an unknown id and a bad anchor', () => {
    const { ctx, store, overlays } = harness()
    const folder = store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>
    const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>

    runChromeAction('bookmarks.folder', { id: folder.id, anchor }, ctx)
    expect(overlays.show).toHaveBeenCalledWith('bookmark-folder', anchor, { id: folder.id })
    runChromeAction('bookmarks.folder', { id: 'bar', from: 4, anchor }, ctx)
    expect(overlays.show).toHaveBeenLastCalledWith('bookmark-folder', anchor, { id: 'bar', from: 4 })

    for (const bad of [undefined, {}, { id: folder.id }, { id: folder.id, anchor: { x: 1 } }, { id: folder.id, anchor: { ...anchor, x: Infinity } }, { id: page.id, anchor }, { id: 'nope', anchor }, { id: folder.id, anchor, from: -2 }]) {
      runChromeAction('bookmarks.folder', bad, ctx)
    }
    expect(overlays.show).toHaveBeenCalledTimes(2)
    expect(overlays.close).not.toHaveBeenCalled()
  })

  it('bookmarks.folder closes the folder overlay when that folder\'s own menu is open', async () => {
    const { ctx, store, overlays } = harness()
    const folder = store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>
    const { bookmarkFolderOverlay } = await import('../folder-overlay.js')
    bookmarkFolderOverlay.attach({ ...ctx, send: () => {}, close: () => {} }).show?.({ id: folder.id })
    overlays.isOpen.mockReturnValue(true)

    runChromeAction('bookmarks.folder', { id: folder.id, anchor }, ctx)
    expect(overlays.close).toHaveBeenCalledWith('bookmark-folder')
    expect(overlays.show).not.toHaveBeenCalled()
  })

  describe('bookmarks.menu', () => {
    it('pops up the menu of a page at the pointer, and its items act on that page', () => {
      const { ctx, store, tabs, commands } = harness()
      const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>

      runChromeAction('bookmarks.menu', { id: page.id, x: 12.4, y: 40 }, ctx)
      const { template, options } = popups[0] as (typeof popups)[number]
      expect(options).toMatchObject({ x: 12, y: 40 })
      const click = (label: string): void => { template.find((item) => item.label === label)?.click?.() }

      click('Open in New Tab')
      expect(tabs.createTab).toHaveBeenCalledWith('https://a.example/', false)
      click('Copy Link')
      expect(copied).toEqual(['https://a.example/'])
      if (MANAGER.length > 0) {
        click('Bookmark Manager')
        expect(commands.run).toHaveBeenCalledWith('bookmarks.open', ctx.window)
      }
      click('Show Bookmarks Bar')
      expect(commands.run).toHaveBeenCalledWith('bookmarks.toggleBar', ctx.window)
      click('Delete')
      expect(store.has('https://a.example/')).toBe(false)
    })

    it('counts a folder\'s pages in Open All, and pops up the short menu for the empty bar', () => {
      const { ctx, store } = harness()
      const folder = store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>
      store.addUrl({ url: 'https://a.example/', title: 'A', parent: folder.id })

      runChromeAction('bookmarks.menu', { id: folder.id, x: 1, y: 2 }, ctx)
      runChromeAction('bookmarks.menu', { id: null, x: 1, y: 2 }, ctx)
      expect(popups.map((entry) => entry.template.map((item) => item.label ?? '-'))).toEqual([
        ['Open All (1)', '-', 'Rename…', 'Delete', '-', 'Add Folder…', '-', 'Show Bookmarks Bar', ...MANAGER],
        ['Add Folder…', '-', 'Show Bookmarks Bar', ...MANAGER]
      ])
    })

    it('puts the bubble under the item for Edit… and Rename…, and the sheet where the click was for Add Folder…', () => {
      const { ctx, store, overlays } = harness()
      const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>
      const folder = store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>
      const choose = (id: string | null, label: string, extra: object = {}): void => {
        popups.length = 0
        runChromeAction('bookmarks.menu', { id, x: 30, y: 60, ...extra }, ctx)
        popups[0]?.template.find((item) => item.label === label)?.click?.()
      }

      choose(page.id, 'Edit…', { anchor })
      expect(overlays.show).toHaveBeenLastCalledWith('bookmark-edit', anchor, { mode: 'edit', id: page.id })
      choose(folder.id, 'Rename…', { anchor })
      expect(overlays.show).toHaveBeenLastCalledWith('bookmark-edit', anchor, { mode: 'rename-folder', id: folder.id })
      choose(null, 'Add Folder…')
      expect(overlays.show).toHaveBeenLastCalledWith('bookmark-edit', { x: 30, y: 60, width: 0, height: 0 }, { mode: 'new-folder', id: 'bar' })
      // A rectangle the chrome garbled is dropped, not trusted.
      choose(page.id, 'Edit…', { anchor: { x: 'left', y: 1, width: 1, height: 1 } })
      expect(overlays.show).toHaveBeenLastCalledWith('bookmark-edit', { x: 30, y: 60, width: 0, height: 0 }, { mode: 'edit', id: page.id })
    })

    it('refuses a bad payload and an unknown id', () => {
      const { ctx } = harness()
      for (const bad of [undefined, {}, { id: 'nope', x: 1, y: 1 }, { id: 5, x: 1, y: 1 }, { id: null, x: 'a', y: 1 }, { id: null, x: 1 }, { id: null, x: NaN, y: 1 }]) {
        runChromeAction('bookmarks.menu', bad, ctx)
      }
      expect(popups).toEqual([])
    })
  })
})
