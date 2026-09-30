import { describe, expect, it } from 'vitest'
import { barIsShown, barItemsOf, toBarItem, toggledMode } from '../bar-items.js'
import { bookmarkedStatePart } from '../bar-state.js'
import { bookmarksBarShown, toggleBookmarksBar } from '../bar-visibility.js'
import type { WindowContext } from '../../window-context.js'
import { harness, tiny } from './harness.js'

describe('the bar items', () => {
  it('carry only what the bar draws: pages with address and icon, folders with a title', () => {
    const { store } = harness()
    const folder = store.addFolder({ title: 'Work', parent: 'bar' }) as NonNullable<ReturnType<typeof store.addFolder>>
    store.addUrl({ url: 'https://a.example/', title: 'A', favicon: tiny })
    store.addUrl({ url: 'https://inside.example/', title: 'Inside', parent: folder.id })

    expect(barItemsOf(store)).toEqual([
      { id: folder.id, kind: 'folder', title: 'Work' },
      { id: 'id1', kind: 'url', title: 'A', url: 'https://a.example/', favicon: tiny }
    ])
    expect(toBarItem(store.node('id1') as NonNullable<ReturnType<typeof store.node>>)).not.toHaveProperty('added')
  })
})

describe('whether the bar is shown', () => {
  it('shows on always, hides on never, and follows its contents on auto', () => {
    expect(barIsShown('always', 0)).toBe(true)
    expect(barIsShown('never', 5)).toBe(false)
    expect(barIsShown('auto', 0)).toBe(false)
    expect(barIsShown('auto', 1)).toBe(true)
  })

  it('toggles between always and never, treating auto by what it is showing', () => {
    expect(toggledMode('always', 0)).toBe('never')
    expect(toggledMode('never', 0)).toBe('always')
    expect(toggledMode('auto', 0)).toBe('always')
    expect(toggledMode('auto', 2)).toBe('never')
  })

  it('reads the bar folder, not the pages of other folders, and sets the setting when toggled', () => {
    const { ctx, store, settings } = harness()
    store.addUrl({ url: 'https://o.example/', title: 'O', parent: 'other' })
    expect(bookmarksBarShown(ctx.services)).toBe(false)
    store.addUrl({ url: 'https://a.example/', title: 'A' })
    expect(bookmarksBarShown(ctx.services)).toBe(true)

    toggleBookmarksBar(ctx.services)
    expect(settings.set).toHaveBeenCalledWith('appearance.bookmarksBar', 'never')
  })
})

describe('the bookmarked state part', () => {
  const read = (ctx: WindowContext, tabs: Array<{ id: string, url: string }>, active: string | null): unknown =>
    bookmarkedStatePart.read(ctx, { tabs, activeTabId: active } as never)

  it('says whether the active tab is in the bar or Other bookmarks, at any depth', () => {
    const { ctx, store } = harness()
    const folder = store.addFolder({ title: 'F', parent: 'other' }) as NonNullable<ReturnType<typeof store.addFolder>>
    store.addUrl({ url: 'https://deep.example/', title: 'Deep', parent: folder.id })
    store.addUrl({ url: 'https://reading.example/', title: 'R', parent: 'reading' })
    const tabs = [{ id: 'a', url: 'https://deep.example/' }, { id: 'b', url: 'https://nope.example/' }, { id: 'c', url: 'https://reading.example/' }]

    expect(read(ctx, tabs, 'a')).toEqual({ bookmarked: true })
    expect(read(ctx, tabs, 'b')).toEqual({ bookmarked: false })
    expect(read(ctx, tabs, 'c')).toEqual({ bookmarked: false })
    expect(read(ctx, tabs, null)).toEqual({ bookmarked: false })
  })
})
