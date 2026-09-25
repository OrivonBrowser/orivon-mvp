// How one tab's WebContentsView is constructed and which Electron session
// partition it gets -- split out of tabs.ts (see that directory's README,
// `## Design notes`, for why). Pure with respect to TabManager: neither
// function here reads or writes any tab-collection state.
import { WebContentsView } from 'electron'
import type { BaseWindow, View, WebContents, WebPreferences } from 'electron'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { shouldClearFavicon } from '../browsing/favicon.js'
import type { Bounds, TabRecord } from './tab-types.js'
import { isOriginServedFromCacheSync } from '../../loader/electron-serve.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { showContextMenu } from './context-menu.js'
import { devModeEnabled } from '../dev/dev-mode.js'
import { confirmLeavePage } from './leave-page-prompt.js'
import { windowOpenHandler } from './popups.js'

/** The `additionalArguments` flag marking a registered app's tab. Spelled
 * again in preload/routed/fetch.ts rather than imported, for the reason
 * `appTabArgsFor` gives below; within this file it is one constant. */
const APP_TAB_FLAG = '--orivon-app-tab'

/** Which Electron session `target` must run in: its own isolated partition,
 * or undefined for the shell's shared default session.
 *
 * Isolation follows CONSENT, not installation (ADR-0018) -- so do not add
 * `isRegisteredSync` back as a third arm here; an installed app with nothing
 * granted to it is deliberately not isolated.
 *
 * The cache arm is not a second rule, it is what makes the first reachable:
 * ADR-0007 intercepts a cached bundle inside the app's own partition, so an
 * origin served from cache whose tab sat on the default session could not
 * load at all. It must read the registry `registerAppOrigin` itself writes --
 * deciding this from a different one is what made a served app unreachable.
 *
 * `broker` undefined (not yet published) reads as "nothing is granted"; the
 * cache arm still answers, because serving is restored before that point. */
export function partitionForTarget (target: string, broker: Broker | undefined): string | undefined {
  const origin = originFromUrl(target)
  if (origin === null) return undefined
  if (broker?.app.hasGrantsSync(origin) === true) return partitionFor(origin)
  return isOriginServedFromCacheSync(origin) ? partitionFor(origin) : undefined
}

/** Where a navigation must move a tab's view, or undefined for "stay put".
 *
 * `to: undefined` is a REAL answer, not a missing one -- it means "swap this
 * tab back onto the shared default session", which is what an app tab
 * navigating away to an ordinary website needs. Collapsing the two into one
 * `string | undefined` return (as this did before 2026-09-15) silently left
 * that website running inside the app's own partition: its cookies, its
 * storage, and the partition a capability grant is scoped to. */
export interface PartitionSwap {
  readonly to: string | undefined
}

/** The one comparison that decides whether a navigation must swap a tab's
 * view -- shared by navigate()'s own explicit repartition and wireView()'s
 * did-navigate catch for a redirect, clicked link, form submission or script
 * navigation that changes origin without ever calling navigate() (Rule 3;
 * A108/A109, docs/open-questions.md).
 *
 * A target with no derivable origin (about:blank, a rejected navigation)
 * never swaps: there is nothing to isolate, and moving the tab off its
 * current session for a blank page would throw away history for nothing. */
export function partitionChanged (
  target: string,
  currentPartition: string | undefined,
  broker: Broker | undefined
): PartitionSwap | undefined {
  if (originFromUrl(target) === null) return undefined
  const next = partitionForTarget(target, broker)
  return next === currentPartition ? undefined : { to: next }
}

/** ADR-0017's `fetch()`-routing gate: a value fixed at `WebContentsView`
 * construction (via `webPreferences.additionalArguments`, read synchronously
 * off `process.argv` -- the same mechanism `newtab.ts` already uses for its
 * own dashboard-URL check) tells `src/preload/routed/fetch.ts` whether to
 * install its routed `fetch` override, with NO async round trip to race
 * against a page's own first script. `Broker.app.isRegisteredSync`
 * (`../broker/index.ts`) is what makes this possible without one: it reads
 * the SAME in-memory ledger `orivon.app.manifest()` would, in-process, with
 * no IPC. Returns undefined (no flag) for anything with no derivable origin
 * or no broker to ask, same fallback shape as `partitionForTarget` -- an
 * ordinary tab must never carry this flag by accident. The literal
 * '--orivon-app-tab' is duplicated in routed/fetch.ts rather than imported
 * (src/preload/README.md forbids importing anything under src/main/ except
 * ./channels.ts, and this is not a channel) -- the same choice
 * '--orivon-newtab-url=' already made. */
export function appTabArgsFor (target: string, broker: Broker | undefined): string[] | undefined {
  if (broker === undefined) return undefined
  const origin = originFromUrl(target)
  if (origin === null) return undefined
  return broker.app.isRegisteredSync(origin) ? [APP_TAB_FLAG] : undefined
}

/** Every tab's webPreferences, with the standard, non-negotiable ones
 * (contextIsolation/sandbox/no Node integration/webSecurity) -- shared by
 * makeTabView() and a popup's own, so no tab can drift from them (Rule 3). */
export function tabWebPreferences (preload: string, partition: string | undefined, additionalArguments?: string[]): WebPreferences {
  return {
    preload,
    ...(additionalArguments !== undefined ? { additionalArguments } : {}),
    ...(partition !== undefined ? { partition } : {}),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true
  }
}

/** Builds one tab's WebContentsView, shared by tabs.ts's createTab() and
 * repartitionView(). */
export function makeTabView (preload: string, partition: string | undefined, additionalArguments?: string[]): WebContentsView {
  const view = new WebContentsView({ webPreferences: tabWebPreferences(preload, partition, additionalArguments) })
  watchAppTab(view, additionalArguments)
  return view
}

/** The views built with APP_TAB_FLAG. Electron cannot read a view's
 * webPreferences back, and a parked view may only be reused while its flag
 * still matches what its origin needs (takeParkedView). */
const appTabViews = new WeakSet<WebContentsView>()

/** A registered app's tab gets its failures reported; see reportAppFailures. */
function watchAppTab (view: WebContentsView, additionalArguments: string[] | undefined): void {
  if (additionalArguments?.includes(APP_TAB_FLAG) !== true) return
  appTabViews.add(view)
  reportAppFailures(view)
}

/** Prints what an app's own page cannot tell anyone: an uncaught error, a
 * preload that never ran, a dead renderer. An app whose bundle throws while
 * its module graph is still evaluating renders nothing and logs nothing the
 * shell can see, so the first symptom is a blank window with no cause --
 * which is what makes that class of bug expensive rather than hard.
 *
 * REGISTERED APP TABS ONLY, which is why this hangs off the app-tab flag
 * rather than every view: the open web logs errors constantly, and a browser
 * that narrated them all would bury the one case anybody is debugging.
 *
 * Attached per view, not once via `app.on('session-created')` the way
 * `./permission-gate.ts` is. That is not an inconsistency: a session both
 * precedes and outlives the views on it, so a session-scoped handler must be
 * installed where sessions are made. These three events are webContents-
 * scoped and fire on one view's own contents, which is exactly what this
 * function is handed. */
function reportAppFailures (view: WebContentsView): void {
  const { webContents } = view
  const where = (): string => webContents.isDestroyed() ? '(closed)' : webContents.getURL()

  webContents.on('console-message', (details) => {
    if (details.level !== 'error') return
    // An inline or generated script has no sourceId, and `(:1)` reads as a
    // broken path rather than an absent one -- say nothing instead.
    const at = details.sourceId === '' ? '' : `  (${details.sourceId}:${String(details.lineNumber)})`
    console.error(`[orivon][app ${where()}] ${details.message}${at}`)
  })
  webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[orivon][app ${where()}] its preload threw, so no capability surface exists on the page (${preloadPath})`, error)
  })
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[orivon][app ${where()}] the renderer died: ${details.reason} (exit ${String(details.exitCode)})`)
  })
}

/** What the window around the tabs gives them: window.ts supplies it. */
export interface TabShell {
  /** The window a tab's dialogs and menus attach to. */
  readonly window: BaseWindow
  /** A tab's page entered or left HTML fullscreen. */
  htmlFullscreenChanged: (id: string, entered: boolean) => void
}

/** What the per-view wiring below needs back from TabManager.
 *
 * An explicit surface rather than the class itself: these two functions are
 * about ONE view's lifetime, and keeping them honest about what they touch
 * is what lets them live outside the tab collection at all. `forgetTab` is
 * the crash path, `openTab` and `adoptPopup` the two ways a page opens a
 * tab -- all deliberately narrower than the methods behind them. */
export interface TabViewHost {
  readonly preloadPath: string
  readonly contentView: View
  readonly broker: Broker | undefined
  /** Read only to tell "still showing the dashboard" from "navigated away", in `wireView`'s did-navigate below. Never used to decide that a tab IS the dashboard -- `TabRecord.isDashboardTab` owns that, and only creation sets it. */
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

/** A popup whose opener still exists stays in its opener's session on the
 * open web: moving it to the default session would sever `window.opener`,
 * which is what the page opened it for. A move INTO an isolated app still
 * happens, since that is the only session serving the app's pinned bundle. */
function keepsOpenerSession (wc: WebContents, swap: PartitionSwap): boolean {
  return swap.to === undefined && wc.opener !== null && wc.opener !== undefined
}

/** Every event a tab's WebContentsView needs wired -- shared by createTab(),
 * repartitionView() and an adopted popup (Rule 3): each gets EXACTLY the
 * same favicon/title/loading/crash handling and the same popup handling
 * (T18), because as far as anything downstream (the chrome UI, a popup) can
 * tell, they are the same thing. */
export function wireView (host: TabViewHost, id: string, record: TabRecord): void {
  const view = record.view
  const wc = view.webContents
  // False while this view is swapped out or parked: its events are then
  // not the tab's. A parked view acting on a navigation would swap the tab
  // it no longer shows.
  const shown = (): boolean => record.view === view
  wc.on('page-title-updated', () => { host.emitState() })
  wc.on('did-navigate', (_event, navigatedUrl: string) => {
    if (!shown()) return
    if (shouldClearFavicon(record.faviconOrigin, navigatedUrl)) {
      record.favicon = null
      record.faviconOrigin = null
    }
    // Never for the dashboard: its own dev-mode URL is a real http(s)
    // address (partitionChanged would otherwise see a "changed" origin on
    // the dashboard's OWN first load, since its current partition is
    // undefined) -- see createTab()'s isDashboard branch and this file's
    // README-linked design notes for why that tab must stay unpartitioned.
    // A tab showing somebody else's origin is not the dashboard any more,
    // whatever it was created as. Cleared HERE and not left to
    // repartitionView(), which used to be the only thing that cleared it:
    // the repartition check below is itself gated on this flag, so a tab
    // that navigated away WITHOUT needing a partition swap (an origin with
    // no grants yet -- every app's first visit) kept the flag, and therefore
    // kept skipping this check, for the rest of its life. It could never
    // become an app tab afterwards, however it was later granted.
    //
    // ONLY EVER CLEARED, NEVER SET, so no URL a page can influence can win
    // dashboard treatment -- the direction TabRecord.isDashboardTab's own
    // one-way rule exists to protect.
    if (record.isDashboardTab && originFromUrl(navigatedUrl) !== originFromUrl(host.dashboardUrl)) {
      record.isDashboardTab = false
    }
    if (!record.isDashboardTab) {
      const swap = partitionChanged(navigatedUrl, record.partition, host.broker)
      if (swap !== undefined && !keepsOpenerSession(wc, swap)) {
        repartitionView(host, id, record, navigatedUrl, swap.to)
        return
      }
    }
    host.emitState()
  })
  wc.on('did-navigate-in-page', () => { host.emitState() })
  wc.on('did-start-loading', () => { host.emitState() })
  wc.on('did-stop-loading', () => { host.emitState() })
  wc.on('page-favicon-updated', (_event, favicons: string[]) => {
    if (!shown()) return
    // captureFavicon resolves through favicon.ts, whose doc comment promises
    // it never throws -- but a bare `void` would still turn any future break
    // of that promise into an unhandled rejection, and index.ts deliberately
    // maps that to app.exit(1), so a favicon host controlled by any visited
    // page could kill the whole browser.
    void host.captureFavicon(id, record, favicons).catch((error) => {
      console.error('[orivon] favicon capture failed:', error)
    })
  })
  // A renderer crash or other unexpected teardown destroys the webContents
  // without going through closeTab(). Without this the id stays in the tab
  // map, and the NEXT emitState() -- fired by any OTHER tab's event -- calls
  // .getURL() on a destroyed native object and throws inside a main-process
  // Electron callback. There is no top-level handler anywhere in this app,
  // so that throw exits the whole process (electron/electron#19887).
  // Clearing the record here is what makes every `!isDestroyed()` guard
  // actually reachable rather than theatre. Only for the view the tab
  // shows: repartitionView() closes a swapped-out view after the record has
  // moved on, and that close must not forget a tab that is not closing.
  wc.on('destroyed', () => { if (shown()) host.forgetTab(id) })

  wc.on('enter-html-full-screen', () => { host.htmlFullscreenChanged(id, true) })
  wc.on('leave-html-full-screen', () => { host.htmlFullscreenChanged(id, false) })
  // With no listener, Electron keeps the page and says nothing: a guard
  // meant as a question silently blocked the navigation instead.
  wc.on('will-prevent-unload', (event) => {
    // A parked page is being emptied, not left by the person: nobody is
    // asked, as nobody was when a swapped-out view was simply closed.
    if (!shown()) {
      event.preventDefault()
      return
    }
    if (host.window !== undefined && confirmLeavePage(host.window)) event.preventDefault()
  })
  wc.on('context-menu', (_event, params) => {
    if (host.window === undefined) return
    showContextMenu(wc, params, { window: host.window, openInNewTab: host.openTab, developerMode: devModeEnabled() })
  })

  // T18: never a real OS popup window. A popup the page can talk to becomes
  // a tab (./popups.ts); everything else opens as a new tab.
  wc.setWindowOpenHandler(windowOpenHandler({
    atCapacity: host.atCapacity,
    openTab: host.openTab,
    adoptPopup: (view, partition, url) => {
      watchAppTab(view, appTabArgsFor(url, host.broker))
      host.adoptPopup(view, partition)
    },
    partitionFor: (url) => partitionForTarget(url, host.broker),
    webPreferencesFor: (url) => tabWebPreferences(host.preloadPath, undefined, appTabArgsFor(url, host.broker))
  }, () => ({ url: wc.getURL(), partition: record.partition })))
}

/** Swaps the view `record` shows for one in `nextPartition` -- the ONLY way
 * to change a tab's Electron session partition after creation (Electron fixes
 * `webPreferences.partition` at construction; there is no live "reassign
 * session" API). Called from two places, both guarded by `partitionChanged`
 * so neither fires for a same-origin navigation, a rejected/about:blank
 * fallback or the dashboard: navigate() (a typed target, pre-fetch) and
 * wireView()'s did-navigate handler (a redirect, clicked link, form
 * submission or script navigation -- the target is only known once Chromium
 * has already committed it).
 *
 * A view leaving an app's partition is parked rather than closed, and a tab
 * coming back to that app gets it again, with the app's own history and
 * sessionStorage. Every other swap starts from an empty `navigationHistory`,
 * since Electron gives no way to carry it across: entering an app, or
 * leaving one for the open web, still costs the back button (A109; ADR-0018
 * for what swaps at all). */
export function repartitionView (
  host: TabViewHost,
  id: string,
  record: TabRecord,
  target: string,
  nextPartition: string | undefined
): void {
  const oldView = record.view
  const oldPartition = record.partition
  const wasActive = host.isActive(id)

  if (wasActive) host.contentView.removeChildView(oldView)

  const appTabArgs = appTabArgsFor(target, host.broker)
  const parked = takeParkedView(record, nextPartition, appTabArgs)
  const newView = parked ?? makeTabView(host.preloadPath, nextPartition, appTabArgs)
  record.view = newView
  record.partition = nextPartition
  record.isDashboardTab = false
  if (parked === undefined) wireView(host, id, record)
  else keepOnlyOwnEntriesOnReturn(host, parked, target)

  // Only once the record shows the new view: the old one's handlers then
  // ignore it, so closing it here cannot reach forgetTab().
  retireView(record, oldView, oldPartition)

  if (wasActive) {
    host.contentView.addChildView(newView)
    newView.setBounds(host.getTabBounds())
  }

  void newView.webContents.loadURL(target)
}

function closeView (view: WebContentsView): void {
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

/** An app's view is parked on about:blank for the tab's return; any other
 * view is closed. */
function retireView (record: TabRecord, view: WebContentsView, partition: string | undefined): void {
  if (partition === undefined || view.webContents.isDestroyed()) {
    closeView(view)
    return
  }
  record.parkedViews.set(partition, view)
  void view.webContents.loadURL('about:blank')
}

/** The view this tab parked in `partition`, if it can serve the target. Its
 * app-tab flag was fixed when it was built, so one that no longer matches
 * its origin's registration is closed, and the tab gets the fresh view it
 * would have had anyway. */
function takeParkedView (record: TabRecord, partition: string | undefined, appTabArgs: string[] | undefined): WebContentsView | undefined {
  if (partition === undefined) return undefined
  const view = record.parkedViews.get(partition)
  if (view === undefined) return undefined
  record.parkedViews.delete(partition)
  if (!view.webContents.isDestroyed() && appTabViews.has(view) === (appTabArgs !== undefined)) return view
  closeView(view)
  return undefined
}

/** Once a parked view commits the tab's return, drops every history entry
 * that is not its app's own page: the page the app left for, which committed
 * here before the tab moved, and the blank page it waited on. Going back to
 * either would load it inside the app's session. */
function keepOnlyOwnEntriesOnReturn (host: TabViewHost, view: WebContentsView, target: string): void {
  const origin = originFromUrl(target)
  view.webContents.once('did-navigate', () => {
    const history = view.webContents.navigationHistory
    const active = history.getActiveIndex()
    // From the end, so each removal leaves the indices still to visit alone.
    for (let index = history.length() - 1; index >= 0; index--) {
      if (index !== active && originFromUrl(history.getEntryAtIndex(index).url) !== origin) history.removeEntryAtIndex(index)
    }
    host.emitState()
  })
}

/** Closes the views a tab parked for the apps it left: the tab is going. */
export function closeParkedViews (record: TabRecord): void {
  for (const view of record.parkedViews.values()) closeView(view)
  record.parkedViews.clear()
}
