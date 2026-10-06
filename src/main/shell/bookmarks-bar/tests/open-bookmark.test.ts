import { describe, expect, it } from 'vitest'
import { OPEN_ALL_LIMIT, openAll, openBookmark, openableIn } from '../open-bookmark.js'
import { harness } from './harness.js'

describe('opening a bookmark', () => {
  it('navigates the active tab, or makes one when the window has none', () => {
    const { ctx, store, tabs } = harness()
    const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>

    expect(openBookmark(ctx, page.id, 'current')).toBe(true)
    expect(tabs.navigate).toHaveBeenCalledWith('a', 'https://a.example/')

    const empty = harness({ active: null })
    const again = empty.store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof empty.store.addUrl>>
    openBookmark(empty.ctx, again.id, 'current')
    expect(empty.tabs.createTab).toHaveBeenCalledWith('https://a.example/')
  })

  it('opens behind the current tab, in a new window, or in a private one', () => {
    const { ctx, store, tabs, commands, newWindowTabs, openPrivate } = harness()
    const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>

    openBookmark(ctx, page.id, 'background')
    expect(tabs.createTab).toHaveBeenCalledWith('https://a.example/', false)
    openBookmark(ctx, page.id, 'window')
    expect(commands.openWindow).toHaveBeenCalledTimes(1)
    expect(newWindowTabs.createTab).toHaveBeenCalledWith('https://a.example/')
    openBookmark(ctx, page.id, 'private')
    expect(openPrivate).toHaveBeenCalledWith('https://a.example/')
  })

  it('opens a bookmarked local file as one, wherever it is opened, and never in a private session', () => {
    const { ctx, store, tabs, newWindowTabs, openPrivate, commands } = harness()
    const file = 'file:///home/u/notes/app.html'
    const page = store.addUrl({ url: file, title: 'Notes' }) as NonNullable<ReturnType<typeof store.addUrl>>

    expect(openBookmark(ctx, page.id, 'current')).toBe(true)
    expect(tabs.openLocalFile).toHaveBeenLastCalledWith(file, true)
    openBookmark(ctx, page.id, 'background')
    expect(tabs.openLocalFile).toHaveBeenLastCalledWith(file, false)
    openBookmark(ctx, page.id, 'tab')
    expect(tabs.openLocalFile).toHaveBeenLastCalledWith(file, true)
    openBookmark(ctx, page.id, 'window')
    expect(commands.openWindow).toHaveBeenCalledTimes(1)
    expect(newWindowTabs.openLocalFile).toHaveBeenCalledWith(file, true)
    expect(openBookmark(ctx, page.id, 'private')).toBe(false)
    expect(openPrivate).not.toHaveBeenCalled()
    expect(tabs.createTab).not.toHaveBeenCalled()
    expect(tabs.navigate).not.toHaveBeenCalled()
  })

  it('opens no second private session from a private window', () => {
    const { ctx, store, openPrivate } = harness({ isPrivate: true })
    const page = store.addUrl({ url: 'https://a.example/', title: 'A' }) as NonNullable<ReturnType<typeof store.addUrl>>

    expect(openBookmark(ctx, page.id, 'private')).toBe(false)
    expect(openPrivate).not.toHaveBeenCalled()
  })

  it('opens nothing for a folder, a root or an id the store does not know', () => {
    const { ctx, store, tabs } = harness()
    const folder = store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>

    for (const id of [folder.id, 'bar', 'nope', '']) expect(openBookmark(ctx, id, 'current')).toBe(false)
    expect(tabs.navigate).not.toHaveBeenCalled()
    expect(tabs.createTab).not.toHaveBeenCalled()
  })
})

describe('Open all', () => {
  function folderOf (n: number, options: Parameters<typeof harness>[0] = {}): { h: ReturnType<typeof harness>, id: string } {
    const h = harness(options)
    const folder = h.store.addFolder({ title: 'F', parent: 'bar' }) as NonNullable<ReturnType<typeof h.store.addFolder>>
    for (let i = 0; i < n; i += 1) h.store.addUrl({ url: `https://p${String(i)}.example/`, title: String(i), parent: folder.id })
    h.store.addFolder({ title: 'Sub', parent: folder.id })
    return { h, id: folder.id }
  }

  it('opens the pages directly in the folder, the first in front and the rest behind', () => {
    const { h, id } = folderOf(3)

    expect(openableIn(h.ctx, id)).toHaveLength(3)
    expect(openAll(h.ctx, id)).toBe(3)
    expect(h.tabs.createTab.mock.calls).toEqual([['https://p0.example/', true], ['https://p1.example/', false], ['https://p2.example/', false]])
  })

  it('stops at the cap of 25 tabs', () => {
    const { h, id } = folderOf(40)

    expect(openAll(h.ctx, id)).toBe(OPEN_ALL_LIMIT)
    expect(h.tabs.createTab).toHaveBeenCalledTimes(OPEN_ALL_LIMIT)
  })

  it('stops when the window has no room for another tab', () => {
    const { h, id } = folderOf(10, { capacity: 4 })

    expect(openAll(h.ctx, id)).toBe(3)
  })
})
