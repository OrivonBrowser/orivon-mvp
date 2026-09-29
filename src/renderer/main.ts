import type { Bookmark } from '../main/browsing/bookmarks.js'
import type { SiteSummary } from '../main/permissions/site-info-controller.js'
import type { Web3Score } from '../main/browsing/site-trust.js'
import type { ShellState, TabState } from '../main/shell/tabs.js'
import type { OrivonShell } from '../preload/shell.js'
import { createBookmarksView } from './bookmarks-view.js'
import { closeIcon, faviconElement } from './icons.js'
import { isDraggingTab, makeTabDraggable } from './tab-drag.js'
import { makeStripDraggable } from './strip-drag.js'
import { paintMark, paintShield, shieldLabel, web3Shield } from './web3-shield.js'

// The chrome view's whole job: render ShellState, turn clicks/typing into
// orivonShell.* commands. Main holds truth (src/main/shell/tabs.ts,
// src/main/browsing/bookmarks.ts) -- this file never guesses at state
// between pushes. It never changes its own URL, not even the fragment:
// main refuses every command from a sender at any other URL (ipc.ts's
// isFromChrome), so a hash change or pushState would silence the chrome.

type PopoverAnchor = { x: number, y: number, width: number, height: number }

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

const shell = must(window.orivonShell, 'orivonShell not exposed -- the preload did not run, or location.href did not match --orivon-shell-url')

// See ../style.css's [data-platform] rules -- reserves room for
// Electron's native window buttons before the first paint, rather than
// waiting on a state push.
document.documentElement.dataset['platform'] = shell.platform
// See styles/tabstrip.css's [data-drag-mode="manual"] rule -- which strip
// modes the empty tail after the new-tab button (drag-mode.ts, main-side).
document.documentElement.dataset['dragMode'] = shell.dragMode

const tabrow = must(document.querySelector<HTMLDivElement>('#tabrow'), '#tabrow missing')
const stripTail = must(document.querySelector<HTMLDivElement>('#tab-strip-tail'), '#tab-strip-tail missing')
const backBtn = must(document.querySelector<HTMLButtonElement>('#back'), '#back missing')
const forwardBtn = must(document.querySelector<HTMLButtonElement>('#forward'), '#forward missing')
const reloadBtn = must(document.querySelector<HTMLButtonElement>('#reload'), '#reload missing')
const newTabBtn = must(document.querySelector<HTMLButtonElement>('#new-tab'), '#new-tab missing')
const bookmarkToggle = must(document.querySelector<HTMLButtonElement>('#bookmark-toggle'), '#bookmark-toggle missing')
const addressForm = must(document.querySelector<HTMLFormElement>('#address-form'), '#address-form missing')
const addressInput = must(document.querySelector<HTMLInputElement>('#address'), '#address missing')
const web3ScoreBtn = must(document.querySelector<HTMLButtonElement>('#web3-score-btn'), '#web3-score-btn missing')
// index.html ships this button empty -- built here, once, so
// updateWeb3ScoreShield below only ever repaints an existing element
// rather than replacing the button's whole content on every state push.
const web3ScoreShieldEl = web3Shield()
web3ScoreBtn.append(web3ScoreShieldEl)
const web3MarkEl = must(document.querySelector<HTMLSpanElement>('#web3-mark'), '#web3-mark missing')
const sitePermissionsBtn = must(document.querySelector<HTMLButtonElement>('#site-permissions-btn'), '#site-permissions-btn missing')
const permissionsBtn = must(document.querySelector<HTMLButtonElement>('#permissions-btn'), '#permissions-btn missing')
const zoomChip = must(document.querySelector<HTMLButtonElement>('#zoom-chip'), '#zoom-chip missing')
const profileChip = must(document.querySelector<HTMLButtonElement>('#profile-chip'), '#profile-chip missing')
const menuBtn = must(document.querySelector<HTMLButtonElement>('#menu'), '#menu missing')
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

/** A tab that is showing a site: not the new-tab page, and not one of the
 * shell's own pages, which have no shield, no permissions and nothing to bookmark. */
function hasSite (tab: TabState | undefined): tab is TabState {
  return tab !== undefined && !tab.isNewTab && !tab.isInternal
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

let tabsRenderDeferred = false

function renderTabs (state: ShellState): void {
  // A tab held by the pointer is not rebuilt under it; the strip is redrawn when it is let go.
  if (isDraggingTab()) {
    tabsRenderDeferred = true
    return
  }
  tabsRenderDeferred = false
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
    if (tab.splitWith !== null) {
      // Joined tabs are one pill: the pane the person is not in is a shade lighter.
      el.classList.add('joined', state.tabs.findIndex((other) => other.id === tab.splitWith) > state.tabs.findIndex((other) => other.id === tab.id) ? 'joined-first' : 'joined-second')
      el.title = 'Split view'
    }

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
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      shell.showTabMenu(tab.id)
    })
    makeTabDraggable(el, tab.id, {
      tabs: () => [...tabrow.querySelectorAll<HTMLElement>('.tab')],
      partnerOf: () => tab.splitWith === null ? null : tabrow.querySelector<HTMLElement>(`.tab[data-id="${tab.splitWith}"]`),
      stripHeight: () => tabrow.getBoundingClientRect().height,
      moveTab: (id, index) => { shell.moveTab(id, index) },
      dragStarted: (id) => { shell.beginTabDrag(id) },
      hover: (id, x, y) => { shell.dragTab(id, x, y) },
      dropTab: (id, x, y, clientX, clientY) => { shell.dropTab(id, x, y, clientX, clientY) },
      // Let go in the strip, the order on screen is already the order main is about to confirm.
      finished: (tornOut) => { if (tornOut || tabsRenderDeferred) renderTabs(currentState) }
    })
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

function applyShield (score: Web3Score | null): void {
  paintShield(web3ScoreShieldEl, score?.level ?? null)
  paintMark(web3MarkEl, score?.level ?? null)
  const label = shieldLabel(score)
  web3ScoreBtn.title = label
  web3ScoreBtn.setAttribute('aria-label', label)
  web3MarkEl.title = label
}

function originOf (url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The shield's own displayed-level query, resolved the same lagging,
 * per-active-tab way `updateSitePermissionsBadge` below already is
 * (`shieldRequestUrl` guards against a stale response the same way
 * `permissionsRequestUrl` does). A new origin clears the shield and mark
 * first; a push for the SAME origin (a title, a favicon, a load finishing)
 * keeps the level it already shows while re-asking, or every push would
 * flash it grey. */
let shieldRequestUrl: string | null = null
let shieldOrigin: string | null = null

function updateWeb3ScoreShield (active: TabState | undefined): void {
  // Skip isNewTab: in dev mode the dashboard's own URL is a plain
  // http://localhost:... address (electron-vite's dev server), which has
  // no Website level to show -- an internal page, not a real signal about
  // anything the user visited.
  if (!hasSite(active)) {
    shieldRequestUrl = null
    shieldOrigin = null
    applyShield(null)
    return
  }

  const url = active.url
  shieldRequestUrl = url
  const origin = originOf(url)
  if (origin !== shieldOrigin) {
    shieldOrigin = origin
    applyShield(null)
  }

  void shell.web3ScoreFor(url).then((score) => {
    if (shieldRequestUrl !== url) return // the active tab moved on; this answer is stale
    applyShield(score)
  })
}

function renderToolbar (state: ShellState): void {
  const active = activeTab(state)
  backBtn.disabled = active === undefined || !active.canGoBack
  forwardBtn.disabled = active === undefined || !active.canGoForward

  if (!addressFocused) {
    addressInput.value = active === undefined || active.isNewTab ? '' : active.displayUrl
  }

  updateWeb3ScoreShield(active)

  const bookmarked = active !== undefined && isBookmarked(state.bookmarks, active.url)
  bookmarkToggle.classList.toggle('active', bookmarked)
  bookmarkToggle.setAttribute('aria-pressed', String(bookmarked))

  updateSitePermissionsBadge(active)

  zoomChip.hidden = state.zoomPercent === null
  if (state.zoomPercent !== null) zoomChip.textContent = `${String(state.zoomPercent)}%`
}

/** The site-info popup's own key: hidden until the active tab's site has
 * asked for something at all -- an ordinary website carries no key,
 * matching Chrome's own permission icon staying absent until a site has
 * asked (owner reference). `permissionsRequestUrl` guards against a slow
 * response for a tab that is no longer active landing after a newer
 * request already started -- the same stale-response shape tabs.ts's own
 * captureFavicon guards against, one layer up. */
let permissionsRequestUrl: string | null = null

function updateSitePermissionsBadge (active: TabState | undefined): void {
  const url = hasSite(active) ? active.url : null
  permissionsRequestUrl = url
  if (url === null) {
    applySitePermissionsBadge({ asked: false, warning: false })
    return
  }
  void shell.siteSummaryFor(url).then((summary) => {
    if (permissionsRequestUrl === url) applySitePermissionsBadge(summary)
  })
}

function applySitePermissionsBadge (summary: SiteSummary): void {
  sitePermissionsBtn.hidden = !summary.asked
  sitePermissionsBtn.classList.toggle('has-warning', summary.warning)
  const label = summary.warning ? 'Permissions — this site has an unlimited grant' : 'Permissions'
  sitePermissionsBtn.title = label
  sitePermissionsBtn.setAttribute('aria-label', label)
}

/** The profile chip: a coloured mark with the profile's name, or "Private" in a private window. */
function renderProfile (profile: ShellState['profile']): void {
  profileChip.hidden = !profile.shown
  profileChip.dataset['color'] = profile.color
  profileChip.textContent = profile.name
  profileChip.title = profile.isPrivate ? 'A private window: what it keeps, and what it does not' : `Profile: ${profile.name}`
}

function render (state: ShellState): void {
  renderTabs(state)
  renderToolbar(state)
  // Drives style.css's height override and bookmarks.css's hide rule.
  // main sizes this whole view from the same fact (window.ts's
  // chromeHeight), so the row and the space reserved for it appear and
  // disappear together.
  document.documentElement.dataset['bookmarks'] = state.bookmarksBar ? 'some' : 'none'
  document.documentElement.dataset['private'] = String(state.profile.isPrivate)
  renderProfile(state.profile)
  bookmarksView.render(state.bookmarks)
}

let currentState: ShellState = { tabs: [], activeTabId: null, bookmarks: [], bookmarksBar: false, zoomPercent: null, profile: { name: '', color: 'blue', isPrivate: false, shown: false } }
shell.onState((state) => {
  currentState = state
  render(state)
})

newTabBtn.addEventListener('click', () => shell.newTab())

// The empty strip past the new-tab button: only wired up here in the manual
// drag mode (drag-mode.ts decides, main-side) -- in the native mode the
// tail is plain OS-level drag content and none of this runs.
if (shell.dragMode === 'manual') {
  makeStripDraggable(stripTail, {
    newTab: () => { shell.newTab() },
    toggleMaximize: () => { shell.toggleMaximize() },
    moveStart: (x, y) => { shell.windowMoveStart(x, y) },
    moveTo: (x, y) => { shell.windowMoveTo(x, y) },
    moveEnd: (x, y) => { shell.windowMoveEnd(x, y) }
  })
}

/** The insertion line shown while a tab dragged from another window is over
 * this one's strip (main.ts's dragMark command, tear-drag.ts main-side):
 * built lazily, once, and repositioned/hidden from then on. */
let dropMark: HTMLDivElement | null = null

function showDropMark (index: number): void {
  dropMark ??= (() => {
    const el = document.createElement('div')
    el.className = 'drop-mark'
    tabrow.append(el)
    return el
  })()
  // An approximate place, not real tab boundaries: the index itself is what
  // must agree with where a drop would actually land (tab-move.ts's
  // `crossWindowTargetFor`), which this only has to point at closely enough
  // to read as "here".
  const tabs = [...tabrow.querySelectorAll<HTMLElement>('.tab')]
  const before = tabs[index]
  const rowLeft = tabrow.getBoundingClientRect().left
  const x = before !== undefined
    ? before.getBoundingClientRect().left - rowLeft
    : (tabs.at(-1)?.getBoundingClientRect().right ?? rowLeft) - rowLeft
  dropMark.style.left = `${String(x)}px`
  dropMark.hidden = false
}

function hideDropMark (): void {
  if (dropMark !== null) dropMark.hidden = true
}

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
  if (!hasSite(active)) return
  if (isBookmarked(currentState.bookmarks, active.url)) {
    shell.removeBookmark(active.url)
  } else {
    shell.addBookmark(active.url, active.title.length > 0 ? active.title : active.url, active.id)
  }
})

/** A plain object, not the DOMRect itself: contextBridge deep-clones what
 * crosses it, and a DOMRect's values live on its prototype rather than as
 * own properties -- it arrives in main as {}. Measured at click time, not
 * cached: the window may have been resized, and the bookmarks bar
 * appearing or disappearing moves nothing in this row but the toolbar's
 * own width does shift these buttons. */
function anchorFor (el: HTMLElement): PopoverAnchor {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

// The all-sites popup: always the full list, scrolled to whichever app the
// CURRENT tab is when there is one. A URL that belongs to no app is
// harmless -- settings/main.ts finds no card to scroll to and renders the
// list unscrolled, which is the ordinary open.
permissionsBtn.addEventListener('click', () => {
  const active = activeTab(currentState)
  shell.openPermissions(anchorFor(permissionsBtn), hasSite(active) ? active.url : undefined)
})

// The site-info popup's two entry points: the shield opens straight to the
// Web3 Score page, the key to the main page. Both act on the active tab's
// own url; a click while there is none, or on the dashboard, is a no-op --
// there is no origin for either page to describe.
web3ScoreBtn.addEventListener('click', () => {
  const active = activeTab(currentState)
  if (!hasSite(active)) return
  shell.openSiteInfo(anchorFor(web3ScoreBtn), 'web3', active.url)
})
sitePermissionsBtn.addEventListener('click', () => {
  const active = activeTab(currentState)
  if (!hasSite(active)) return
  shell.openSiteInfo(anchorFor(sitePermissionsBtn), 'main', active.url)
})

zoomChip.addEventListener('click', () => { shell.runCommand('zoom.reset') })
profileChip.addEventListener('click', () => { shell.openInternal(currentState.profile.isPrivate ? 'private' : 'profiles') })
menuBtn.addEventListener('click', () => { shell.openMenu(anchorFor(menuBtn)) })

// A keyboard shortcut in main asks for the address bar, or (while a tab
// dragged from any window is over this one's strip) main asks the strip to
// mark, or stop marking, where it would land.
shell.onCommand((command) => {
  if (command.type === 'focusAddress') {
    addressInput.focus()
    addressInput.select()
  } else if (command.type === 'dragMark') {
    showDropMark(command.index)
  } else if (command.type === 'dragMarkClear') {
    hideDropMark()
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
