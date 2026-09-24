// Owns every tab's WebContentsView and the state pushed to the chrome UI.
//
// Main holds truth (build-plan.md's shell architecture, this session's plan):
// the chrome view sends commands (newTab, navigate, back, ...) and receives a
// full ShellState snapshot after every change. It never derives tab state
// itself.
//
// T18 (security-model.md): every tab WebContents gets setWindowOpenHandler
// wired so a popup becomes a tab, never an OS window. A redirect, clicked link, form
// submission or script navigation that changes a tab's origin is caught by
// wireView()'s own did-navigate handler, which repartitions the same way a
// typed cross-origin navigation already does (see repartitionView()'s own
// doc comment for the residual this catches late, not early).
import type { WebContentsView, View } from 'electron'
import { join } from 'node:path'
import { captureFaviconInto } from '../browsing/favicon.js'
import { parseOmniboxInput, sanitizeDirectUrl } from '../browsing/omnibox.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import type { SubsystemContext } from '../registry.js'
import { appTabArgsFor, closeParkedViews, makeTabView, partitionChanged, partitionForTarget, repartitionView, wireView } from './tab-view.js'
import type { TabShell, TabViewHost } from './tab-view.js'

export type { TabState, TabsSnapshot, ShellState, Bounds } from './tab-types.js'
import type { TabState, TabsSnapshot, Bounds, TabRecord } from './tab-types.js'

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

/** Any id but 0 (the page's own world) and 999 (the preload's). */
const EXIT_FULLSCREEN_WORLD_ID = 1001

let nextId = 1
function makeTabId (): string {
  return `tab-${nextId++}`
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
  /** The narrow surface tab-view.ts's per-view wiring calls back through. */
  private readonly viewHost: TabViewHost
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
    private readonly dashboardUrl: string,
    /** `ctx.broker` may be `undefined` (a run without the broker
     * subsystem), and `ctx.loader` is deliberately unused so far -- do not
     * remove either. README.md's design notes say what each is for. */
    private readonly ctx: SubsystemContext,
    /** Absent only in tests: tabs then show no dialog or menu, and nothing
     * hears about fullscreen. */
    shell?: TabShell
  ) {
    this.viewHost = {
      preloadPath: join(import.meta.dirname, '../preload/app.js'),
      contentView,
      // A GETTER, not a captured value: ctx.broker may still be undefined
      // when TabManager is constructed and be published afterwards. Reading
      // it once here would pin 'no broker' for the process lifetime.
      get broker () { return ctx.broker },
      dashboardUrl,
      window: shell?.window,
      isActive: (id) => this.activeId === id,
      emitState: () => { this.emitState() },
      captureFavicon: async (id, record, favicons) => { await this.captureFavicon(id, record, favicons) },
      forgetTab: (id) => { this.forgetTab(id, false) },
      openTab: (url) => { this.createTab(url) },
      adoptPopup: (view, partition) => { this.adoptPopup(view, partition) },
      atCapacity: () => this.atCapacity(),
      htmlFullscreenChanged: (id, entered) => { shell?.htmlFullscreenChanged(id, entered) },
      getTabBounds
    }
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
    if (this.atCapacity()) {
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

    // Excluded even though the dashboard's own URL is occasionally a real
    // http(s) address (electron-vite's dev server) -- `partitionForTarget`
    // cannot tell that apart from a real app on scheme alone, but the
    // dashboard is shell UI (ADR-0003's "browser state" tier), never app
    // content, and must never be isolated as if it were an app's own origin.
    const partition = isDashboard ? undefined : partitionForTarget(target, this.ctx.broker)

    const id = makeTabId()
    const view = makeTabView(
      isDashboard ? this.newTabPreloadPath : this.preloadPath,
      partition,
      // Tells the dashboard's own preload (src/preload/newtab.ts) what its
      // expected URL is, so it can verify `location.href` matches before
      // exposing anything -- necessary because a dashboard tab is an
      // ordinary, navigable tab (unlike the chrome view), and preload
      // cannot be un-set if the user later navigates away. A non-dashboard
      // tab instead gets appTabArgsFor's ADR-0017 flag, if this origin is
      // already a registered app.
      isDashboard ? [`--orivon-newtab-url=${this.dashboardUrl}`] : appTabArgsFor(target, this.ctx.broker)
    )
    const record: TabRecord = {
      view,
      favicon: null,
      faviconOrigin: null,
      pendingFaviconUrl: null,
      partition,
      isDashboardTab: isDashboard,
      parkedViews: new Map()
    }
    wireView(this.viewHost, id, record)

    this.tabs.set(id, record)
    this.order.push(id)

    void view.webContents.loadURL(target)

    this.activateTab(id)
    return id
  }

  private atCapacity (): boolean {
    return this.order.length >= MAX_TABS
  }

  /** A popup Chromium already created, with its opener, in the opener's
   * session (./popups.ts). It navigates itself; nothing is loaded here. */
  private adoptPopup (view: WebContentsView, partition: string | undefined): void {
    const id = makeTabId()
    const record: TabRecord = { view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition, isDashboardTab: false, parkedViews: new Map() }
    wireView(this.viewHost, id, record)
    this.tabs.set(id, record)
    this.order.push(id)
    this.activateTab(id)
  }

  /** Asks a tab's page to leave HTML fullscreen. In an isolated world, where
   * the page's own script cannot replace `document.exitFullscreen` and so
   * keep the screen. */
  exitHtmlFullscreen (id: string): void {
    void this.liveWebContents(id)
      ?.executeJavaScriptInIsolatedWorld(EXIT_FULLSCREEN_WORLD_ID, [{ code: 'document.exitFullscreen()' }])
      // Rejects when the page already left, which is the outcome wanted.
      .catch(() => {})
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
    // On the crash path too: a parked view is alive whatever became of the
    // one the tab showed.
    closeParkedViews(record)
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

  /** THE PRIMARY WAY A TAB EVER REACHES A REAL ORIGIN: the omnibox and the
   * dashboard's own navigate command both funnel here (ipc.ts, newtab-
   * ipc.ts) -- a person's very first act in a fresh tab is typing a URL,
   * not calling createTab(url) directly. Repartitions via repartitionView()
   * exactly when the target belongs in a different session from the one the
   * tab is in -- which, since 2026-09-15, means entering or leaving an
   * installed app, never one ordinary website to another. BLANK_URL has no
   * derivable origin, so a rejected navigation never swaps and keeps landing
   * in whatever view/partition the tab already had (BLANK_URL's own doc: "an
   * EXISTING tab keeps whatever preload it was created with"). */
  navigate (id: string, rawInput: string): void {
    const record = this.tabs.get(id)
    if (record === undefined || record.view.webContents.isDestroyed()) return
    const target = this.resolveTarget(rawInput)

    const swap = partitionChanged(target, record.partition, this.ctx.broker)
    if (swap !== undefined) {
      repartitionView(this.viewHost, id, record, target, swap.to)
      return
    }

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

  /** The icon this tab is currently showing, already fetched, size-capped
   * and re-encoded to a `data:` URL by favicon.ts. `null` when the page
   * declares none, or when its fetch has not landed yet. Read when a page
   * is starred, so the bookmark keeps the icon rather than the shell going
   * back to the network for one (bookmarks.ts's `favicon`). */
  faviconFor (id: string): string | null {
    return this.tabs.get(id)?.favicon ?? null
  }

  /** Wires this tab's identity into favicon.ts's capture sequence: which
   * document declared the icon, and whether this record is still the one
   * the map holds by the time the fetch lands. */
  private async captureFavicon (id: string, record: TabRecord, favicons: string[]): Promise<void> {
    await captureFaviconInto(
      record,
      favicons,
      () => record.view.webContents.getURL(),
      () => this.tabs.get(id) === record,
      () => { this.emitState() }
    )
  }

  /** Rejected omnibox input (a dangerous scheme, or empty) never reaches
   * `loadURL` -- it falls back to a plain blank page rather than
   * silently doing nothing, so a bad paste has a visible, safe result.
   * Never the dashboard -- see BLANK_URL's own comment for why. */
  private resolveTarget (rawInput: string): string {
    const result = parseOmniboxInput(rawInput, isDevEthName)
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

  /** The active tab's own webContents -- the site-info popup's Cookies and
   * site data page (`../permissions/site-data-runner.js`) reads live page
   * storage through it. `undefined` on a fresh window with no tab yet, or
   * once the active tab's webContents has been destroyed -- both cases
   * this popup's caller already treats as "nothing to show". */
  activeWebContents (): Electron.WebContents | undefined {
    return this.activeId === null ? undefined : this.liveWebContents(this.activeId)
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
