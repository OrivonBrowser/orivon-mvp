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
import type { LoadURLOptions, View, WebContents } from 'electron'
import { join } from 'node:path'
import { captureFaviconInto } from '../browsing/favicon.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { SubsystemContext } from '../registry.js'
import { TabFactory } from './tab-factory.js'
import { clampToRun, clearOfPairs, moveInOrder, pinnedCount } from './tab-order.js'
import { SplitController } from './split-controller.js'
import { MAX_TABS } from './tab-view.js'
import { closeParkedViews } from './tab-parking.js'
import { buildTabState } from './tab-state.js'
import type { TabStateEnv } from './tab-state.js'
import { openTypedViewSource } from '../page-tools/view-source.js'
import { gatewayRedirectFor } from './eth-gateway-rule.js'
import { exitHtmlFullscreen, goBack, goForward, navigateTab, reloadTab } from './tab-navigation.js'
import type { NavigationEnv } from './tab-navigation.js'
import { TabOpener } from './tab-open.js'
import { watchNewTab } from './new-tab-focus.js'
import { TabPanes } from './tab-panes.js'

export type { TabState, TabsSnapshot, ShellState, Bounds } from './tab-types.js'
import type { TabsSnapshot, Bounds, TabRecord, TabShell, TabViewHost } from './tab-types.js'

/** How long a page signal waits for others before the state is pushed: a few frames, so a load's burst is one push. */
const STATE_PUSH_DELAY_MS = 32

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
  /** The push a burst of page signals waits for: one per burst, however many tabs and signals made it. */
  private pendingPush: ReturnType<typeof setTimeout> | null = null
  /** The narrow surface tab-view.ts's per-view wiring calls back through. */
  private readonly viewHost: TabViewHost
  private readonly panes: TabPanes
  private readonly opener: TabOpener
  private readonly navigation: NavigationEnv
  private readonly stateEnv: TabStateEnv
  /** The tabs shown two at a time. Public: split commands and the tab menu work it directly. */
  readonly splits: SplitController
  /** Set by a feature that places tabs by something besides the strip's own rules (tab groups): called once a tab, or a joined pair, has been moved to a new place or has arrived from another window. */
  afterMove?: (id: string) => void
  /** Called when a page opened a tab (a link, a popup, "Open in new tab"); `opener` is the tab that was in front. */
  afterOpen?: (id: string, opener: string | null) => void
  /** Set by a feature that hides tabs in the strip (a collapsed group): the tab in front leaving puts the nearest one not hidden in front. */
  hidden?: (id: string) => boolean

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
      attachView: (id, view) => { this.panes.swap(id, view) },
      paneCommitted: (id) => { this.panes.recheck(id) },
      paneClicked: (id) => { this.panes.clicked(id) },
      openInSplit: (id, url) => { if (!this.atCapacity()) this.splits.split(id, this.createTab(url), 'right') },
      reload: (id) => { this.reload(id) },
      back: (id) => { this.back(id) },
      forward: (id) => { this.forward(id) },
      emitState: () => { this.changedSoon() },
      // Which document declared the icon, and whether this record is still the one the map holds when the fetch lands.
      captureFavicon: async (id, record, favicons) => {
        await captureFaviconInto(record, favicons, () => record.view.webContents.getURL(), () => this.tabs.get(id) === record, () => { this.changed() }, record.view.webContents.session)
      },
      forgetTab: (id) => { this.forgetTab(id, false) },
      openTab: (url, active, loadOptions) => this.liveWebContents(this.openedByPage(() => this.createTab(url, active, loadOptions))),
      adoptPopup: (view, partition, active) => {
        const before = this.order.length
        const opener = this.activeId
        this.opener.adoptPopup(view, partition, active)
        const id = this.order.at(-1)
        if (id !== undefined && this.order.length > before) this.afterOpen?.(id, opener)
      },
      openBlobTab: (url, partition, active, loadOptions) => this.liveWebContents(this.openedByPage(() => this.opener.openBlobTab(url, partition, active, loadOptions))),
      openLocalFile: async (url, active) => {
        const opener = this.activeId
        const id = await this.opener.openLocalFile(url, active)
        if (id === undefined) return undefined
        this.afterOpen?.(id, opener)
        return this.liveWebContents(id)
      },
      openWindow: (url, loadOptions) => shell?.openWindow?.(url, loadOptions),
      atCapacity: () => this.atCapacity(),
      htmlFullscreenChanged: (id, entered) => { shell?.htmlFullscreenChanged(id, entered) },
      isClosing: () => this.disposed,
      devtools: shell?.devtools,
      services: shell?.services,
      runCommand: (id) => { shell?.runCommand?.(id) }
    }
    this.opener = new TabOpener({
      add: (id, record) => { this.add(id, record) },
      activate: (id) => { this.activateTab(id) },
      changed: () => { this.changed() },
      atCapacity: () => this.atCapacity(),
      localFilesRefused: () => { shell?.localFilesRefused?.() },
      activeId: () => this.activeId,
      records: () => this.tabs,
      freshTabInFront: (id, contents) => { this.watchFreshTab(id, contents) }
    }, new TabFactory(this.viewHost, () => ctx.broker, dashboardUrl, shell?.internalPages))
    this.splits = new SplitController({
      order: this.order,
      activate: (id) => { this.activateTab(id) },
      focus: (id) => { this.liveWebContents(id)?.focus() },
      changed: () => { this.panes.sync(); this.changed() },
      openTab: () => this.atCapacity() ? undefined : this.createTab(),
      area: getTabBounds,
      isPinned: (id) => this.isPinned(id)
    })
    this.panes = new TabPanes({
      contentView,
      splits: this.splits,
      record: (id) => this.tabs.get(id),
      records: () => this.tabs,
      activeId: () => this.activeId,
      // A press in the other pane brings that tab in front as a click on it in the strip does: what waits for its tab
      // (a question, the find bar, a crashed page's card) shows, and what counts the tab in front hears of it.
      setActiveId: (id) => {
        this.activeId = id
        const contents = this.tabs.get(id)?.view.webContents
        if (contents !== undefined && !contents.isDestroyed()) this.shell?.tabLifecycle?.tabActivated(contents)
      },
      area: getTabBounds,
      isClosing: () => this.disposed,
      emitState: () => { this.changed() },
      shell
    })
    this.navigation = {
      record: (id) => this.tabs.get(id),
      liveWebContents: (id) => this.liveWebContents(id),
      openInternal: (page, path) => { this.openInternal(page, path) },
      viewSource: (url) => openTypedViewSource(this, url),
      searchUrl: shell?.searchUrl,
      gatewayTarget: (url) => gatewayRedirectFor(shell?.services?.settings, url)
    }
    this.stateEnv = { dashboardUrl, partnerOf: (id) => this.splits.groups.partnerOf(id) }
  }

  private add (id: string, record: TabRecord): void {
    this.tabs.set(id, record)
    this.order.push(id)
  }

  /** Returns the removal. */
  onStateChange (cb: (state: TabsSnapshot) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
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
    this.cancelPendingPush()
    this.listeners.clear()
    for (const id of [...this.tabs.keys()]) this.forgetTab(id, true)
    this.panes.dispose()
  }

  /** True from the moment the window starts closing: no tab may be opened or driven on this manager any more. */
  isDisposed (): boolean { return this.disposed }

  /** Where the keyboard goes for a tab opened on the start page (./new-tab-focus.ts). Only a shell that can run a command has a bar to give it to. */
  private watchFreshTab (id: string, contents: WebContents): void {
    const shell = this.shell
    if (shell?.runCommand === undefined) return
    watchNewTab(contents, {
      input: () => ({
        active: this.activeId === id,
        // Still the start page: the flag is cleared by the tab's first navigation, and `isNewTab` would read false before it loads.
        freshNewTab: this.tabs.get(id)?.isDashboardTab === true,
        windowFocused: !shell.window.isDestroyed() && shell.window.isFocused(),
        coveredByIntro: shell.coveredByIntro?.() === true
      }),
      focusAddressBar: () => { shell.runCommand?.('nav.focusAddress') },
      returnKeyboard: () => { shell.focusChrome?.() }
    })
  }

  getState (): TabsSnapshot {
    return {
      tabs: this.order.map((id) => buildTabState(id, this.tabs.get(id), this.liveWebContents(id), this.stateEnv)),
      activeTabId: this.activeId
    }
  }

  /** A new tab: `active` and `loadOptions` are tab-open.ts's. */
  createTab (url?: string, active = true, loadOptions?: LoadURLOptions): string { return this.opener.createTab(url, active, loadOptions) }

  /** A local file in a new tab of the local-files session; undefined for anything `localFileKey` refuses. */
  openLocalFile (url: string, active = true): Promise<string | undefined> { return this.opener.openLocalFile(url, active) }

  /** `openLocalFile` for a caller that needs the id at once; undefined while the first open has not read the binary's fuse. */
  openLocalFileNow (url: string, active = true): string | undefined { return this.opener.openLocalFileNow(url, active) }

  /** A same-origin blob: URL a no-guest popup open wants, in the opener's `partition`. */
  openBlobTab (url: string, partition: string | undefined, active = true, loadOptions?: LoadURLOptions): string { return this.opener.openBlobTab(url, partition, active, loadOptions) }

  /** createTab() for a trusted caller (the extension host), which has checked `target` itself. */
  openTrusted (target?: string): [string, Electron.WebContents] | undefined { return this.opener.openTrusted(target) }

  /** Shows one of the shell's own pages, in the tab that has it or a new one. */
  openInternal (page: InternalPageId, path = '/'): void { this.opener.openInternal(page, path) }

  /** Runs a way of opening a tab a page asked for, and tells `afterOpen` which tab was in front when it did. */
  private openedByPage (open: () => string): string {
    const opener = this.activeId
    const id = open()
    this.afterOpen?.(id, opener)
    return id
  }

  private atCapacity (): boolean {
    return this.disposed || this.order.length >= MAX_TABS
  }

  /** Asks a tab's page to leave HTML fullscreen. */
  exitHtmlFullscreen (id: string): void { exitHtmlFullscreen(this.navigation, id) }

  closeTab (id: string): void {
    this.forgetTab(id, true)
  }

  /** Puts a tab at `index` in the strip, kept within the pinned run or outside it, as the tab is pinned or not. */
  moveTab (id: string, index: number): void {
    if (this.splits.move(id, index) || moveInOrder(this.order, id, index, this.splits.groups.pairs(), (other) => this.isPinned(other))) {
      this.afterMove?.(id)
      this.changed()
    }
  }

  private isPinned (id: string): boolean {
    return this.tabs.get(id)?.pinned === true
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

  /** Shows a tab another window let go of, at `index` (the end by default) -- its views' handlers read `record.host` when they run, so from here on they act for this window.
   * `activate` false leaves it behind the tab in front, asleep if it was, for a caller handing over several. */
  giveTab (id: string, record: TabRecord, index?: number, activate = true): void {
    if (this.disposed) return
    record.host = this.viewHost
    this.tabs.set(id, record)
    const wanted = clampToRun(Math.min(Math.max(0, index ?? this.order.length), this.order.length), record.pinned === true, pinnedCount(this.order, (other) => this.isPinned(other)), this.order.length)
    this.order.splice(clearOfPairs(this.order, wanted, this.splits.groups.pairs(), -1), 0, id)
    this.afterMove?.(id)
    // takeTab()'s forgetTab() already said this tab closed; this says it is back.
    this.shell?.tabLifecycle?.tabCreated(record.view.webContents, this.viewHost.window)
    if (activate) this.activateTab(id)
    else this.changed()
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
    const reason = this.disposed ? 'window-closing' : handedOn ? 'moved' : closeView ? 'closed' : 'gone'
    this.shell?.tabLifecycle?.tabClosing({ id, index: this.order.indexOf(id), record, reason, window: this.viewHost.window })
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
      const fallback = this.fallbackFor(idx)
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

  /** The tab to put in front once the one at `at` has left: its left neighbour, or the nearest one not hidden, left first. */
  private fallbackFor (at: number): string | undefined {
    const near = this.order[Math.max(0, at - 1)]
    const hidden = this.hidden
    if (hidden === undefined || near === undefined || !hidden(near)) return near
    for (let distance = 1; distance <= this.order.length; distance += 1) {
      const left = this.order[at - distance]
      if (left !== undefined && !hidden(left)) return left
      const right = this.order[at + distance - 1]
      if (right !== undefined && !hidden(right)) return right
    }
    return near
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
   * and re-encoded to a `data:` URL by favicon-fetch.ts. `null` when the page
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
    // A page's own event can land while it is being torn down, when the view no longer has a webContents at all.
    const wc: Electron.WebContents | undefined = this.tabs.get(id)?.view.webContents
    return wc === undefined || wc.isDestroyed() ? undefined : wc
  }

  /** The pane of the tab in front: the whole tab area unless the window is split. */
  activePaneBounds (): Bounds {
    return this.activeId === null ? this.panes.bounds('') : this.panes.bounds(this.activeId)
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
    // The push below carries everything a waiting one would.
    this.cancelPendingPush()
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  /** A page signal (a title, a loading flag, an address inside the page, an icon) pushes the state once its burst is over:
   * a page load raises several in every tab, and each push rebuilds all tabs' state and sends it to the toolbar. */
  private changedSoon (): void {
    if (this.disposed || this.pendingPush !== null) return
    this.pendingPush = setTimeout(() => {
      this.pendingPush = null
      if (!this.disposed) this.changed()
    }, STATE_PUSH_DELAY_MS)
  }

  private cancelPendingPush (): void {
    if (this.pendingPush === null) return
    clearTimeout(this.pendingPush)
    this.pendingPush = null
  }
}
