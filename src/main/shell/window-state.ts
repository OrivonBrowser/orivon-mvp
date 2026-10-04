// What one window tells its chrome view: the tab collection, whether the page is
// bookmarked, the zoom chip and the profile look, folded into one ShellState and pushed on
// every change. It also decides which dismissals a push implies (a tab switch,
// a navigation, the site-info origin changing) and starts the sources whose
// changes cause a push, and the stop that ends them with the window.
import type { BaseWindow, WebContentsView } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { STATE_CHANNEL } from '../channels.js'
import { faviconHost } from '../history/favicon-host.js'
import type { OverlayHostHandle } from '../overlays/overlay-host.js'
import { barItemsOf } from './bookmarks-bar/bar-items.js'
import type { HtmlFullscreen } from './fullscreen.js'
import { sendChromeEvent } from './shell-events.js'
import { readStateParts, watchStateParts } from './shell-state-parts.js'
import type { ShellServices } from './shell-services.js'
import type { TabManager } from './tabs.js'
import type { TabsSnapshot } from './tab-types.js'
import type { WindowContext } from './window-context.js'
import type { WindowLayout } from './window-layout.js'

export interface WindowStateDeps {
  readonly win: BaseWindow
  readonly chrome: WebContentsView
  readonly tabs: TabManager
  readonly services: ShellServices
  readonly context: WindowContext
  readonly fullscreen: HtmlFullscreen
  readonly layout: Pick<WindowLayout, 'chromeHeight' | 'layoutChrome' | 'tabBounds'>
  readonly bookmarksBarShown: () => boolean
  readonly overlays: OverlayHostHandle
  /** Dismisses the site-info popover alone: it describes one origin. */
  readonly closeSiteInfo: () => void
}

export interface WindowState {
  pushState: () => void
  /** Ends every subscription this window's state made. */
  stop: () => void
}

export function createWindowState (deps: WindowStateDeps): WindowState {
  const { win, chrome, tabs, services, context, fullscreen, layout, bookmarksBarShown, overlays, closeSiteInfo } = deps
  const { bookmarks, history } = services

  /** The icon of the site a tab shows, kept with its pages so the History page can draw it. */
  function rememberIcon (address: string, icon: string): void {
    const host = faviconHost(address)
    if (host !== null) history.setFavicon(host, icon)
  }

  /** What each tab last showed for its icon, so a title or a loading flag, which push state far more often than an
   * icon changes, does no icon work. A tab with no icon has no entry. */
  const offeredIcons = new Map<string, { readonly url: string, readonly displayUrl: string, readonly favicon: string }>()
  /** Set by a bookmarks change: the next push offers every tab's icon again, since a page starred just now may be
   * waiting for an icon its tab has shown for a while. */
  let offerAllIcons = false

  /** Star a page the instant it opens and its favicon has not arrived yet, so the bookmark is saved iconless. The fetch
   * lands moments later and pushes state: this is where that late icon reaches the bookmark it belongs to.
   * fillMissingFavicon never overwrites an icon already stored, and deliberately does not notify listeners, so this
   * cannot push state from inside a state push. Returns whether a bookmark took an icon. */
  function offerIcons (list: TabsSnapshot['tabs']): boolean {
    const all = offerAllIcons
    offerAllIcons = false
    let filled = false
    const open = new Set<string>()
    for (const tab of list) {
      open.add(tab.id)
      if (tab.favicon === null) {
        offeredIcons.delete(tab.id)
        continue
      }
      const before = offeredIcons.get(tab.id)
      const changed = before === undefined || before.favicon !== tab.favicon || before.url !== tab.url || before.displayUrl !== tab.displayUrl
      if (!changed && !all) continue
      if (bookmarks.fillMissingFavicon(tab.url, tab.favicon)) filled = true
      if (changed) {
        offeredIcons.set(tab.id, { url: tab.url, displayUrl: tab.displayUrl, favicon: tab.favicon })
        rememberIcon(tab.displayUrl, tab.favicon)
      }
    }
    for (const id of offeredIcons.keys()) if (!open.has(id)) offeredIcons.delete(id)
    return filled
  }

  /** Previous push's active tab, so pushState() can tell a genuine tab
   * SWITCH from the many other reasons state is pushed (a title, a favicon,
   * a loading flag). */
  let lastActiveTabId: string | null = null
  /** Previous push's active tab's own origin -- catches the site-info
   * popup's own extra close condition: the SAME tab navigating to a
   * DIFFERENT origin (never a reason to close the all-sites popup, which
   * shows every app, not just the active tab's). `null` for no active tab
   * or one with no canonical origin (the dashboard, about:blank). */
  let lastActiveOrigin: string | null = null
  /** Previous push's active tab's URL without its fragment, to tell a navigation from a scroll to an anchor. */
  let lastActiveUrl: string | null = null

  /** The person moved to another tab: what belonged to the old one is dismissed. Switching reattaches the
   * incoming tab's view (TabManager.activateTab -> addChildView), which would stack it ABOVE a panel -- the
   * panel is only on top because it was added last -- so this does not depend on focus semantics to avoid
   * leaving a panel stranded under a page. */
  function onTabSwitched (): void {
    overlays.tabSwitched()
  }

  /** The active tab loaded another page (the fragment does not count). */
  function onNavigated (): void {
    overlays.navigated()
  }

  /** After a push has been sent. */
  function afterPush (): void {
    overlays.restack()
  }

  function pushState (): void {
    // Closing the last tab destroys `chrome`, and a late bookmarks or zoom
    // callback must not send to it: sending on a destroyed WebContents throws.
    if (chrome.webContents.isDestroyed()) return
    const state = tabs.getState()

    const iconFilled = offerIcons(state.tabs)
    const switched = state.activeTabId !== lastActiveTabId
    if (switched) {
      lastActiveTabId = state.activeTabId
      onTabSwitched()
    }
    // The site-info popup describes ONE origin -- a same-tab navigation
    // to a different one (the active tab id unchanged) leaves it showing
    // stale data otherwise. The all-sites popup lists every app and is
    // unaffected by this on its own.
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
    const activeOrigin = activeTab === undefined ? null : originFromUrl(activeTab.url)
    if (activeOrigin !== lastActiveOrigin) {
      lastActiveOrigin = activeOrigin
      closeSiteInfo()
    }
    const activeUrl = activeTab === undefined ? null : activeTab.url.split('#')[0] ?? null
    if (activeUrl !== lastActiveUrl) {
      lastActiveUrl = activeUrl
      if (!switched) onNavigated()
    }
    fullscreen.tabsChanged(state.activeTabId, (id) => state.tabs.some((tab) => tab.id === id))
    chrome.webContents.send(STATE_CHANNEL, {
      ...readStateParts(context, state),
      ...state,
      bookmarksBar: bookmarksBarShown(),
      zoomPercent: zoomChip(activeTab?.url),
      profile: profileLook
    })
    // The bar's items travel only when they change, so an icon that arrived late is sent here.
    if (iconFilled) sendBarItems()
    afterPush()
  }

  function sendBarItems (): void {
    sendChromeEvent(context.window, 'bookmarks-bar', barItemsOf(bookmarks))
  }

  // Only the first and last bookmark change the chrome's height, so the
  // relayout is guarded on the height actually moving rather than run on
  // every add and remove -- resizing two views per keystroke-speed change
  // would be visible.
  let laidOutHeight = layout.chromeHeight()
  function onBookmarksChanged (): void {
    if (win.isDestroyed()) return
    offerAllIcons = true
    const height = layout.chromeHeight()
    if (height !== laidOutHeight) {
      laidOutHeight = height
      layout.layoutChrome()
      tabs.layout()
      // The toolbar and the tab area moved, so an overlay placed against
      // either is now off by the row's height.
      overlays.relayout()
    }
    sendBarItems()
    pushState()
  }

  // Shown only when the page is not at the default level: a chip that always said 100% would be noise.
  function zoomChip (url: string | undefined): number | null {
    const origin = url === undefined ? null : originFromUrl(url)
    if (origin === null) return null
    const percent = services.zoom.percentFor(origin)
    return percent === services.zoom.defaultPercent() ? null : percent
  }

  tabs.onStateChange(pushState)
  const stopListeningToZoom = services.zoom.onChange(pushState)
  // Read when the profiles change, not on every push: it reads the disk.
  let profileLook = services.profiles.look()
  const stopListeningToProfiles = services.profiles.onChange(() => { profileLook = services.profiles.look(); pushState() })
  const stopListeningToBookmarks = bookmarks.onChange(onBookmarksChanged)
  const stopListeningToSettings = services.settings.onChange(({ key }) => {
    if (key === 'appearance.bookmarksBar') onBookmarksChanged()
  })
  const stopWatchingParts = watchStateParts(context, pushState)
  // The process loads the store before its first window (index.ts), so this
  // settles at once; it goes through onBookmarksChanged, not pushState, so a
  // window made before the load (a test's) still grows the chrome by a row
  // when the bookmarks land.
  void bookmarks.load().then(onBookmarksChanged)

  return {
    pushState,
    stop: () => {
      stopListeningToBookmarks()
      stopListeningToSettings()
      stopListeningToZoom()
      stopListeningToProfiles()
      stopWatchingParts()
    }
  }
}
