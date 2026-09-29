// Owns every tab's WebContentsView and the state pushed to the chrome UI.
//
// Main holds truth (build-plan.md's shell architecture, this session's plan):
// the chrome view sends commands (newTab, navigate, back, ...) and receives a
// full ShellState snapshot after every change. It never derives tab state
// itself.
//
// T18 (security-model.md): every tab WebContents gets setWindowOpenHandler
// wired so a popup becomes a tab, never an OS window. A redirect, clicked
// link, form or script navigation that changes a tab's origin is caught by
// wireView()'s did-navigate handler, which repartitions the same way a typed
// cross-origin navigation does (repartitionView()'s own doc: the residual).
import type { WebContentsView, View } from 'electron'
import { join } from 'node:path'
import { captureFaviconInto } from '../browsing/favicon.js'
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { internalUrl, parseInternalUrl } from '../pages/internal-pages.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { SubsystemContext } from '../registry.js'
import { BLANK_URL, TabFactory } from './tab-factory.js'
import { clearOfPairs, moveInOrder } from './tab-order.js'
import { PaneHost } from './pane-host.js'
import { SplitController } from './split-controller.js'
import { appTabFlagChanged, EXIT_FULLSCREEN_WORLD_ID, MAX_TABS, partitionChanged } from './tab-view.js'
import { closeParkedViews, repartitionView } from './tab-parking.js'

export type { TabState, TabsSnapshot, ShellState, Bounds } from './tab-types.js'
import type { TabState, TabsSnapshot, Bounds, TabRecord, TabShell, TabViewHost } from './tab-types.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

export class TabManager {
  /** One record per tab, so favicon state and the view share one lifetime:
   * a second, parallel map is the leak class this avoids. */
  private readonly tabs = new Map<string, TabRecord>()
  /** Tab strip order, kept apart from the Map's insertion order. */
  private readonly order: string[] = []
  private activeId: string | null = null
  /** Set once the window is closing: from then on no tab is activated, laid
   * out or reported, because each of those asks the window for its bounds and
   * a destroyed window throws. Teardown destroys the window first and its
   * views' webContents after, so the views' `destroyed` events arrive here
   * with the window already gone. */
  private disposed = false
  private readonly listeners = new Set<(state: TabsSnapshot) => void>()
  /** The narrow surface tab-view.ts's per-view wiring calls back through. */
  private readonly viewHost: TabViewHost
  private readonly factory: TabFactory
  private readonly panes: PaneHost
  /** The tabs shown two at a time. Public: split commands and the tab menu work it directly. */
  readonly splits: SplitController
  private readonly backdrop: TabShell['backdrop']
  private readonly searchUrl: ((query: string) => string) | undefined

  constructor (
    contentView: View,
    private readonly getTabBounds: () => Bounds,
    /** Called when the last tab closes (A16): window.ts closes the window or
     * opens a new tab, as the person set. TabManager never quits the app --
     * index.ts's `window-all-closed` owns whether the process exits. */
    private readonly onEmpty: () => void,
    /** The dashboard's resolved URL (dev server or built file): a fresh tab
     * (createTab() with no `url`) loads this, with the dashboard's own
     * preload. A rejected navigation never reaches it -- see BLANK_URL. */
    private readonly dashboardUrl: string,
    /** `ctx.broker` may be `undefined`; `ctx.loader` is deliberately unused
     * so far -- do not remove either. README.md's design notes say why. */
    private readonly ctx: SubsystemContext,
    /** Absent only in tests: no dialog, no menu, no fullscreen, no lifecycle seam. */
    private readonly shell?: TabShell
  ) {
    this.viewHost = {
      preloadPath: join(import.meta.dirname, '../preload/app.js'),
      // A GETTER, not a captured value: ctx.broker may still be undefined
      // when TabManager is constructed and be published afterwards. Reading
      // it once here would pin 'no broker' for the process lifetime.
      get broker () { return ctx.broker },
      dashboardUrl,
      window: shell?.window,
      tabLifecycle: shell?.tabLifecycle,
      isShown: (id) => this.panes.isShown(id),
      detachView: (view) => { this.panes.hide(this.idOfView(view)) },
      attachView: (id, view) => { this.panes.replace(id, view, this.paneBounds(id)) },
      paneClicked: (id) => { this.paneClicked(id) },
      openInSplit: (id, url) => { if (!this.atCapacity()) this.splits.split(id, this.createTab(url), 'right') },
      emitState: () => { this.emitState() },
      captureFavicon: async (id, record, favicons) => { await this.captureFavicon(id, record, favicons) },
      forgetTab: (id) => { this.forgetTab(id, false) },
      openTab: (url, active) => { this.createTab(url, active) },
      adoptPopup: (view, partition, active) => { this.adoptPopup(view, partition, active) },
      openWindow: (url) => shell?.openWindow?.(url),
      atCapacity: () => this.atCapacity(),
      htmlFullscreenChanged: (id, entered) => { shell?.htmlFullscreenChanged(id, entered) },
      isClosing: () => this.disposed,
      devtools: shell?.devtools
    }
    this.searchUrl = shell?.searchUrl
    this.factory = new TabFactory(this.viewHost, () => ctx.broker, dashboardUrl, shell?.internalPages)
    this.panes = new PaneHost(contentView)
    this.backdrop = shell?.backdrop
    this.splits = new SplitController({
      order: this.order,
      activate: (id) => { this.activateTab(id) },
      focus: (id) => { this.liveWebContents(id)?.focus() },
      changed: () => { this.syncViews(); this.emitState() },
      openTab: () => this.atCapacity() ? undefined : this.createTab(),
      area: getTabBounds
    })
  }

  private add (id: string, record: TabRecord): void {
    this.tabs.set(id, record)
    this.order.push(id)
  }

  /** The tab holding the whole window: `HtmlFullscreen`'s answer (../fullscreen.ts), the one
   * place that state lives, and only while that tab is still the one in front. */
  private get fullscreenId (): string | null {
    const id = this.shell?.fullscreenTabId?.() ?? null
    return id === this.activeId ? id : null
  }

  onStateChange (cb: (state: TabsSnapshot) => void): void {
    this.listeners.add(cb)
  }

  /** The window is closing: closes every tab's views and stops reacting, so
   * the `destroyed` events that follow find no fallback tab to activate, no
   * bounds to ask for, no state to push and no `onEmpty` to fire.
   *
   * Routed through forgetTab(), not inlined: `this.disposed` is already true
   * by the time each call runs, so every one exits right after the lifecycle
   * seam's tabClosed and the actual close -- but tabClosed fires HERE, on a
   * still-live webContents, never from the 'destroyed' event this close()
   * triggers asynchronously later, by which point reading it (extension-
   * host.ts's own `.session` check) throws. */
  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    for (const id of [...this.tabs.keys()]) this.forgetTab(id, true)
  }

  getState (): TabsSnapshot {
    return {
      tabs: this.order.map((id) => this.tabState(id)),
      activeTabId: this.activeId
    }
  }

  /** `active` false leaves the new tab's view detached, behind the current
   * tab, until a later `activateTab` -- popups.ts's `windowOpenHandler` on a
   * middle click or a plain ctrl+click. */
  createTab (url?: string, active = true): string {
    if (this.atCapacity()) {
      // Refuse rather than crash -- see MAX_TABS above. A caller that uses
      // the id (a split's partner) checks atCapacity() first.
      return this.activeId ?? ''
    }

    const { id, record, target } = this.factory.content(url)
    this.add(id, record)
    // Attached before it navigates: a detached view's first paint has
    // nowhere live to land (pane-host.ts's own fix is the other half).
    if (active) this.activateTab(id)
    else this.emitState()
    void record.view.webContents.loadURL(target)
    return id
  }

  /** createTab() for a trusted caller (the extension host): skips the sanitizeDirectUrl gate that refuses chrome-extension: outright, since its own policy already checked `target`. */
  openTrusted (target?: string): [string, Electron.WebContents] | undefined {
    if (this.atCapacity()) return undefined
    const built = target === undefined ? this.factory.content() : this.factory.trusted(target)
    this.add(built.id, built.record)
    void built.record.view.webContents.loadURL(built.target)
    this.activateTab(built.id)
    return [built.id, built.record.view.webContents]
  }

  /** Shows one of the shell's own pages: the tab that already has it, or a new
   * one. A page has one tab per window, so a second request finds the first
   * (and takes it to `path` if it is elsewhere). Only the shell calls this: a
   * website's `window.open` reaches `createTab`, which refuses an `orivon:`
   * URL. Its view stays on its page (./pages/internal-tab.ts). */
  openInternal (page: InternalPageId, path = '/'): void {
    const url = internalUrl(page, path)
    for (const [id, record] of this.tabs) {
      if (record.internalPage !== page) continue
      this.activateTab(id)
      if (!record.view.webContents.isDestroyed() && record.view.webContents.getURL() !== url) void record.view.webContents.loadURL(url)
      return
    }
    if (this.atCapacity()) return

    const { id, record } = this.factory.internal(page)
    this.add(id, record)
    void record.view.webContents.loadURL(url)
    this.activateTab(id)
  }

  private atCapacity (): boolean {
    return this.disposed || this.order.length >= MAX_TABS
  }

  /** A popup Chromium already created, with its opener, in the opener's session (./popups.ts).
   * It navigates itself; nothing is loaded here. `active` -- see `createTab`'s own doc. */
  private adoptPopup (view: WebContentsView, partition: string | undefined, active = true): void {
    const { id, record } = this.factory.popup(view, partition)
    this.add(id, record)
    if (active) this.activateTab(id)
    else this.emitState()
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

  /** Puts a tab at `index` in the strip. */
  moveTab (id: string, index: number): void {
    if (this.splits.move(id, index) || moveInOrder(this.order, id, index, this.splits.groups.pairs())) this.emitState()
  }

  get tabCount (): number {
    return this.order.length
  }

  /** Whether another tab may be shown here: a tab given by another window is not refused half way. */
  hasRoom (): boolean {
    return !this.atCapacity()
  }

  /** Lets go of a tab without closing it, so another window can show it. When this was the last tab the
   * window is left empty and NOT told so (`onEmpty` is for closing a tab): whoever moved it closes the window. */
  takeTab (id: string): TabRecord | null {
    if (this.disposed) return null
    const record = this.tabs.get(id)
    if (record === undefined) return null
    // Tools left open would inspect a page this window no longer shows.
    record.host.devtools?.closeFor(record.view.webContents)
    this.forgetTab(id, false, true)
    return record
  }

  /** Shows a tab another window let go of, at `index` (the end by default). Its views' handlers read `record.host`
   * when they run, so from here on they act for this window. */
  giveTab (id: string, record: TabRecord, index?: number): void {
    if (this.disposed) return
    record.host = this.viewHost
    this.tabs.set(id, record)
    const wanted = Math.min(Math.max(0, index ?? this.order.length), this.order.length)
    this.order.splice(clearOfPairs(this.order, wanted, this.splits.groups.pairs(), -1), 0, id)
    // takeTab()'s forgetTab() already said this tab closed; this says it is back.
    this.shell?.tabLifecycle?.tabCreated(record.view.webContents, this.viewHost.window)
    this.activateTab(id)
  }

  /** Shared by closeTab() (user- or app-initiated), the webContents
   * 'destroyed' handler (unexpected teardown, e.g. a crash) and takeTab().
   * `closeView` is false for the crash path: the webContents is already gone,
   * and calling further methods on a destroyed object throws. `handedOn` is
   * a tab going to another window alive: its parked views go with it, and
   * an empty strip is not reported. */
  private forgetTab (id: string, closeView: boolean, handedOn = false): void {
    const record = this.tabs.get(id)
    if (record === undefined) return
    // Every reason a tab leaves (closed, crashed, handed on) is "gone" alike.
    this.shell?.tabLifecycle?.tabClosed(record.view.webContents)

    const partner = this.splits.groups.partnerOf(id)
    if (!this.disposed) this.panes.hide(id)
    this.splits.groups.separate(id)
    // Out of the books before the view closes: closing announces its own end
    // at once, and that second call must find nothing left to do.
    this.tabs.delete(id)
    const idx = this.order.indexOf(id)
    if (idx !== -1) this.order.splice(idx, 1)
    record.host.devtools?.closeFor(record.view.webContents)
    if (closeView && !record.view.webContents.isDestroyed()) {
      record.view.webContents.close()
    }
    // On the crash path too: a parked view is alive whatever became of the
    // one the tab showed.
    if (!handedOn) closeParkedViews(record)

    if (this.disposed) return

    if (this.activeId === id) {
      const fallback = this.order[Math.max(0, idx - 1)]
      this.activeId = null
      if (fallback !== undefined) {
        this.activateTab(fallback)
        return
      }
    }

    // The last tab closing leaves nothing to show. The record is already
    // gone, so a second forgetTab() for it returns at the top: `onEmpty`
    // cannot fire twice the way a check in window.ts's pushState would.
    if (this.order.length === 0) {
      if (!handedOn) this.onEmpty()
      return
    }
    // The tab beside it now has the whole area.
    if (partner !== null) this.syncViews()
    this.emitState()
  }

  activateTab (id: string): void {
    const record = this.tabs.get(id)
    if (this.disposed || record === undefined || record.view.webContents.isDestroyed()) return

    this.activeId = id
    this.shell?.tabLifecycle?.tabActivated(record.view.webContents)
    this.syncViews()
    this.emitState()
  }

  /** Puts the views on screen as the plan says: the tab in front, or the two panes of a split, sized. */
  private syncViews (): void {
    if (this.disposed) return
    const plan = this.splits.plan(this.activeId, this.getTabBounds(), this.fullscreenId)
    const panes = plan.panes.flatMap(({ id, bounds }) => {
      const view = this.tabs.get(id)?.view
      return view === undefined || view.webContents.isDestroyed() ? [] : [{ id, view, bounds }]
    })
    if (plan.frame === null || this.backdrop === undefined) {
      this.panes.show(panes)
      return
    }
    this.panes.show(panes, { id: 'backdrop', view: this.backdrop.view, bounds: plan.frame.area })
    this.backdrop.update(plan.frame)
  }

  /** Where a tab's view goes now: its pane, or the whole area. */
  private paneBounds (id: string): Bounds {
    return this.splits.plan(this.activeId, this.getTabBounds(), this.fullscreenId).panes.find((pane) => pane.id === id)?.bounds ?? this.getTabBounds()
  }

  private idOfView (view: WebContentsView): string {
    for (const [id, record] of this.tabs) if (record.view === view) return id
    return ''
  }

  /** The person pressed in a page. Of two panes, that is the one they are in. */
  private paneClicked (id: string): void {
    if (id === this.activeId || this.splits.groups.partnerOf(id) !== this.activeId) return
    this.activeId = id
    this.syncViews()
    this.emitState()
  }

  /** Re-applies the views' bounds -- called on window resize. */
  layout (): void {
    this.syncViews()
  }

  /** Where the omnibox and the dashboard's navigate command both land (ipc.ts, newtab-ipc.ts). Repartitions
   * via repartitionView() when the target's session, or its app-tab flag, differs (appTabFlagChanged).
   * BLANK_URL has no origin, so a rejected navigation never swaps: the tab keeps its preload. */
  navigate (id: string, rawInput: string): void {
    const record = this.tabs.get(id)
    if (record === undefined || record.view.webContents.isDestroyed()) return
    // The address bar and the dashboard's search box are the person typing:
    // an address of one of the shell's own pages opens that page.
    const internal = parseInternalUrl(rawInput)
    if (internal !== null) {
      this.openInternal(internal.page, internal.path)
      return
    }
    const target = this.resolveTarget(rawInput)

    const swap = partitionChanged(target, record.partition)
    if (swap !== undefined || appTabFlagChanged(target, record.view, this.ctx.broker)) {
      // swap.to can itself be undefined (PartitionSwap's own doc) -- ??
      // would wrongly read that as "no swap" and keep the old partition.
      repartitionView(id, record, target, swap !== undefined ? swap.to : record.partition)
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
    const result = parseOmniboxInput(rawInput, isDevEthName, this.searchUrl)
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

  /** The session partition a tab's page runs in: an app's own, or undefined for the open web. */
  partitionOf (id: string): string | undefined {
    return this.tabs.get(id)?.partition
  }

  /** A tab's webContents, or undefined if the tab is gone or its webContents has already been destroyed --
   * the common guard every read-only accessor below needs, and what tear-drag.ts captures a thumbnail from
   * (via tab-view.ts's `captureTabPage`, which turns this into a snapshot or `null`, never a throw). */
  liveWebContents (id: string): Electron.WebContents | undefined {
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
      displayUrl: BUILTIN_ADDRESSES.displayUrl(url),
      title: wc?.getTitle() ?? '',
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false,
      favicon: record?.favicon ?? null,
      isNewTab: url === BLANK_URL || (record?.isDashboardTab === true && url === this.dashboardUrl),
      splitWith: this.splits.groups.partnerOf(id),
      isInternal: record?.internalPage != null
    }
  }

  private emitState (): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
