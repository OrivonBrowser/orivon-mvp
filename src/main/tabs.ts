// Owns every tab's WebContentsView and the state pushed to the chrome UI.
//
// Main holds truth (build-plan.md's shell architecture, this session's plan):
// the chrome view sends commands (newTab, navigate, back, ...) and receives a
// full ShellState snapshot after every change. It never derives tab state
// itself.
//
// T18 (security-model.md): every tab WebContents gets setWindowOpenHandler
// wired to open a new tab rather than a popup. will-navigate origin-locking
// is deliberately NOT added here -- that lock applies to granted apps, which
// do not exist until build step 4, and ordinary tabs must browse freely.
import { WebContentsView, type View } from 'electron'
import { join } from 'node:path'
import type { Bookmark } from './bookmarks.js'
import { fetchFaviconDataUrlCached, pickFaviconUrl, shouldClearFavicon } from './favicon.js'
import { parseOmniboxInput, sanitizeDirectUrl } from './omnibox.js'

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
   * lands here, never the dashboard -- see resolveTarget()) -- both mean
   * "nothing the user meaningfully typed or navigated to yet". The
   * chrome renderer uses this to blank the address bar, skip the
   * secure/insecure dot, and guard the bookmark toggle, replacing what
   * were literal `tab.url === 'about:blank'` checks before the
   * dashboard existed.
   *
   * NOT simply `url === dashboardUrl` -- found 2026-08-28: in dev mode
   * `dashboardUrl` is a plain http://localhost:PORT/... address, which
   * `sanitizeDirectUrl` does not reject, so an ordinary page could steer
   * an UNRELATED tab's URL to match it (window.open(), or a same-page
   * redirect) and get "new tab" treatment on content that was never the
   * dashboard. Gated on TabRecord.isDashboardTab too -- set once, at
   * creation, from createTab()'s own decision, never from a URL a page
   * can influence. */
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

/** The safe fallback for a REJECTED navigation (a dangerous typed scheme,
 * a bad window.open() URL, empty input) -- never the dashboard. Keeping
 * these landings on a plain, privilege-free page rather than the
 * dashboard matters structurally, not just cosmetically: an EXISTING
 * tab keeps whatever preload it was created with (preload is fixed at
 * WebContentsView creation, see createTab()), so a tab created with the
 * ordinary app.js preload that later lands here via a rejected
 * navigate() call must never show a page that expects the dashboard's
 * own preload to exist. */
const BLANK_URL = 'about:blank'

/** Defensive, found 2026-08-28 while investigating a reported crash: an
 * unbounded window.open() flood (an ad/popunder pattern, not
 * hypothetical) would otherwise mint unlimited WebContentsViews -- each
 * its own renderer process -- until the machine OOMs. Refusing beyond
 * this ceiling is far cheaper than crashing the whole browser; no
 * legitimate manual use opens anywhere near 100 tabs. */
const MAX_TABS = 100

let nextId = 1
function makeTabId (): string {
  return `tab-${nextId++}`
}

interface TabRecord {
  readonly view: WebContentsView
  favicon: string | null
  faviconOrigin: string | null
  /** Guards a fetch that resolves after the tab already closed or
   * navigated again -- only the record's own most recent request may
   * write `favicon`. */
  pendingFaviconUrl: string | null
  /** Set once, at creation, from createTab()'s own `isDashboard` decision
   * -- never re-derived from a URL afterward. See TabState.isNewTab's
   * own doc comment for why this matters: `this.dashboardUrl` is a
   * plain http:// address in dev mode, which an ordinary page's
   * window.open() (or a same-page redirect) COULD steer an unrelated,
   * non-dashboard tab's `wc.getURL()` to match -- this flag is what
   * stops that from also granting it "new tab" treatment. */
  readonly isDashboardTab: boolean
}

export class TabManager {
  /** One record per tab -- replaces a bare `Map<string, WebContentsView>`
   * (build step 1) so favicon state and the view share one lifetime.
   * A second, parallel map would need closeTab() to remember deleting
   * from both, which is exactly the leak class this avoids. */
  private readonly tabs = new Map<string, TabRecord>()
  /** Tab strip order, separate from the Map's insertion-order guarantee so
   * reordering (not in this step's scope, but the seam matters) doesn't
   * require touching the Map. */
  private readonly order: string[] = []
  private activeId: string | null = null
  private readonly listeners = new Set<(state: TabsSnapshot) => void>()
  private readonly preloadPath: string
  private readonly newTabPreloadPath: string

  constructor (
    private readonly contentView: View,
    private readonly getTabBounds: () => Bounds,
    /** Called at most once, when the last tab closes -- A16, owner
     * decision 2026-08-28: closing the last tab closes the window
     * (Firefox/Safari-shaped), not left open and empty (the prior,
     * undecided default) or a fresh tab (Chrome/Edge-shaped, the doc's
     * own superseded AI-REC). window.ts wires this to `win.close()`;
     * TabManager itself never calls `app.quit()` -- src/main/index.ts's
     * existing `window-all-closed` handler is already the correct,
     * complete owner of whether the whole process then exits. */
    private readonly onEmpty: () => void,
    /** The dashboard's own resolved URL (dev server or built file,
     * decided once by window.ts the same way it resolves the chrome
     * view's own URL) -- a genuinely fresh tab (createTab() with no
     * `url` argument) loads this, with the dashboard's own preload
     * below. Never reachable via a rejected navigation -- see
     * BLANK_URL and resolveTarget(). */
    private readonly dashboardUrl: string
  ) {
    this.preloadPath = join(import.meta.dirname, '../preload/app.js')
    this.newTabPreloadPath = join(import.meta.dirname, '../preload/newtab.js')
  }

  onStateChange (cb: (state: TabsSnapshot) => void): void {
    this.listeners.add(cb)
  }

  getState (): TabsSnapshot {
    return {
      tabs: this.order.map((id) => this.tabState(id)),
      activeTabId: this.activeId
    }
  }

  createTab (url?: string): string {
    if (this.order.length >= MAX_TABS) {
      // Refuse rather than crash -- see MAX_TABS above. Nothing reads
      // this return value today (grep confirms every caller discards
      // it), but the signature stays `string`, so hand back whatever is
      // already current rather than inventing a sentinel.
      return this.activeId ?? ''
    }

    // Computed BEFORE the view exists: preload is fixed at
    // WebContentsView creation and can never change for this tab
    // afterward, so the dashboard-or-not decision has to be made here,
    // not after loadURL(). `url === undefined` -- a genuinely fresh tab,
    // never a caller-supplied value -- is the ONLY thing that selects
    // the dashboard preload. A page cannot trigger this by supplying the
    // dashboard's own URL as a window.open() target: that still goes
    // through sanitizeDirectUrl below and gets the ORDINARY preload
    // regardless of what URL it resolves to.
    const isDashboard = url === undefined
    const target = isDashboard ? this.dashboardUrl : (sanitizeDirectUrl(url) ?? BLANK_URL)

    const id = makeTabId()
    const view = new WebContentsView({
      webPreferences: {
        preload: isDashboard ? this.newTabPreloadPath : this.preloadPath,
        // Tells the dashboard's own preload (src/preload/newtab.ts) what
        // its expected URL is, so it can verify `location.href` matches
        // before exposing anything -- necessary because a dashboard tab
        // is an ordinary, navigable tab (unlike the chrome view), and
        // preload cannot be un-set if the user later navigates away.
        ...(isDashboard ? { additionalArguments: [`--orivon-newtab-url=${this.dashboardUrl}`] } : {}),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    const record: TabRecord = {
      view,
      favicon: null,
      faviconOrigin: null,
      pendingFaviconUrl: null,
      isDashboardTab: isDashboard
    }

    const wc = view.webContents
    wc.on('page-title-updated', () => this.emitState())
    wc.on('did-navigate', (_event, navigatedUrl: string) => {
      if (shouldClearFavicon(record.faviconOrigin, navigatedUrl)) {
        record.favicon = null
        record.faviconOrigin = null
      }
      this.emitState()
    })
    wc.on('did-navigate-in-page', () => this.emitState())
    wc.on('did-start-loading', () => this.emitState())
    wc.on('did-stop-loading', () => this.emitState())
    wc.on('page-favicon-updated', (_event, favicons: string[]) => {
      void this.captureFavicon(id, record, favicons)
    })
    // A renderer crash or other unexpected teardown destroys the
    // webContents without going through closeTab(). Without this, the
    // id stays in `this.tabs`, and the NEXT emitState() -- fired by any
    // OTHER tab's event -- calls .getURL() etc. on a destroyed native
    // object and throws inside a main-process Electron callback. There
    // is no top-level handler anywhere in this app (confirmed: no
    // uncaughtException, no render-process-gone), so that throw exits
    // the whole process -- matches the shape of electron/electron#19887.
    // Cleaning the record out here, proactively, is what makes every
    // `!isDestroyed()` guard below actually reachable rather than
    // theatre: by the time anything else runs, a dead tab is already
    // gone from `this.tabs`.
    wc.on('destroyed', () => { this.forgetTab(id, false) })

    // T18: never let a tab open a real popup window -- route it to a new
    // tab in this same shell instead.
    wc.setWindowOpenHandler((details) => {
      this.createTab(details.url)
      return { action: 'deny' }
    })

    this.tabs.set(id, record)
    this.order.push(id)

    void wc.loadURL(target)

    this.activateTab(id)
    return id
  }

  closeTab (id: string): void {
    this.forgetTab(id, true)
  }

  /** Shared by closeTab() (user- or app-initiated) and the webContents
   * 'destroyed' handler (unexpected teardown, e.g. a crash). `closeView`
   * is false for the crash path: the webContents is already gone, and
   * calling further methods on a destroyed object throws. */
  private forgetTab (id: string, closeView: boolean): void {
    const record = this.tabs.get(id)
    if (record === undefined) return

    if (this.activeId === id) {
      this.contentView.removeChildView(record.view)
    }
    if (closeView && !record.view.webContents.isDestroyed()) {
      record.view.webContents.close()
    }
    this.tabs.delete(id)

    const idx = this.order.indexOf(id)
    if (idx !== -1) this.order.splice(idx, 1)

    if (this.activeId === id) {
      const fallback = this.order[Math.max(0, idx - 1)]
      this.activeId = null
      if (fallback !== undefined) {
        this.activateTab(fallback)
        return
      }
    }

    // A16, resolved: the last tab closing means there is nothing left to
    // show -- close the window rather than leaving it open and empty.
    // Reachable from exactly one call site: `record` is already deleted
    // above, so a second forgetTab() for a since-removed id returns at
    // the guard at the top of this method instead of reaching here --
    // onEmpty cannot double-fire off the multiple emitState() sources
    // (tab events, bookmark events) the way a `state.tabs.length === 0`
    // check in window.ts's pushState would.
    if (this.order.length === 0) {
      this.onEmpty()
      return
    }
    this.emitState()
  }

  activateTab (id: string): void {
    const record = this.tabs.get(id)
    if (record === undefined || record.view.webContents.isDestroyed()) return

    if (this.activeId !== null && this.activeId !== id) {
      const previous = this.tabs.get(this.activeId)
      if (previous !== undefined) this.contentView.removeChildView(previous.view)
    }

    if (this.activeId !== id) {
      this.contentView.addChildView(record.view)
      record.view.setBounds(this.getTabBounds())
    }

    this.activeId = id
    this.emitState()
  }

  /** Re-applies the active tab's bounds -- called on window resize. */
  layout (): void {
    if (this.activeId === null) return
    const record = this.tabs.get(this.activeId)
    if (record !== undefined && !record.view.webContents.isDestroyed()) {
      record.view.setBounds(this.getTabBounds())
    }
  }

  navigate (id: string, rawInput: string): void {
    const record = this.tabs.get(id)
    if (record === undefined || record.view.webContents.isDestroyed()) return
    const target = this.resolveTarget(rawInput)
    void record.view.webContents.loadURL(target)
  }

  back (id: string): void {
    const wc = this.liveWebContents(id)
    const history = wc?.navigationHistory
    if (history?.canGoBack() === true) history.goBack()
  }

  forward (id: string): void {
    const wc = this.liveWebContents(id)
    const history = wc?.navigationHistory
    if (history?.canGoForward() === true) history.goForward()
  }

  reload (id: string): void {
    this.liveWebContents(id)?.reload()
  }

  /** Fetches the favicon for `favicons[0]` (the first http(s) candidate)
   * and stores it on `record`, unless the tab has since closed or moved
   * on to a different favicon request. */
  private async captureFavicon (id: string, record: TabRecord, favicons: string[]): Promise<void> {
    const sourceUrl = pickFaviconUrl(favicons)
    if (sourceUrl === null) return

    record.pendingFaviconUrl = sourceUrl
    const dataUrl = await fetchFaviconDataUrlCached(sourceUrl)

    // The tab may have closed (removed from `this.tabs`) or navigated to
    // a page with a different favicon (a newer request overwrote
    // pendingFaviconUrl) while this fetch was in flight -- either way,
    // this stale result must not win.
    if (this.tabs.get(id) !== record || record.pendingFaviconUrl !== sourceUrl) return
    if (dataUrl === null) return

    record.favicon = dataUrl
    try {
      record.faviconOrigin = new URL(sourceUrl).origin
    } catch {
      record.faviconOrigin = null
    }
    this.emitState()
  }

  /** Rejected omnibox input (a dangerous scheme, or empty) never reaches
   * `loadURL` -- it falls back to a plain blank page rather than
   * silently doing nothing, so a bad paste has a visible, safe result.
   * Never the dashboard -- see BLANK_URL's own comment for why. */
  private resolveTarget (rawInput: string): string {
    const result = parseOmniboxInput(rawInput)
    if (result.kind === 'reject') return BLANK_URL
    return result.url
  }

  /** Resolves an IPC event's own sender back to a tab id -- used by the
   * dashboard's `navigate` command (newtab-ipc.ts), which must act on
   * the CALLING tab, never a tab id the page could simply claim. Linear
   * scan is fine here: bounded by MAX_TABS, and called once per
   * dashboard interaction, not per frame. */
  findTabIdByWebContents (wc: Electron.WebContents): string | null {
    for (const [id, record] of this.tabs) {
      if (record.view.webContents === wc) return id
    }
    return null
  }

  /** A tab's webContents, or undefined if the tab is gone or its
   * webContents has already been destroyed -- the common guard every
   * read-only accessor below needs. */
  private liveWebContents (id: string): Electron.WebContents | undefined {
    const record = this.tabs.get(id)
    if (record === undefined || record.view.webContents.isDestroyed()) return undefined
    return record.view.webContents
  }

  private tabState (id: string): TabState {
    const record = this.tabs.get(id)
    const wc = this.liveWebContents(id)
    const url = wc?.getURL() ?? ''
    return {
      id,
      url,
      title: wc?.getTitle() ?? '',
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false,
      favicon: record?.favicon ?? null,
      isNewTab: url === BLANK_URL || (record?.isDashboardTab === true && url === this.dashboardUrl)
    }
  }

  private emitState (): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
