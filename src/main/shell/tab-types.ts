// The shapes TabManager pushes to the chrome UI -- split out of tabs.ts
// (see that directory's README, `## Design notes`) once the swap-on-
// navigate fix pushed that file over Rule 2's 500-line limit. These are
// wire-format types with no logic of their own; tabs.ts re-exports them so
// every existing `from './tabs.js'` import keeps working unchanged.
import type { BaseWindow, View, WebContentsView } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import type { Bookmark } from '../browsing/bookmarks.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { InternalPageRegistry } from '../pages/internal-registry.js'

export interface TabState {
  id: string
  url: string
  /** `url` as the address bar shows it: a protocol's address such as `ipfs://<cid>/` where `url` is the https URL serving it. */
  displayUrl: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** A data: URL, or null (no real favicon yet -- the chrome renders a
   * generic globe). Never the source https:// URL directly -- see
   * favicon.ts's header for why the fetch happens in main. */
  favicon: string | null
  /** True for the dashboard (a fresh tab's real content, src/renderer/
   * newtab/) or the literal about:blank fallback (a rejected navigation
   * lands here, never the dashboard -- see tabs.ts's resolveTarget()) --
   * both mean "nothing the user meaningfully typed or navigated to yet".
   * The chrome renderer uses this to blank the address bar, skip the
   * secure/insecure dot, and guard the bookmark toggle, replacing what
   * were literal `tab.url === 'about:blank'` checks before the
   * dashboard existed.
   *
   * NOT simply `url === dashboardUrl` -- found 2026-08-28: in dev mode
   * `dashboardUrl` is a plain http://localhost:PORT/... address, which
   * `sanitizeDirectUrl` does not reject, so an ordinary page could steer
   * an UNRELATED tab's URL to match it (window.open(), or a same-page
   * redirect) and get "new tab" treatment on content that was never the
   * dashboard. Gated on TabRecord.isDashboardTab too (tabs.ts) -- set at
   * creation, and only ever flipped false, one-way, by a real navigation
   * (repartitionView()), never from a URL a page can influence. */
  isNewTab: boolean
  /** One of the shell's own pages (Settings, History, ...). It has no site: no shield, no permissions, nothing to bookmark. */
  isInternal: boolean
}

/** What TabManager itself knows. Bookmarks are a separate store
 * (bookmarks.ts) that window.ts composes alongside this into the full
 * ShellState pushed to the chrome view -- TabManager has no reason to
 * know bookmarks exist. */
export interface TabsSnapshot {
  tabs: TabState[]
  activeTabId: string | null
}

export interface ShellState extends TabsSnapshot {
  bookmarks: Bookmark[]
  /** Whether the bookmarks bar is shown: main decides (it sizes the chrome view to match) and the page follows. */
  bookmarksBar: boolean
  /** The active page's zoom, when it differs from what a site gets by default; otherwise null. */
  zoomPercent: number | null
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** What the window around the tabs gives them: window.ts supplies it. */
export interface TabShell {
  /** The window a tab's dialogs and menus attach to. */
  readonly window: BaseWindow
  /** A tab's page entered or left HTML fullscreen. */
  htmlFullscreenChanged: (id: string, entered: boolean) => void
  /** The URL that searches for a query, under the chosen search engine. Absent in tests: the default engine. */
  searchUrl?: (query: string) => string
  /** Where a tab opened as one of the shell's own pages is recorded. Absent in tests. */
  internalPages?: InternalPageRegistry
}

/** What the per-view wiring in tab-view.ts needs back from the TabManager
 * that holds the tab.
 *
 * An explicit surface rather than the class itself: that wiring is about ONE
 * view's lifetime, and keeping it honest about what it touches is what lets it
 * live outside the tab collection at all. `forgetTab` is the crash path,
 * `openTab` and `adoptPopup` the two ways a page opens a tab -- all
 * deliberately narrower than the methods behind them. */
export interface TabViewHost {
  readonly preloadPath: string
  readonly contentView: View
  readonly broker: Broker | undefined
  /** Read only to tell "still showing the dashboard" from "navigated away", in `wireView`'s did-navigate. Never used to decide that a tab IS the dashboard -- `TabRecord.isDashboardTab` owns that, and only creation sets it. */
  readonly dashboardUrl: string
  /** Undefined without a window around the tabs; a tab then shows no dialog or menu. */
  readonly window: BaseWindow | undefined
  isActive: (id: string) => boolean
  emitState: () => void
  captureFavicon: (id: string, record: TabRecord, favicons: string[]) => Promise<void>
  forgetTab: (id: string) => void
  openTab: (url: string) => void
  /** Makes Chromium's own popup webContents, already in `partition`, a tab. */
  adoptPopup: (view: WebContentsView, partition: string | undefined) => void
  atCapacity: () => boolean
  htmlFullscreenChanged: (id: string, entered: boolean) => void
  getTabBounds: () => Bounds
}

/** One live tab, as TabManager and the per-view wiring in tab-view.ts both
 * see it. Exported so that wiring can live outside the class. */
export interface TabRecord {
  /** The manager and window this tab belongs to, read AT CALL TIME by every
   * handler `wireView` attaches. Reassigned when a tab moves to another
   * window, so the handlers already on its views follow it there; a handler
   * that captured the host would keep acting for the window the tab left. */
  host: TabViewHost
  /** Mutable, not readonly: repartitionView() (see navigate()) replaces
   * this with a fresh WebContentsView whenever a navigation changes the
   * tab's origin -- Electron fixes a partition at construction, so
   * changing it is only possible by swapping the whole view. */
  view: WebContentsView
  favicon: string | null
  /** The origin of the PAGE that declared `favicon` -- never the favicon
   * resource's own origin (a CDN, commonly), which shouldClearFavicon
   * (favicon.ts) compares this against on every navigation. */
  faviconOrigin: string | null
  /** Guards a fetch that resolves after the tab already closed or
   * navigated again -- only the record's own most recent request may
   * write `favicon`. */
  pendingFaviconUrl: string | null
  /** The partition currently assigned to `view`, or undefined for the
   * shell's own default session -- kept alongside `view` so navigate()
   * can tell "did the origin actually change" without re-deriving it from
   * `view.webContents.getURL()`, which may still reflect an in-flight
   * navigation. */
  partition: string | undefined
  /** True only for a tab still showing the dashboard. Starts from
   * createTab()'s own `isDashboard` decision; repartitionView() flips it
   * to false, ONE-WAY, the moment a navigate() call sends this tab to
   * real, different-origin content -- never re-derived from a URL a page
   * could influence (see TabState.isNewTab's own doc comment: `this.
   * dashboardUrl` is a plain http:// address in dev mode, which a page
   * could otherwise steer an unrelated tab's `wc.getURL()` to match). */
  isDashboardTab: boolean
  /** The shell's own page this tab was opened as, or null. Set only by
   * `TabManager.openInternal`; cleared when the tab navigates to a website. */
  internalPage: InternalPageId | null
  /** The view of each app partition this tab has left, emptied to
   * about:blank and kept, keyed by partition. Coming back reuses it: a
   * page's sessionStorage lives in its view, and a fresh one would lose
   * what the app left there, an OIDC login's state among it. Filled and
   * emptied by tab-view.ts's repartitionView(); closing the tab closes
   * whatever is still here. */
  parkedViews: Map<string, WebContentsView>
}
