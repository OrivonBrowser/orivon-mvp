import type { Bookmark } from '../main/bookmarks.js'
import { closeIcon, globeIcon } from './icons.js'

// Renders the bookmarks bar's dynamic list; the "Other Bookmarks" folder and
// apps-grid button are static markup in index.html. See README.md for why
// bookmarks are a real feature here.
//
// A div with a nested <button>, not a single <button>: each item needs two
// independent click targets (open, remove), and a <button> cannot contain
// another <button> -- the browser would implicitly close the outer one the
// moment it saw the inner tag.

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
