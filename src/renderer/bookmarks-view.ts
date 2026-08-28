import type { Bookmark } from '../main/bookmarks.js'
import { globeIcon } from './icons.js'

// Renders the bookmarks bar's dynamic half -- the "Other Bookmarks"
// folder and the apps-grid button are static markup in index.html;
// this only builds the list of actual bookmarks. Owner override,
// 2026-08-28 (mvp-scope.md, ADR-0003) -- not in the original scope pass.
//
// orivon-browser-v2's bookmarks bar (visual reference only, ADR-0002)
// is static decoration with no data model -- unlike its apps-grid and
// folder icons, these items are real and clickable, so they are plain
// <button>s rather than v2's non-interactive <div>s.

export interface BookmarksView {
  render: (bookmarks: Bookmark[]) => void
}

export function createBookmarksView (list: HTMLDivElement, onOpen: (url: string) => void): BookmarksView {
  function render (bookmarks: Bookmark[]): void {
    list.replaceChildren()
    for (const bookmark of bookmarks) {
      const item = document.createElement('button')
      item.className = 'bmitem no-drag'
      item.type = 'button'
      item.title = bookmark.url

      const label = document.createElement('span')
      label.textContent = bookmark.title.length > 0 ? bookmark.title : bookmark.url

      item.append(globeIcon(), label)
      item.addEventListener('click', () => onOpen(bookmark.url))
      list.append(item)
    }
  }

  return { render }
}
