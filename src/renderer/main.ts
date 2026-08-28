import type { Bookmark } from '../main/bookmarks.js'
import type { ShellState, TabState } from '../main/tabs.js'
import { createBookmarksView } from './bookmarks-view.js'
import { closeIcon, globeIcon } from './icons.js'

// The chrome view's whole job: render ShellState, turn clicks/typing into
// orivonShell.* commands. Main holds truth (src/main/tabs.ts,
// src/main/bookmarks.ts) -- this file never guesses at state between
// pushes.

interface OrivonShell {
  newTab: (url?: string) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  navigate: (id: string, input: string) => void
  back: (id: string) => void
  forward: (id: string) => void
  reload: (id: string) => void
  addBookmark: (url: string, title: string) => void
  removeBookmark: (url: string) => void
  openBookmark: (url: string) => void
  onState: (listener: (state: ShellState) => void) => () => void
  /** Read-only -- see preload/shell.ts for why this exists instead of
   * env(titlebar-area-*) or navigator.windowControlsOverlay. */
  platform: string
}

declare global {
  interface Window {
    orivonShell?: OrivonShell
  }
}

// TS control-flow narrowing does not persist into closures (event
// listener callbacks, functions declared below) even for `const`
// bindings that are never reassigned -- a plain `if (x === null) throw`
// here would still leave every later use flagged "possibly null". `must`
// makes the TYPE non-nullable at the source instead of relying on
// narrowing that doesn't survive past this point.
function must<T> (value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

const shell = must(window.orivonShell, 'orivonShell not exposed -- preload did not run')

// See ../style.css's [data-platform] rules -- reserves room for
// Electron's native window buttons before the first paint, rather than
// waiting on a state push.
document.documentElement.dataset['platform'] = shell.platform

const tabrow = must(document.querySelector<HTMLDivElement>('#tabrow'), '#tabrow missing')
const backBtn = must(document.querySelector<HTMLButtonElement>('#back'), '#back missing')
const forwardBtn = must(document.querySelector<HTMLButtonElement>('#forward'), '#forward missing')
const reloadBtn = must(document.querySelector<HTMLButtonElement>('#reload'), '#reload missing')
const newTabBtn = must(document.querySelector<HTMLButtonElement>('#new-tab'), '#new-tab missing')
const bookmarkToggle = must(document.querySelector<HTMLButtonElement>('#bookmark-toggle'), '#bookmark-toggle missing')
const addressForm = must(document.querySelector<HTMLFormElement>('#address-form'), '#address-form missing')
const addressInput = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
const addressDot = must(document.querySelector<HTMLSpanElement>('#address-dot'), '#address-dot missing')
const bookmarksList = must(document.querySelector<HTMLDivElement>('#bookmarks-list'), '#bookmarks-list missing')

const bookmarksView = createBookmarksView(bookmarksList, (url) => { shell.openBookmark(url) })

/** True while the user is editing the address bar -- an incoming state
 * push must not clobber what they're typing. */
let addressFocused = false

function activeTab (state: ShellState): TabState | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId)
}

function isBookmarked (bookmarks: Bookmark[], url: string): boolean {
  return bookmarks.some((b) => b.url === url)
}

function renderFavicon (tab: TabState): HTMLSpanElement {
  const fav = document.createElement('span')
  fav.className = 'fav'
  if (tab.loading) {
    fav.classList.add('loading')
  } else if (tab.url === 'about:blank') {
    fav.classList.add('newtab')
    fav.textContent = 'O'
  } else {
    fav.append(globeIcon())
  }
  return fav
}

function renderTabs (state: ShellState): void {
  // Rebuilds the whole strip on every push rather than diffing -- the
  // same tradeoff the previous version of this file made, unchanged
  // here: simple, and tab counts in v0 are small enough that this never
  // shows up as jank.
  const items = tabrow.querySelectorAll('.tab')
  items.forEach((el) => { el.remove() })

  for (const tab of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab'
    el.classList.toggle('active', tab.id === state.activeTabId)
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(tab.id === state.activeTabId))
    el.dataset['id'] = tab.id

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = tab.title.length > 0 ? tab.title : 'New Tab'

    const close = document.createElement('button')
    close.className = 'close no-drag'
    close.type = 'button'
    close.setAttribute('aria-label', `Close ${title.textContent}`)
    close.append(closeIcon())
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      shell.closeTab(tab.id)
    })

    el.append(renderFavicon(tab), title, close)
    el.addEventListener('click', () => shell.activateTab(tab.id))
    // Tabs render before the ever-present #new-tab button, matching its
    // fixed position at the end of the strip (index.html).
    newTabBtn.before(el)
  }
}

function renderToolbar (state: ShellState): void {
  const active = activeTab(state)
  backBtn.disabled = active === undefined || !active.canGoBack
  forwardBtn.disabled = active === undefined || !active.canGoForward

  if (!addressFocused) {
    addressInput.value = active === undefined || active.url === 'about:blank' ? '' : active.url
  }

  addressDot.classList.remove('secure', 'insecure')
  if (active !== undefined) {
    if (active.url.startsWith('https://')) addressDot.classList.add('secure')
    else if (active.url.startsWith('http://')) addressDot.classList.add('insecure')
  }

  const bookmarked = active !== undefined && isBookmarked(state.bookmarks, active.url)
  bookmarkToggle.classList.toggle('active', bookmarked)
  bookmarkToggle.setAttribute('aria-pressed', String(bookmarked))
}

function render (state: ShellState): void {
  renderTabs(state)
  renderToolbar(state)
  bookmarksView.render(state.bookmarks)
}

let currentState: ShellState = { tabs: [], activeTabId: null, bookmarks: [] }
shell.onState((state) => {
  currentState = state
  render(state)
})

newTabBtn.addEventListener('click', () => shell.newTab())

backBtn.addEventListener('click', () => {
  if (currentState.activeTabId !== null) shell.back(currentState.activeTabId)
})
forwardBtn.addEventListener('click', () => {
  if (currentState.activeTabId !== null) shell.forward(currentState.activeTabId)
})
reloadBtn.addEventListener('click', () => {
  if (currentState.activeTabId !== null) shell.reload(currentState.activeTabId)
})

bookmarkToggle.addEventListener('click', () => {
  const active = activeTab(currentState)
  if (active === undefined || active.url === 'about:blank') return
  if (isBookmarked(currentState.bookmarks, active.url)) {
    shell.removeBookmark(active.url)
  } else {
    shell.addBookmark(active.url, active.title.length > 0 ? active.title : active.url)
  }
})

addressInput.addEventListener('focus', () => { addressFocused = true })
addressInput.addEventListener('blur', () => {
  addressFocused = false
  renderToolbar(currentState)
})
addressForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (currentState.activeTabId === null) return
  shell.navigate(currentState.activeTabId, addressInput.value)
  addressInput.blur()
})
