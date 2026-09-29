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
import { keepsOpenerSession, openerCutNeeded, popupTargetIsApp } from './popup-opener.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { recordViewBackground } from './view-background-test-hook.js'
import { repartitionView } from './tab-parking.js'

export { popupTargetIsApp } from './popup-opener.js'

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
 * ONLY a cache-served origin gets its own partition. ADR-0007 intercepts a
 * cached bundle with `protocol.handle`, scoped to one session, so an origin
 * served from cache whose tab sat on the default session could not load at
 * all; nothing there answers its scheme. This reads the registry
 * `registerAppOrigin` itself writes -- deciding it from a different one is
 * what made a served app unreachable (A109).
 *
 * A held grant, on its own, is not isolated: a Chrome extension runs as one
 * instance across every page, granted or not, so a granted app shares the
 * session an extension reaches (ADR-0044). Do not add
 * `broker.app.hasGrantsSync` back as an arm here.
 *
 * `originFromUrl` derives an origin only for `http:`/`https:`, so a
 * `chrome-extension:` target always answers undefined: tabs.ts's
 * openTrusted() relies on this to put an extension-opened tab on
 * session.defaultSession, the one session extensions load into. */
export function partitionForTarget (target: string): string | undefined {
  const origin = originFromUrl(target)
  if (origin === null) return undefined
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
  currentPartition: string | undefined
): PartitionSwap | undefined {
  if (originFromUrl(target) === null) return undefined
  const next = partitionForTarget(target)
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
 * versa -- a partition follows CACHE-SERVING (`partitionForTarget`) but this flag
 * follows REGISTRATION (`isRegisteredSync`), so a navigation between a registered
 * app that is not cache-served and an ordinary site can cross this without the
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
 * repartitionView().
 *
 * `opts.backgroundColor`: the white flash a fresh tab shows before it loads
 * fixed -- createTab() (tabs.ts) attaches this view to screen BEFORE
 * `loadURL`, on purpose (a detached view's first paint has nowhere live to
 * land), which means Electron's default opaque-white WebContentsView
 * background is what actually paints first, for however long the page takes
 * to load and apply its own CSS background. Only the shell's OWN pages
 * (the new-tab dashboard, orivon:// internal pages) get one here -- an
 * ordinary website's tab is deliberately left at the default, matching every
 * browser's own new-tab-vs-site distinction (a site may itself be
 * transparent/dark/light and this shell has no opinion on that).
 *
 * `opts.target`, when known, is what the view is about to load -- see
 * appTabOrigins below for why watchAppTab needs it. A trailing options
 * object, not two more positional strings: both are optional and hard to
 * tell apart at a call site by position alone. */
export function makeTabView (preload: string, partition: string | undefined, additionalArguments?: string[], opts: { backgroundColor?: string, target?: string } = {}): WebContentsView {
  const view = new WebContentsView({ webPreferences: tabWebPreferences(preload, partition, additionalArguments) })
  if (opts.backgroundColor !== undefined) {
    view.setBackgroundColor(opts.backgroundColor)
    recordViewBackground(view.webContents.id, opts.backgroundColor)
  }
  watchAppTab(view, additionalArguments, opts.target)
  return view
}

/** The views built with APP_TAB_FLAG. Electron cannot read a view's
 * webPreferences back, and a parked view may only be reused while its flag
 * still matches what its origin needs (tab-parking.ts's takeParkedView, the
 * one outside reader -- exported for that, not for general use). */
export const appTabViews = new WeakSet<WebContentsView>()

/** The origin each app-tab view currently serves, kept current by wireView's
 * did-navigate handler for as long as the view stays put -- see the comment
 * there. tab-parking.ts's retireView reads this for its park key (ADR-0044)
 * rather than the view's live `getURL()`: by the time a redirect or script
 * navigation's did-navigate fires and retirement follows, the view has
 * already committed the URL it is LEAVING FOR, not the one it is leaving;
 * only this map still has the departing origin. Exported for that one
 * outside reader, not for general use. */
export const appTabOrigins = new WeakMap<WebContentsView, string>()

/** A registered app's tab gets its failures reported; see reportAppFailures. */
function watchAppTab (view: WebContentsView, additionalArguments: string[] | undefined, target?: string): void {
  if (additionalArguments?.includes(APP_TAB_FLAG) !== true) return
  appTabViews.add(view)
  const origin = target !== undefined ? originFromUrl(target) : null
  if (origin !== null) appTabOrigins.set(view, origin)
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
      const swap = partitionChanged(navigatedUrl, record.partition)
      const cutOpener = openerCutNeeded(wc, navigatedUrl, record.host.broker)
      if (swap !== undefined && (cutOpener || !keepsOpenerSession(wc, swap))) {
        repartitionView(id, record, navigatedUrl, swap.to)
        return
      }
      // The partition can stay `undefined` on both sides while the opener still must be cut (README.md's Design notes, `openerCutNeeded`).
      if (swap === undefined && cutOpener) {
        repartitionView(id, record, navigatedUrl, partitionForTarget(navigatedUrl))
        return
      }
      // No partition swap does not mean no rebuild is needed: the app-tab
      // flag follows isRegisteredSync, not cache-serving, and can flip
      // while the partition -- and so `swap` -- stays undefined.
      if (swap === undefined && appTabFlagChanged(navigatedUrl, view, record.host.broker)) {
        repartitionView(id, record, navigatedUrl, record.partition)
        return
      }
      // The view is staying: if it is an app tab, record which origin it
      // now serves, for retireView()'s park key WHEN this view later does
      // retire (ADR-0044: a registered, network-served app has no partition
      // of its own, so its origin is the only thing that identifies it --
      // and by the time a redirect or script navigation's did-navigate
      // fires, the view has already committed the NEW url, so that origin
      // can only be read here, before a later navigation overwrites it).
      // Also what lets two granted apps navigated straight into one
      // another (ADR-0044, no swap between them) each retire under their
      // own, current origin rather than the first one this view ever had --
      // and, for the same reason, why developer tools close HERE too
      // (README.md's Design notes), not only in retireView().
      if (appTabViews.has(view)) {
        const origin = originFromUrl(navigatedUrl)
        const previousOrigin = appTabOrigins.get(view) ?? null
        if (origin !== null && origin !== previousOrigin && popupTargetIsApp(navigatedUrl, record.host.broker)) {
          record.host.devtools?.closeFor(wc)
        }
        if (origin !== null) appTabOrigins.set(view, origin)
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
  wc.on('destroyed', () => { if (shown()) record.host.forgetTab(id) })

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

  // T18: a popup the page can talk to becomes a tab, never an OS window
  // (./popups.ts); a shift-click opens a new window instead, but with a
  // fresh tab in it, partitioned exactly as an ordinary tab there would be
  // -- never the opener's own session.
  wc.setWindowOpenHandler(windowOpenHandler({
    atCapacity: () => record.host.atCapacity(),
    openTab: (url, active) => { record.host.openTab(url, active) },
    adoptPopup: (view, partition, url, active) => {
      watchAppTab(view, appTabArgsFor(url, record.host.broker), url)
      record.host.adoptPopup(view, partition, active)
    },
    openWindow: (url) => record.host.openWindow(url),
    partitionFor: (url) => partitionForTarget(url),
    webPreferencesFor: (url) => tabWebPreferences(record.host.preloadPath, undefined, appTabArgsFor(url, record.host.broker)),
    isApp: (url) => popupTargetIsApp(url, record.host.broker)
  }, () => ({ url: wc.getURL(), partition: record.partition })))
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
