// The shapes TabManager pushes to the chrome UI -- split out of tabs.ts
// (see that directory's README, `## Design notes`) once the swap-on-
// navigate fix pushed that file over Rule 2's 500-line limit. These are
// wire-format types with no logic of their own; tabs.ts re-exports them so
// every existing `from './tabs.js'` import keeps working unchanged.
import type { Bookmark } from './bookmarks.js'

export interface TabState {
  id: string
  url: string
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
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
