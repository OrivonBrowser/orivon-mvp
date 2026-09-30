// What one window tells its chrome view: the tab collection, the bookmarks, the
// zoom chip and the profile look, folded into one ShellState and pushed on
// every change. It also decides which dismissals a push implies (a tab switch,
// a navigation, the site-info origin changing) and starts the sources whose
// changes cause a push, and the stop that ends them with the window.
import type { BaseWindow, WebContentsView } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { STATE_CHANNEL } from '../channels.js'
import type { OverlayHostHandle } from '../overlays/overlay-host.js'
import type { HtmlFullscreen } from './fullscreen.js'
import { readStateParts, watchStateParts } from './shell-state-parts.js'
import type { ShellServices } from './shell-services.js'
import type { TabManager } from './tabs.js'
import type { WindowContext } from './window-context.js'
import type { WindowLayout } from './window-layout.js'

export interface WindowStateDeps {
  readonly win: BaseWindow
  readonly chrome: WebContentsView
  readonly tabs: TabManager
  readonly services: ShellServices
  readonly context: WindowContext
  readonly fullscreen: HtmlFullscreen
  readonly layout: WindowLayout
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
  const { bookmarks } = services

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
    // A16 makes this reachable routinely now, not just via an OS-level
    // window close: closing the last tab calls win.close(), which
    // destroys `chrome` -- and bookmarks.onChange()/the pending
    // bookmarks.load().then(pushState) below have no other guard against
    // firing afterward. Sending on a destroyed WebContents throws, with
    // no top-level handler anywhere in this app (same class of gap
    // tabs.ts's own 'destroyed' handling exists for).
    if (chrome.webContents.isDestroyed()) return
    const state = tabs.getState()

    // Star a page the instant it opens and its favicon has not arrived yet,
    // so the bookmark is saved iconless. The fetch lands moments later and
    // pushes state -- this is where that late icon reaches the bookmark it
    // belongs to. fillMissingFavicon never overwrites an icon already
    // stored, and deliberately does not notify listeners, so this cannot
    // push state from inside a state push; the list read below already
    // reflects it.
    for (const tab of state.tabs) {
      if (tab.favicon !== null) bookmarks.fillMissingFavicon(tab.url, tab.favicon)
    }
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
      bookmarks: bookmarks.getAll(),
      bookmarksBar: bookmarksBarShown(),
      zoomPercent: zoomChip(activeTab?.url),
      profile: profileLook
    })
    afterPush()
  }

  // Only the first and last bookmark change the chrome's height, so the
  // relayout is guarded on the height actually moving rather than run on
  // every add and remove -- resizing two views per keystroke-speed change
  // would be visible.
  let laidOutHeight = layout.chromeHeight()
  function onBookmarksChanged (): void {
    if (win.isDestroyed()) return
    const height = layout.chromeHeight()
    if (height !== laidOutHeight) {
      laidOutHeight = height
      layout.layoutChrome()
      tabs.layout()
    }
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
  // Loading is non-blocking -- no bookmarks bar for one frame on a slow
  // disk beats delaying the whole window on a non-essential feature. It
  // goes through onBookmarksChanged, not pushState: a profile that HAS
  // bookmarks grows the chrome by a row the moment they land. The store
  // reads its file once for every window, so a later window's call settles
  // at once.
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
