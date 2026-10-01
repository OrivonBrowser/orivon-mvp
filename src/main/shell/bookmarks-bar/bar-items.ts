// What the bookmarks bar shows and whether it is shown. Pure: the store and the setting are handed in.
import type { BarItem, BookmarkNode } from '../../browsing/bookmark-types.js'
import type { BookmarkStore } from '../../browsing/bookmarks.js'

export type BarMode = 'auto' | 'always' | 'never'

export function toBarItem (node: BookmarkNode): BarItem {
  const item: BarItem = { id: node.id, kind: node.kind, title: node.title }
  if (node.kind === 'url') {
    if (node.url !== undefined) item.url = node.url
    item.favicon = node.favicon ?? null
  }
  return item
}

/** The bar's children in order: the only bookmark data the chrome holds. */
export function barItemsOf (store: Pick<BookmarkStore, 'children'>): BarItem[] {
  return store.children('bar').map(toBarItem)
}

/** 'auto' shows the bar once it has something in it. */
export function barIsShown (mode: BarMode, itemCount: number): boolean {
  return mode === 'always' || (mode === 'auto' && itemCount > 0)
}

/** The mode the toggle sets: a shown bar goes to 'never', a hidden one to 'always'. */
export function toggledMode (mode: BarMode, itemCount: number): BarMode {
  return barIsShown(mode, itemCount) ? 'never' : 'always'
}
