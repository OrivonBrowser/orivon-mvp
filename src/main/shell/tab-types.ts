// The shapes TabManager pushes to the chrome UI -- split out of tabs.ts
// (see that directory's README, `## Design notes`) once the swap-on-
// navigate fix pushed that file over Rule 2's 500-line limit. These are
// wire-format types with no logic of their own; tabs.ts re-exports them so
// every existing `from './tabs.js'` import keeps working unchanged.
import type { BaseWindow, LoadURLOptions, View, WebContents, WebContentsView } from 'electron'
import type { FrameState } from './split-controller.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { Connection } from '../browsing/connection.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { InternalPageRegistry } from '../pages/internal-registry.js'
import type { DevToolsGate } from '../devtools/devtools-service.js'
import type { TabLifecycle } from './tab-lifecycle.js'
import type { ShellServices } from './shell-services.js'
import type { CommandId } from '../shortcuts/commands.js'

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
  /** The tab shown beside this one in a split, or null. */
  splitWith: string | null
  /** One of the shell's own pages (Settings, History, ...). It has no site: no shield, no permissions, nothing to bookmark. */
  isInternal: boolean
  /** What the address bar may say about the connection: a lock, a warning, or nothing (browsing/connection.ts). */
  connection: Connection
  /** Kept at the strip's start, narrow, and not closed by accident. */
  pinned: boolean
  /** The page's sound is switched off. */
  muted: boolean
  /** The page is making sound now. */
  audible: boolean
  /** Why the page's renderer died (`render-process-gone`'s reason), or null while it lives. */
  crashed: string | null
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
  /** The active tab's address is in the bar or in Other bookmarks: the star shows it. */
  bookmarked: boolean
  /** Whether the bookmarks bar is shown: main decides (it sizes the chrome view to match) and the page follows. */
  bookmarksBar: boolean
  /** The active page's zoom, when it differs from what a site gets by default; otherwise null. */
  zoomPercent: number | null
  /** Which profile this window is, for the chip beside the menu. */
  profile: { name: string, color: string, isPrivate: boolean, shown: boolean }
  /** Whether the toolbar shows the Home button (`toolbar.home`). */
  homeButton: boolean
  /** Whether the address bar shows the literal address when it is not being edited (`addressBar.showFullUrl`). */
  showFullUrl: boolean
  /** The key caps bound to the commands the chrome names in a tooltip, or null when one is cleared. */
  shortcutKeys: { readonly 'nav.home': readonly string[] | null, readonly 'tab.search': readonly string[] | null }
  /** What the active tab's sign-in form can use, for the address bar's password button (src/main/passwords/). */
  logins: { readonly count: number, readonly offer: boolean, readonly signUp: boolean }
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
  /** The tab currently holding the whole window, if any (`HtmlFullscreen.tabId`, ../fullscreen.ts):
   * the one place that state lives. Absent in tests that never raise HTML fullscreen. */
  fullscreenTabId?: () => string | null
  /** The URL that searches for a query, under the chosen search engine. Absent in tests: the default engine. */
  searchUrl?: (query: string) => string
  /** Where a tab opened as one of the shell's own pages is recorded. Absent in tests. */
  internalPages?: InternalPageRegistry
  /** Developer tools for a tab. Absent in tests: no "Inspect". */
  devtools?: DevToolsGate
  /** What is drawn behind two panes. Absent in tests, and a window that never splits never makes it. */
  backdrop?: SplitBackdrop
  /** Where a tab's creation, activation, closing and view replacement are
   * reported (tab-lifecycle.ts). Absent in tests: nothing outside the tab
   * collection hears about them. */
  tabLifecycle?: TabLifecycle
  /** Opens `url` as the only tab of a brand new window in this same process
   * -- so a private window's new window is private too (window.ts makes
   * every window the same way, from the same `services`). Absent in tests.
   * `loadOptions` -- see popups.ts's `loadOptionsFor`'s own doc. */
  openWindow?: (url: string, loadOptions?: LoadURLOptions) => WebContents
  /** What every window of the process shares, for view-level code that needs a setting or a store (the context menu). Absent in tests. */
  services?: ShellServices
  /** Runs a command on this window, as a key or a menu row would. Absent in tests: nothing runs. */
  runCommand?: (id: CommandId) => void
}

/** The view behind two panes: the divider, and an outline round the pane the person is in. */
export interface SplitBackdrop {
  /** Made when first asked for. */
  readonly view: View
  update: (state: FrameState) => void
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
  readonly broker: Broker | undefined
  /** Read only to tell "still showing the dashboard" from "navigated away", in `wireView`'s did-navigate. Never used to decide that a tab IS the dashboard -- `TabRecord.isDashboardTab` owns that, and only creation sets it. */
  readonly dashboardUrl: string
  /** Undefined without a window around the tabs; a tab then shows no dialog or menu. */
  readonly window: BaseWindow | undefined
  /** Passed straight through from TabShell -- tab-view.ts's repartitionView()
   * fires `viewReplaced` on it directly, since that is the one lifecycle
   * event this seam raises outside tabs.ts itself. */
  readonly tabLifecycle: TabLifecycle | undefined
  /** Whether the tab's view is on screen: it is the tab in front, or the other pane beside it. */
  isShown: (id: string) => boolean
  /** Takes a view off the screen, and puts another in its place: what a tab moving to another session does. */
  detachView: (view: WebContentsView) => void
  attachView: (id: string, view: WebContentsView) => void
  /** The person pressed in the tab's page. In a split, that makes it the pane they are in. */
  paneClicked: (id: string) => void
  /** "Open Link in Split View": the link opens in a new tab beside this one. */
  openInSplit: (id: string, url: string) => void
  emitState: () => void
  captureFavicon: (id: string, record: TabRecord, favicons: string[]) => Promise<void>
  forgetTab: (id: string) => void
  /** `active` false leaves the tab strip's current tab in front: a middle
   * click or a plain ctrl+click, from popups.ts's `windowOpenHandler`. `loadOptions` -- see
   * popups.ts's `loadOptionsFor`'s own doc. Returns the new (or, at the tab ceiling, the existing
   * active) tab's webContents, so a no-guest popup open can adopt a correctly-partitioned,
   * sanitized tab instead of building its own unpartitioned view. */
  openTab: (url: string, active?: boolean, loadOptions?: LoadURLOptions) => WebContents | undefined
  /** Makes Chromium's own popup webContents, already in `partition`, a tab.
   * `active` -- see `openTab`'s own doc. */
  adoptPopup: (view: WebContentsView, partition: string | undefined, active?: boolean) => void
  /** A same-origin blob: URL in `partition` (the opener's own) -- popups.ts's own doc.
   * `active`/`loadOptions` -- see `openTab`'s own doc. */
  openBlobTab: (url: string, partition: string | undefined, active?: boolean, loadOptions?: LoadURLOptions) => WebContents | undefined
  /** `url` in a new window instead of this one -- a shift-click (popups.ts's `windowOpenHandler`).
   * `loadOptions` -- see popups.ts's `loadOptionsFor`'s own doc. Undefined when the shell has none
   * (tests): the caller opens an ordinary tab here instead. */
  openWindow: (url: string, loadOptions?: LoadURLOptions) => WebContents | undefined
  atCapacity: () => boolean
  htmlFullscreenChanged: (id: string, entered: boolean) => void
  /** The window is closing: nothing more is made or shown for it. */
  isClosing: () => boolean
  readonly devtools: DevToolsGate | undefined
  /** `TabShell.services`: undefined in tests. */
  readonly services: ShellServices | undefined
  /** Runs a command on the window holding this tab; does nothing without a shell. */
  runCommand: (id: CommandId) => void
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
  /** The candidate the newest favicon capture is trying: a capture that
   * finds another value here lost to a newer icon set and must not write
   * `favicon` (favicon.ts's captureFaviconInto). */
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
  /** Kept at the strip's start. Set by the pin feature; travels with the tab to another window. Absent reads as false: the factory sets it, a test's hand-made record need not. */
  pinned?: boolean
  /** The tab's sound is switched off; applied to whichever webContents the tab shows (tab-signals.ts's `apply`). Absent reads as false. */
  muted?: boolean
  /** Why the renderer died, or null. Set from `render-process-gone`, cleared on the next load. Absent reads as null. */
  crashed?: string | null
}
