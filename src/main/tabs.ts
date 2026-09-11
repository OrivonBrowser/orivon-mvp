// Owns every tab's WebContentsView and the state pushed to the chrome UI.
//
// Main holds truth (build-plan.md's shell architecture, this session's plan):
// the chrome view sends commands (newTab, navigate, back, ...) and receives a
// full ShellState snapshot after every change. It never derives tab state
// itself.
//
// T18 (security-model.md): every tab WebContents gets setWindowOpenHandler
// wired to open a new tab rather than a popup. A redirect, clicked link, form
// submission or script navigation that changes a tab's origin is caught by
// wireView()'s own did-navigate handler, which repartitions the same way a
// typed cross-origin navigation already does (see repartitionView()'s own
// doc comment for the residual this catches late, not early).
import type { WebContentsView, View } from 'electron'
import { join } from 'node:path'
import { fetchFaviconDataUrlCached, pickFaviconUrl, shouldClearFavicon } from './favicon.js'
import { parseOmniboxInput, sanitizeDirectUrl } from './omnibox.js'
import type { SubsystemContext } from './registry.js'
import { appTabArgsFor, makeTabView, partitionChanged, partitionForTarget } from './tab-view.js'

export type { TabState, TabsSnapshot, ShellState, Bounds } from './tab-types.js'
import type { TabState, TabsSnapshot, Bounds } from './tab-types.js'

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
  /** Mutable, not readonly: repartitionView() (see navigate()) replaces
   * this with a fresh WebContentsView whenever a navigation changes the
   * tab's origin -- Electron fixes a partition at construction, so
   * changing it is only possible by swapping the whole view. */
  view: WebContentsView
  favicon: string | null
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
    private readonly dashboardUrl: string,
    /**
     * `ctx.broker` is read by every `makeTabView` call site now
     * (`appTabArgsFor`, ADR-0017) to decide the fetch()-routing flag --
     * still `Broker | undefined`, so a run where the broker subsystem is
     * absent simply never sets the flag, same fallback shape
     * `partitionForTarget` already has. `ctx.loader` remains unused: it is
     * what the not-yet-built discovery-trigger hint listener needs to
     * install an app the moment a tab's own page shows the
     * `<link rel="orivon-manifest">` hint (A60/A61, `docs/open-
     * questions.md`) -- threaded through on its own, deliberately separate
     * from that behavior, per `docs/development/parallel-work.md`'s
     * append-only-first discipline. `ctx.loader` may be `undefined`
     * (`loaderSubsystem` is not `critical`, unlike the broker) -- whoever
     * reads it later must treat an absent loader as "the discovery trigger
     * is disabled this run", never assume it is always present.
     */
    private readonly ctx: SubsystemContext
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

    // Excluded even though the dashboard's own URL is occasionally a real
    // http(s) address (electron-vite's dev server) -- `partitionForTarget`
    // cannot tell that apart from a real app on scheme alone, but the
    // dashboard is shell UI (ADR-0003's "browser state" tier), never app
    // content, and must never be isolated as if it were an app's own origin.
    const partition = isDashboard ? undefined : partitionForTarget(target)

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
      isDashboardTab: isDashboard
    }
    this.wireView(id, record)

    this.tabs.set(id, record)
    this.order.push(id)

    void view.webContents.loadURL(target)

    this.activateTab(id)
    return id
  }

  /** Every event a tab's WebContentsView needs wired -- shared by
   * createTab() and repartitionView() (Rule 3): a swapped-in replacement
   * view gets EXACTLY the same favicon/title/loading/crash handling and
   * the same popup-to-new-tab redirect (T18) as a freshly created one,
   * because as far as anything downstream (the chrome UI, a popup) can
   * tell, it IS one. */
  private wireView (id: string, record: TabRecord): void {
    const wc = record.view.webContents
    wc.on('page-title-updated', () => this.emitState())
    wc.on('did-navigate', (_event, navigatedUrl: string) => {
      if (shouldClearFavicon(record.faviconOrigin, navigatedUrl)) {
        record.favicon = null
        record.faviconOrigin = null
      }
      // Never for the dashboard: its own dev-mode URL is a real http(s)
      // address (partitionChanged would otherwise see a "changed" origin on
      // the dashboard's OWN first load, since its current partition is
      // undefined) -- see createTab()'s isDashboard branch and this file's
      // README-linked design notes for why that tab must stay unpartitioned.
      if (!record.isDashboardTab) {
        const nextPartition = partitionChanged(navigatedUrl, record.partition)
        if (nextPartition !== undefined) {
          this.repartitionView(id, record, navigatedUrl, nextPartition)
          return
        }
      }
      this.emitState()
    })
    wc.on('did-navigate-in-page', () => this.emitState())
    wc.on('did-start-loading', () => this.emitState())
    wc.on('did-stop-loading', () => this.emitState())
    wc.on('page-favicon-updated', (_event, favicons: string[]) => {
      // captureFavicon calls fetchFaviconDataUrl (favicon.ts), whose doc
      // comment promises it never throws -- but a bare `void` here would
      // still turn any future break of that promise into an unhandled
      // rejection, and index.ts deliberately maps that to app.exit(1), so
      // a favicon host controlled by any visited page could kill the whole
      // browser. Same defence as update-check-runner.ts's afterReady and
      // bookmarks.ts's pendingWrite.
      void this.captureFavicon(id, record, favicons).catch((error) => {
        console.error('[orivon] favicon capture failed:', error)
      })
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
    // gone from `this.tabs`. repartitionView() strips this exact listener
    // from the OLD view before closing it, specifically so this handler
    // only ever fires for a tab that is GENUINELY gone.
    wc.on('destroyed', () => { this.forgetTab(id, false) })

    // T18: never let a tab open a real popup window -- route it to a new
    // tab in this same shell instead.
    wc.setWindowOpenHandler((details) => {
      this.createTab(details.url)
      return { action: 'deny' }
    })
  }

  /** Swaps in a fresh WebContentsView for `record`, replacing whatever it
   * currently shows -- the ONLY way to change a tab's Electron session
   * partition after creation (Electron fixes `webPreferences.partition` at
   * construction; there is no live "reassign session" API). Called from two
   * places, both guarded by `partitionChanged` so neither fires for a same-
   * origin navigation, a rejected/about:blank fallback or the dashboard:
   * navigate() (a typed target, pre-fetch) and wireView()'s did-navigate
   * handler (a redirect, clicked link, form submission or script navigation
   * -- the target is only known once Chromium has already committed it).
   * See this directory's README.md, `## Design notes`, for the residual
   * that late catch leaves open and the KNOWN, DISCLOSED LIMITATION this
   * swap has always had on `back()`. */
  private repartitionView (id: string, record: TabRecord, target: string, nextPartition: string): void {
    const oldView = record.view
    const wasActive = this.activeId === id

    if (wasActive) this.contentView.removeChildView(oldView)

    // This tab is not closing -- only its content is being replaced -- so
    // the OLD view's own 'destroyed' listener (wired by wireView() above)
    // must not reach forgetTab() when close() tears it down. Stripped
    // BEFORE close(), not after: real Electron destruction, like this
    // file's own test double, can fire it synchronously.
    oldView.webContents.removeAllListeners('destroyed')
    if (!oldView.webContents.isDestroyed()) oldView.webContents.close()

    const newView = makeTabView(this.preloadPath, nextPartition, appTabArgsFor(target, this.ctx.broker))
    record.view = newView
    record.partition = nextPartition
    record.isDashboardTab = false
    this.wireView(id, record)

    if (wasActive) {
      this.contentView.addChildView(newView)
      newView.setBounds(this.getTabBounds())
    }

    void newView.webContents.loadURL(target)
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

  /** THE PRIMARY WAY A TAB EVER REACHES A REAL ORIGIN: the omnibox and the
   * dashboard's own navigate command both funnel here (ipc.ts, newtab-
   * ipc.ts) -- a person's very first act in a fresh tab is typing a URL,
   * not calling createTab(url) directly. Repartitions via repartitionView()
   * exactly when the target's origin differs from the tab's CURRENT
   * partition; `partitionForTarget(BLANK_URL)` is always undefined, so a
   * rejected navigation never swaps and keeps landing in whatever
   * view/partition the tab already had (BLANK_URL's own doc: "an EXISTING
   * tab keeps whatever preload it was created with"), and a same-origin
   * navigation computes the identical partition string and also does not
   * swap. */
  navigate (id: string, rawInput: string): void {
    const record = this.tabs.get(id)
    if (record === undefined || record.view.webContents.isDestroyed()) return
    const target = this.resolveTarget(rawInput)

    const nextPartition = partitionChanged(target, record.partition)
    if (nextPartition !== undefined) {
      this.repartitionView(id, record, target, nextPartition)
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
