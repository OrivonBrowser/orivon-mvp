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
import type { LoadURLOptions, WebContentsView, View } from 'electron'
import { join } from 'node:path'
import { captureFaviconInto } from '../browsing/favicon.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { SubsystemContext } from '../registry.js'
import { TabFactory } from './tab-factory.js'
import { clearOfPairs, moveInOrder } from './tab-order.js'
import { SplitController } from './split-controller.js'
import { MAX_TABS } from './tab-view.js'
import { closeParkedViews } from './tab-parking.js'
import { buildTabState } from './tab-state.js'
import type { TabStateEnv } from './tab-state.js'
import { exitHtmlFullscreen, goBack, goForward, navigateTab, reloadTab } from './tab-navigation.js'
import type { NavigationEnv } from './tab-navigation.js'
import { TabOpener } from './tab-open.js'
import { TabPanes } from './tab-panes.js'

export type { TabState, TabsSnapshot, ShellState, Bounds } from './tab-types.js'
import type { TabState, TabsSnapshot, Bounds, TabRecord, TabShell, TabViewHost } from './tab-types.js'

export class TabManager {
  /** One record per tab: a second, parallel map is the leak class this avoids. */
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
  private readonly panes: TabPanes
  private readonly opener: TabOpener
  private readonly navigation: NavigationEnv
  private readonly stateEnv: TabStateEnv
  /** The tabs shown two at a time. Public: split commands and the tab menu work it directly. */
  readonly splits: SplitController

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
      detachView: (view) => { this.panes.hide(this.panes.idOfView(view)) },
      attachView: (id, view) => { this.panes.swap(id, view) },
      paneClicked: (id) => { this.panes.clicked(id) },
      openInSplit: (id, url) => { if (!this.atCapacity()) this.splits.split(id, this.createTab(url), 'right') },
      emitState: () => { this.changed() },
      // Which document declared the icon, and whether this record is still the one the map holds when the fetch lands.
      captureFavicon: async (id, record, favicons) => {
        await captureFaviconInto(record, favicons, () => record.view.webContents.getURL(), () => this.tabs.get(id) === record, () => { this.changed() })
      },
      forgetTab: (id) => { this.forgetTab(id, false) },
      openTab: (url, active, loadOptions) => this.liveWebContents(this.createTab(url, active, loadOptions)),
      adoptPopup: (view, partition, active) => { this.opener.adoptPopup(view, partition, active) },
      openBlobTab: (url, partition, active, loadOptions) => this.liveWebContents(this.opener.openBlobTab(url, partition, active, loadOptions)),
      openWindow: (url, loadOptions) => shell?.openWindow?.(url, loadOptions),
      atCapacity: () => this.atCapacity(),
      htmlFullscreenChanged: (id, entered) => { shell?.htmlFullscreenChanged(id, entered) },
      isClosing: () => this.disposed,
      devtools: shell?.devtools
    }
    this.opener = new TabOpener({
      add: (id, record) => { this.add(id, record) },
      activate: (id) => { this.activateTab(id) },
      changed: () => { this.changed() },
      atCapacity: () => this.atCapacity(),
      activeId: () => this.activeId,
      records: () => this.tabs
    }, new TabFactory(this.viewHost, () => ctx.broker, dashboardUrl, shell?.internalPages))
    this.splits = new SplitController({
      order: this.order,
      activate: (id) => { this.activateTab(id) },
      focus: (id) => { this.liveWebContents(id)?.focus() },
      changed: () => { this.panes.sync(); this.changed() },
      openTab: () => this.atCapacity() ? undefined : this.createTab(),
      area: getTabBounds
    })
    this.panes = new TabPanes({
      contentView,
      splits: this.splits,
      record: (id) => this.tabs.get(id),
      records: () => this.tabs,
      activeId: () => this.activeId,
      setActiveId: (id) => { this.activeId = id },
      area: getTabBounds,
      isClosing: () => this.disposed,
      emitState: () => { this.changed() },
      shell
    })
    this.navigation = {
      record: (id) => this.tabs.get(id),
      liveWebContents: (id) => this.liveWebContents(id),
      openInternal: (page, path) => { this.openInternal(page, path) },
      broker: () => ctx.broker,
      searchUrl: shell?.searchUrl
    }
    this.stateEnv = { dashboardUrl, partnerOf: (id) => this.splits.groups.partnerOf(id) }
  }

  private add (id: string, record: TabRecord): void {
    this.tabs.set(id, record)
    this.order.push(id)
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
      tabs: this.order.map((id) => buildTabState(id, this.tabs.get(id), this.liveWebContents(id), this.stateEnv)),
      activeTabId: this.activeId
    }
  }

  /** A new tab: `active` and `loadOptions` are tab-open.ts's. */
  createTab (url?: string, active = true, loadOptions?: LoadURLOptions): string { return this.opener.createTab(url, active, loadOptions) }

  /** A same-origin blob: URL a no-guest popup open wants, in the opener's `partition`. */
  openBlobTab (url: string, partition: string | undefined, active = true, loadOptions?: LoadURLOptions): string { return this.opener.openBlobTab(url, partition, active, loadOptions) }

  /** createTab() for a trusted caller (the extension host), which has checked `target` itself. */
  openTrusted (target?: string): [string, Electron.WebContents] | undefined { return this.opener.openTrusted(target) }

  /** Shows one of the shell's own pages, in the tab that has it or a new one. */
  openInternal (page: InternalPageId, path = '/'): void { this.opener.openInternal(page, path) }

  private atCapacity (): boolean {
    return this.disposed || this.order.length >= MAX_TABS
  }

  /** Asks a tab's page to leave HTML fullscreen. */
  exitHtmlFullscreen (id: string): void { exitHtmlFullscreen(this.navigation, id) }

  closeTab (id: string): void {
    this.forgetTab(id, true)
  }

  /** Puts a tab at `index` in the strip. */
  moveTab (id: string, index: number): void {
    if (this.splits.move(id, index) || moveInOrder(this.order, id, index, this.splits.groups.pairs())) this.changed()
  }

  get tabCount (): number {
    return this.order.length
  }

  /** Whether another tab may be shown here: a tab given by another window is not refused half way. */
  hasRoom (): boolean {
    return !this.atCapacity()
  }

  /** Lets go of a tab without closing it, for another window to show -- the last tab leaves this window empty and NOT told so (`onEmpty` is for closing a tab): whoever moved it closes the window. */
  takeTab (id: string): TabRecord | null {
    if (this.disposed) return null
    const record = this.tabs.get(id)
    if (record === undefined) return null
    // Tools left open would inspect a page this window no longer shows.
    record.host.devtools?.closeFor(record.view.webContents)
    this.forgetTab(id, false, true)
    return record
  }

  /** Shows a tab another window let go of, at `index` (the end by default) -- its views' handlers read `record.host` when they run, so from here on they act for this window. */
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
    if (partner !== null) this.panes.sync()
    this.changed()
  }

  activateTab (id: string): void {
    const record = this.tabs.get(id)
    if (this.disposed || record === undefined || record.view.webContents.isDestroyed()) return

    this.activeId = id
    this.shell?.tabLifecycle?.tabActivated(record.view.webContents)
    this.panes.sync()
    this.changed()
  }

  /** Re-applies the views' bounds -- called on window resize. */
  layout (): void {
    this.panes.sync()
  }

  /** Where the omnibox and the dashboard's navigate command both land (tab-navigation.ts). */
  navigate (id: string, rawInput: string): void { navigateTab(this.navigation, id, rawInput) }

  back (id: string): void { goBack(this.navigation, id) }

  forward (id: string): void { goForward(this.navigation, id) }

  reload (id: string): void { reloadTab(this.navigation, id) }

  /** The icon this tab is currently showing, already fetched, size-capped
   * and re-encoded to a `data:` URL by favicon.ts. `null` when the page
   * declares none, or when its fetch has not landed yet. Read when a page
   * is starred, so the bookmark keeps the icon rather than the shell going
   * back to the network for one (bookmarks.ts's `favicon`). */
  faviconFor (id: string): string | null {
    return this.tabs.get(id)?.favicon ?? null
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

  /** A tab's record, for a feature that keeps per-tab state on it (tab-signals.ts). */
  record (id: string): TabRecord | undefined {
    return this.tabs.get(id)
  }

  /** Every tab's id, in the strip's order. */
  ids (): readonly string[] {
    return [...this.order]
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

  /** Pushes the state to every listener: for a feature whose per-tab state just changed. */
  changed (): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
