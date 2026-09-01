import type { Bookmark } from '../../main/bookmarks.js'
import { globeIcon } from '../icons.js'

// The dashboard's whole job: a search box and real bookmark tiles.
// Owner override, 2026-08-28 -- see index.html's own header for the
// scope note (grid layout matching the vision, real content only).

interface OrivonNewTab {
  getBookmarks: () => Promise<Bookmark[]>
  navigate: (input: string) => void
}

declare global {
  interface Window {
    orivonNewTab?: OrivonNewTab
  }
}

// Deliberately NOT a hard throw (unlike the chrome view's own `must()`
// pattern in ../main.ts). The chrome view NEVER loads without its
// preload; this page legitimately can -- src/main/tabs.ts only chooses
// the privileged preload for a genuinely fresh tab (`url === undefined`),
// so this exact page loaded any other way (e.g. a stray reference to its
// own dev-mode URL) gets the ordinary, unprivileged preload instead. That
// is a safe, expected case, not a bug -- degrade gracefully rather than
// crash the page over it.
const shell = window.orivonNewTab

const searchForm = document.querySelector<HTMLFormElement>('#search-form')
const searchInput = document.querySelector<HTMLInputElement>('#search-input')
const bookmarksSection = document.querySelector<HTMLElement>('#bookmarks-section')
const bookmarksGrid = document.querySelector<HTMLDivElement>('#bookmarks-grid')

if (shell !== undefined) {
  searchInput?.focus()

  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault()
    const value = searchInput?.value.trim() ?? ''
    if (value.length > 0) shell.navigate(value)
  })

  if (bookmarksSection !== null && bookmarksGrid !== null) {
    void renderBookmarks(shell, bookmarksSection, bookmarksGrid)
  }
}

async function renderBookmarks (
  shell: OrivonNewTab,
  section: HTMLElement,
  grid: HTMLDivElement
): Promise<void> {
  const bookmarks = await shell.getBookmarks()
  if (bookmarks.length === 0) return

  for (const bookmark of bookmarks) {
    const tile = document.createElement('button')
    tile.className = 'tile'
    tile.type = 'button'
    tile.title = bookmark.url

    const icon = globeIcon()
    icon.setAttribute('class', 'tile-icon')

    const label = document.createElement('span')
    label.className = 'tile-label'
    label.textContent = bookmark.title.length > 0 ? bookmark.title : bookmark.url

    tile.append(icon, label)
    tile.addEventListener('click', () => { shell.navigate(bookmark.url) })
    grid.append(tile)
  }

  section.hidden = false
}
