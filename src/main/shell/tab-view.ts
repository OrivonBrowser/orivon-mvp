// How one tab's WebContentsView is constructed and which Electron session
// partition it gets -- split out of tabs.ts (see that directory's README,
// `## Design notes`, for why). Pure with respect to TabManager: neither
// function here reads or writes any tab-collection state.
import { WebContentsView } from 'electron'
import type { NativeImage, WebContents, WebPreferences } from 'electron'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { shouldClearFavicon } from '../browsing/favicon.js'
import type { TabRecord } from './tab-types.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { showContextMenu } from './context-menu.js'
import { confirmLeavePage } from './leave-page-prompt.js'
import { windowOpenHandler } from './popups.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { INTERNAL_PARTITION } from '../pages/internal-pages.js'
import { releaseOriginDocument, trackDocumentOrigin } from './tab-origin-liveness.js'

/** tabs.ts's own tab-count ceiling: an unbounded window.open() flood (an
 * ad/popunder pattern, not hypothetical) would otherwise mint unlimited
 * WebContentsViews -- each its own renderer process -- until the machine
 * OOMs. Refusing beyond this ceiling is far cheaper than crashing the
 * whole browser; no legitimate manual use opens anywhere near 100 tabs.
 * Lives here, not in tabs.ts, only to keep that file under Rule 2's line
 * limit -- it is TabManager's own constant, used nowhere in this file. */
export const MAX_TABS = 100

/** tabs.ts's exitHtmlFullscreen(): any id but 0 (the page's own world) and
 * 999 (the preload's). Same reason as MAX_TABS for living here. */
export const EXIT_FULLSCREEN_WORLD_ID = 1001

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
 * cache arm still answers, because serving is restored before that point.
 *
 * `originFromUrl` derives an origin only for `http:`/`https:` (its own
 * allowlist), so a `chrome-extension:` target -- where every extension runs
 * -- always falls through both arms to undefined: EXPLICITLY, not merely
 * because no app happens to have granted or cached one. tabs.ts's
 * openTrusted() relies on this to put an extension-opened tab on
 * session.defaultSession, the one session extensions load into. */
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

/** Whether `target` needs the app-tab flag `view` does not already carry, or vice
 * versa -- isolation follows CONSENT (`hasGrantsSync`, `partitionForTarget`) but this
 * flag follows REGISTRATION (`isRegisteredSync`), so a navigation between a
 * registered-but-ungranted app and an ordinary site can cross this without the
 * partition ever changing. Undefined for a target with no derivable origin, same as
 * `partitionChanged` -- a rejected navigation must not read as a flag change either. */
export function appTabFlagChanged (target: string, view: WebContentsView, broker: Broker | undefined): boolean {
  if (originFromUrl(target) === null) return false
  return (appTabArgsFor(target, broker) !== undefined) !== appTabViews.has(view)
}

/** Every tab's webPreferences, with the standard, non-negotiable ones
 * (contextIsolation/sandbox/no Node integration/webSecurity) -- shared by
 * makeTabView() and a popup's own, so no tab can drift from them (Rule 3).
 *
 * `webviewTag` only for a registered app's tab (ADR-0039): the element is
 * inert everywhere else, and even there every attach is decided by
 * `../embed/embed-host.ts` against the live `web.embed` grant, so turning
 * the tag on grants nothing by itself. */
export function tabWebPreferences (preload: string, partition: string | undefined, additionalArguments?: string[]): WebPreferences {
  return {
    preload,
    ...(additionalArguments !== undefined ? { additionalArguments } : {}),
    ...(partition !== undefined ? { partition } : {}),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: additionalArguments?.includes(APP_TAB_FLAG) === true
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
 * tell, they are the same thing.
 *
 * Every handler reads `record.host` when it runs, never a host captured here:
 * a tab that moves to another window keeps these handlers. */
export function wireView (id: string, record: TabRecord): void {
  const view = record.view
  const wc = view.webContents
  // False while this view is swapped out or parked: its events are then
  // not the tab's. A parked view acting on a navigation would swap the tab
  // it no longer shows.
  const shown = (): boolean => record.view === view
  wc.on('page-title-updated', () => { record.host.emitState() })
  // A press in a pane is the person choosing it, in a split. Not focus, which a page loading in the other pane can take.
  wc.on('input-event', (_event, input) => { if (input.type === 'mouseDown') record.host.paneClicked(id) })
  wc.on('did-navigate', (_event, navigatedUrl: string) => {
    // Unconditional, ahead of the `shown()` gate below: a parked or
    // background view's own navigation still changes which origin's
    // document count this WebContents holds, and `retireView`'s own
    // about:blank load is where a session teardown for the origin just left
    // actually fires.
    trackDocumentOrigin(wc, navigatedUrl, record.host.broker)
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
    if (record.isDashboardTab && originFromUrl(navigatedUrl) !== originFromUrl(record.host.dashboardUrl)) {
      record.isDashboardTab = false
    }
    if (!record.isDashboardTab) {
      const swap = partitionChanged(navigatedUrl, record.partition, record.host.broker)
      if (swap !== undefined && !keepsOpenerSession(wc, swap)) {
        repartitionView(id, record, navigatedUrl, swap.to)
        return
      }
      // No partition swap does not mean no rebuild is needed: the app-tab
      // flag follows a different predicate (isRegisteredSync) than the
      // partition does (hasGrantsSync), and can flip while the partition
      // -- and so `swap` -- stays undefined.
      if (swap === undefined && appTabFlagChanged(navigatedUrl, view, record.host.broker)) {
        repartitionView(id, record, navigatedUrl, record.partition)
        return
      }
    }
    record.host.emitState()
  })
  wc.on('did-navigate-in-page', () => { record.host.emitState() })
  wc.on('did-start-loading', () => { record.host.emitState() })
  wc.on('did-stop-loading', () => { record.host.emitState() })
  wc.on('page-favicon-updated', (_event, favicons: string[]) => {
    if (!shown()) return
    // captureFavicon resolves through favicon.ts, whose doc comment promises
    // it never throws -- but a bare `void` would still turn any future break
    // of that promise into an unhandled rejection, and index.ts deliberately
    // maps that to app.exit(1), so a favicon host controlled by any visited
    // page could kill the whole browser.
    void record.host.captureFavicon(id, record, favicons).catch((error) => {
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
  wc.on('destroyed', () => {
    // Unconditional, same reason as the trackDocumentOrigin call above: a
    // view closed outright (never parked to about:blank first) still ends
    // whatever document it held, and this is the only remaining chance to
    // release it.
    releaseOriginDocument(wc, record.host.broker)
    if (shown()) record.host.forgetTab(id)
  })

  wc.on('enter-html-full-screen', () => { record.host.htmlFullscreenChanged(id, true) })
  wc.on('leave-html-full-screen', () => { record.host.htmlFullscreenChanged(id, false) })
  // With no listener, Electron keeps the page and says nothing: a guard
  // meant as a question silently blocked the navigation instead.
  wc.on('will-prevent-unload', (event) => {
    // A parked page is being emptied, not left by the person: nobody is
    // asked, as nobody was when a swapped-out view was simply closed.
    if (!shown()) {
      event.preventDefault()
      return
    }
    const { window } = record.host
    if (window !== undefined && confirmLeavePage(window)) event.preventDefault()
  })
  // Chromium knows no `ipfs:` scheme and would offer a link to one to the
  // OS; it loads here instead, from the URL its protocol serves it at.
  wc.on('will-navigate', (event) => {
    if (record.internalPage !== null) return
    const served = BUILTIN_ADDRESSES.servedUrl(event.url)
    if (served === undefined) return
    event.preventDefault()
    void wc.loadURL(served)
  })
  wc.on('context-menu', (_event, params) => {
    const { window } = record.host
    if (window === undefined) return
    const { devtools } = record.host
    showContextMenu(wc, params, {
      window,
      openInNewTab: (url) => { record.host.openTab(url) },
      openInSplit: (url) => { record.host.openInSplit(id, url) },
      ...(devtools?.allowed(wc) === true ? { inspect: (x: number, y: number) => { devtools.inspect(wc, window, x, y) } } : {})
    })
  })

  // T18: never a real OS popup window. A popup the page can talk to becomes
  // a tab (./popups.ts); everything else opens as a new tab.
  wc.setWindowOpenHandler(windowOpenHandler({
    atCapacity: () => record.host.atCapacity(),
    openTab: (url) => { record.host.openTab(url) },
    adoptPopup: (view, partition, url) => {
      watchAppTab(view, appTabArgsFor(url, record.host.broker))
      record.host.adoptPopup(view, partition)
    },
    partitionFor: (url) => partitionForTarget(url, record.host.broker),
    webPreferencesFor: (url) => tabWebPreferences(record.host.preloadPath, undefined, appTabArgsFor(url, record.host.broker))
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
  id: string,
  record: TabRecord,
  target: string,
  nextPartition: string | undefined
): void {
  const { host } = record
  // A navigation that commits as the window closes must not make a view nobody will close.
  if (host.isClosing()) return
  const oldView = record.view
  const oldPartition = record.partition
  const wasShown = host.isShown(id)

  if (wasShown) host.detachView(oldView)

  const appTabArgs = appTabArgsFor(target, host.broker)
  const parked = takeParkedView(record, nextPartition, appTabArgs)
  const newView = parked ?? makeTabView(host.preloadPath, nextPartition, appTabArgs)
  record.view = newView
  record.partition = nextPartition
  record.isDashboardTab = false
  record.internalPage = null
  if (parked === undefined) wireView(id, record)
  else keepOnlyOwnEntriesOnReturn(record, parked, target)

  // Same tab, fresh WebContents -- the lifecycle seam's one event tab-
  // view.ts raises directly (tab-lifecycle.ts's own doc says why).
  host.tabLifecycle?.viewReplaced(oldView.webContents, newView.webContents, host.window)

  // Only once the record shows the new view: the old one's handlers then
  // ignore it, so closing it here cannot reach forgetTab().
  retireView(record, oldView, oldPartition)

  if (wasShown) host.attachView(id, newView)

  void newView.webContents.loadURL(target)
}

function closeView (view: WebContentsView): void {
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

/** An app's view is parked on about:blank for the tab's return; any other
 * view is closed, an internal page's included: it is one per window and is
 * opened again from the shell, not returned to. */
function retireView (record: TabRecord, view: WebContentsView, partition: string | undefined): void {
  record.host.devtools?.closeFor(view.webContents)
  if (partition === undefined || partition === INTERNAL_PARTITION || view.webContents.isDestroyed()) {
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
function keepOnlyOwnEntriesOnReturn (record: TabRecord, view: WebContentsView, target: string): void {
  const origin = originFromUrl(target)
  view.webContents.once('did-navigate', () => {
    const history = view.webContents.navigationHistory
    const active = history.getActiveIndex()
    // From the end, so each removal leaves the indices still to visit alone.
    for (let index = history.length() - 1; index >= 0; index--) {
      if (index !== active && originFromUrl(history.getEntryAtIndex(index).url) !== origin) history.removeEntryAtIndex(index)
    }
    record.host.emitState()
  })
}

/** Closes the views a tab parked for the apps it left: the tab is going. */
export function closeParkedViews (record: TabRecord): void {
  for (const view of record.parkedViews.values()) closeView(view)
  record.parkedViews.clear()
}

/** A snapshot of a page, for the floating preview a tear-off drag shows (tear-drag.ts). `null` for a gone or
 * already-destroyed webContents, or when the capture itself throws -- none of which are worth failing a drag
 * over; the caller (`TabManager.capturePage`) falls back to showing no thumbnail at all. */
export async function captureTabPage (wc: WebContents | undefined): Promise<NativeImage | null> {
  if (wc === undefined) return null
  try {
    return await wc.capturePage()
  } catch {
    return null
  }
}
