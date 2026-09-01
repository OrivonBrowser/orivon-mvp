import type { Bookmark } from '../main/bookmarks.js'
import { closeIcon, globeIcon } from './icons.js'

// Renders the bookmarks bar's dynamic half -- the "Other Bookmarks"
// folder and the apps-grid button are static markup in index.html;
// this only builds the list of actual bookmarks. Owner override,
// 2026-08-28 (mvp-scope.md, ADR-0003) -- not in the original scope pass.
//
// orivon-browser-v2's bookmarks bar (visual reference only, ADR-0002)
// is static decoration with no data model -- unlike its apps-grid and
// folder icons, these items are real and interactive, matching the tab
// strip's own div-plus-nested-close-button shape (main.ts) rather than
// a single <button>: a bookmark needed a second, independent click
// target (remove) added 2026-08-28, and a <button> cannot contain
// another <button> per the HTML content model -- the browser would
// implicitly close the outer one the moment it saw the inner tag.
//
// Not in a drag region (only #tabrow is, index.html) -- no `no-drag`
// class needed here, unlike the tab strip's own interactive elements.

export interface BookmarksView {
  render: (bookmarks: Bookmark[]) => void
}

export function createBookmarksView (
  list: HTMLDivElement,
  onOpen: (url: string) => void,
  onRemove: (url: string) => void
): BookmarksView {
  function render (bookmarks: Bookmark[]): void {
    list.replaceChildren()
    for (const bookmark of bookmarks) {
      const item = document.createElement('div')
      item.className = 'bmitem'
      item.title = bookmark.url

      const label = document.createElement('span')
      label.textContent = bookmark.title.length > 0 ? bookmark.title : bookmark.url

      const remove = document.createElement('button')
      remove.className = 'remove'
      remove.type = 'button'
      remove.setAttribute('aria-label', `Remove bookmark ${label.textContent}`)
      remove.append(closeIcon())
      remove.addEventListener('click', (e) => {
        e.stopPropagation()
        onRemove(bookmark.url)
      })

      item.append(globeIcon(), label, remove)
      item.addEventListener('click', () => onOpen(bookmark.url))
      list.append(item)
    }
  }

  return { render }
}
