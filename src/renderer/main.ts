import type { Bookmark } from '../main/bookmarks.js'
import type { AppPermissions } from '../main/permissions.js'
import type { DeliveryProvenance } from '../main/delivery-provenance.js'
import type { ShellState, TabState } from '../main/tabs.js'
import { createBookmarksView } from './bookmarks-view.js'
import { closeIcon, faviconElement } from './icons.js'

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
  /** `tabId` lets main read that tab's own captured favicon and keep it with
   * the bookmark -- this view never sends the icon itself. */
  addBookmark: (url: string, title: string, tabId: string) => void
  removeBookmark: (url: string) => void
  openBookmark: (url: string) => void
  /** Queue item 4.4: the active tab's own grants, for the toolbar's
   * permission key -- `null` for an ordinary website (never registered
   * as an app). */
  appPermissionsFor: (url: string) => Promise<AppPermissions | null>
  /** S4-6, ADR-0007: is the active tab's document actually being answered
   * from Orivon's own pinned local cache -- the one truthful signal the
   * address-bar dot owes a page whose padlock would otherwise claim a live
   * TLS connection that never happened. */
  deliveryProvenanceFor: (url: string) => Promise<DeliveryProvenance>
  /** Opens (or closes) the permissions panel under the permission key.
   * `anchor` is that key's own rect -- main cannot know where the toolbar
   * put it. `url`, when given, is the tab whose card to scroll to. */
  openSettings: (anchor: { x: number, y: number, width: number, height: number }, url?: string) => void
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
const permissionsBtn = must(document.querySelector<HTMLButtonElement>('#permissions-btn'), '#permissions-btn missing')
const bookmarksList = must(document.querySelector<HTMLDivElement>('#bookmarks-list'), '#bookmarks-list missing')

const bookmarksView = createBookmarksView(
  bookmarksList,
  (url) => { shell.openBookmark(url) },
  (url) => { shell.removeBookmark(url) }
)

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
  } else if (tab.isNewTab) {
    // The mark is the .newtab class's own background image (tabstrip.css) --
    // nothing goes inside it. It used to hold a literal 'O', which would now
    // render on top of the logo.
    fav.classList.add('newtab')
  } else {
    fav.append(faviconElement(tab.favicon))
  }
  return fav
}

function renderTabs (state: ShellState): void {
  // Rebuilds the whole strip on every push rather than diffing -- simple,
  // and tab counts in v0 are small enough that this never shows up as jank.
  const items = tabrow.querySelectorAll('.tab')
  items.forEach((el) => { el.remove() })

  for (const tab of state.tabs) {
    const el = document.createElement('div')
    // #tabrow is a drag region (index.html); without `no-drag` here, every
    // click on a tab is consumed by the OS as a window drag instead of
    // reaching this listener -- Electron's own docs: a draggable area
    // "ignores all pointer events" unless excluded.
    el.className = 'tab no-drag'
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
    // Middle-click closes a tab, matching every other browser. Guarded on
    // mousedown too: Windows arms Blink's middle-click autoscroll on
    // mousedown, before 'auxclick' fires, so preventDefault() there alone
    // is too late on that platform.
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        shell.closeTab(tab.id)
      }
    })
    // Tabs render before the ever-present #new-tab button, matching its
    // fixed position at the end of the strip (index.html).
    newTabBtn.before(el)
  }
}

/** The plain https/http read `updateAddressDot` paints immediately, and
 * upgrades to `.cached` once (or if) the provenance query below resolves
 * otherwise -- never downgrades a page that really is plain https/http. */
function applyConnectionDot (url: string): void {
  if (url.startsWith('https://')) addressDot.classList.add('secure')
  else if (url.startsWith('http://')) addressDot.classList.add('insecure')
}

/** S4-6, ADR-0007's "the padlock is now misleading unless the UI corrects
 * it": the address-bar dot's own provenance state, resolved the same
 * lagging, per-active-tab way `updateAddressPermissionsBadge` below already
 * is (`dotRequestUrl` guards against a stale response the same way
 * `permissionsRequestUrl` does). Paints the ordinary secure/insecure read
 * first, synchronously, then replaces it with the pinned-cache state if
 * `deliveryProvenanceFor` says so -- a page really is plain https/http
 * until proven otherwise, never the reverse. */
let dotRequestUrl: string | null = null

function updateAddressDot (active: TabState | undefined): void {
  addressDot.classList.remove('secure', 'insecure', 'cached')
  addressDot.removeAttribute('title')
  addressDot.removeAttribute('aria-label')

  // Skip isNewTab: in dev mode the dashboard's own URL is a plain
  // http://localhost:... address (electron-vite's dev server), which
  // would otherwise flag Orivon's own page "insecure" -- wrong for an
  // internal page, not a real signal about anything the user visited.
  if (active === undefined || active.isNewTab) {
    dotRequestUrl = null
    return
  }

  const url = active.url
  dotRequestUrl = url
  applyConnectionDot(url)

  void shell.deliveryProvenanceFor(url).then((provenance) => {
    if (dotRequestUrl !== url) return // the active tab moved on; this answer is stale
    if (!provenance.servedFromPinnedCache) return
    addressDot.classList.remove('secure', 'insecure')
    addressDot.classList.add('cached')
    // The literal wording ADR-0007 asks for -- quoted, not paraphrased, so
    // the address bar and the ADR never drift apart on what it says.
    addressDot.title = 'Running from local cache, pinned'
    addressDot.setAttribute('aria-label', 'Running from local cache, pinned')
  })
}

function renderToolbar (state: ShellState): void {
  const active = activeTab(state)
  backBtn.disabled = active === undefined || !active.canGoBack
  forwardBtn.disabled = active === undefined || !active.canGoForward

  if (!addressFocused) {
    addressInput.value = active === undefined || active.isNewTab ? '' : active.url
  }

  updateAddressDot(active)

  const bookmarked = active !== undefined && isBookmarked(state.bookmarks, active.url)
  bookmarkToggle.classList.toggle('active', bookmarked)
  bookmarkToggle.setAttribute('aria-pressed', String(bookmarked))

  updatePermissionsBadge(active)
}

/** Queue item 4.4's permission key: what the active tab's app can do, at
 * a glance. It sits outside the omnibox (owner, 2026-09-15 -- the pill's
 * trailing slot is the Web3 Score's), so one control carries both halves:
 * the current tab's state, and the way into the full list.
 * `permissionsRequestUrl` guards against a slow response for a tab that is
 * no longer active landing after a newer request already started -- the
 * same stale-response shape tabs.ts's own captureFavicon guards against,
 * one layer up. */
let permissionsRequestUrl: string | null = null

function updatePermissionsBadge (active: TabState | undefined): void {
  const url = active === undefined || active.isNewTab ? null : active.url
  permissionsRequestUrl = url
  if (url === null) {
    applyPermissionsBadge(null)
    return
  }
  void shell.appPermissionsFor(url).then((app) => {
    if (permissionsRequestUrl === url) applyPermissionsBadge(app)
  })
}

function applyPermissionsBadge (app: AppPermissions | null): void {
  const hasRows = app !== null && app.rows.length > 0
  const hasWarning = hasRows && app.rows.some((row) => row.warning)
  permissionsBtn.classList.toggle('has-app', hasRows)
  permissionsBtn.classList.toggle('has-warning', hasWarning)
  const label = hasRows
    ? `${app.appName} — click to view or revoke its permissions`
    : 'Permissions — this site has none'
  permissionsBtn.title = label
  permissionsBtn.setAttribute('aria-label', label)
}

function render (state: ShellState): void {
  renderTabs(state)
  renderToolbar(state)
  // Drives style.css's height override and bookmarks.css's hide rule.
  // main sizes this whole view from the same fact (window.ts's
  // chromeHeight), so the row and the space reserved for it appear and
  // disappear together.
  document.documentElement.dataset['bookmarks'] = state.bookmarks.length > 0 ? 'some' : 'none'
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
  if (active === undefined || active.isNewTab) return
  if (isBookmarked(currentState.bookmarks, active.url)) {
    shell.removeBookmark(active.url)
  } else {
    shell.addBookmark(active.url, active.title.length > 0 ? active.title : active.url, active.id)
  }
})

// Queue item 4.4: always the full list, scrolled to whichever app the
// CURRENT tab is when there is one. A URL that belongs to no app is
// harmless -- settings/main.ts finds no card to scroll to and renders the
// list unscrolled, which is the ordinary open.
permissionsBtn.addEventListener('click', () => {
  const active = activeTab(currentState)
  // Measured at click time, not cached: the window may have been resized,
  // and the bookmarks bar appearing or disappearing moves nothing in this
  // row but the toolbar's own width does shift this button.
  // A plain object, not the DOMRect itself: contextBridge deep-clones what
  // crosses it, and a DOMRect's values live on its prototype rather than as
  // own properties -- it arrives in main as {}.
  const r = permissionsBtn.getBoundingClientRect()
  const anchor = { x: r.x, y: r.y, width: r.width, height: r.height }
  shell.openSettings(anchor, active === undefined || active.isNewTab ? undefined : active.url)
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
