// How one tab's WebContentsView is constructed and which Electron session
// partition it gets -- split out of tabs.ts (see that directory's README,
// `## Design notes`, for why). Pure with respect to TabManager: neither
// function here reads or writes any tab-collection state.
import { WebContentsView } from 'electron'
import type { NativeImage, WebContents, WebPreferences } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { faviconOnCommit } from '../browsing/favicon.js'
import { knownIcon } from '../history/favicon-host.js'
import type { TabRecord } from './tab-types.js'
import { showContextMenu } from './context-menu.js'
import { pageMenuItems } from './page-menu-items.js'
import { forgetNavigation, leaveAllowed } from './leave-page-prompt.js'
import { watchPageDialogs } from './page-dialogs.js'
import { windowOpenHandler } from './popups.js'
import { keepsOpenerSession, openerCutNeeded, popupTargetIsApp } from './popup-opener.js'
import { DEFAULT_BACKGROUND } from './theme-colors.js'
import { isDashboardUrl, sheetBackdropOf } from './sheet-backdrop.js'
import { isShellSchemeUrl } from './shell-session.js'
import { recordViewBackground } from './view-background-test-hook.js'
import { watchBacking } from './tab-backing.js'
import { repartitionView } from './tab-parking.js'
import { parseInternalUrl } from '../pages/internal-pages.js'
import { canViewSource } from '../page-tools/view-source.js'
import { sitePopups } from '../site-settings/site-popups.js'
import { refuseHeldNavigation, refuseHeldWindow } from './navigation-hold.js'
import { loadServedAddresses } from './served-address.js'
import { releaseOriginDocument, trackDocumentOrigin } from './tab-origin-liveness.js'
import { watchLoadFailure } from './load-failure.js'
import { trackInflightUrl } from './inflight-url.js'
import { wireSignInIdentity } from './sign-in-identity-tab.js'
import { watchAppTab } from './app-tab-watch.js'
import { wireTabSignals } from './tab-signals.js'
import { readableNow } from '../reader/reader-signal.js'
import { APP_TAB_FLAG, appTabArgsFor, appTabFlagChanged, appTabOrigins, appTabViews, partitionChanged, partitionForTarget } from './tab-partition.js'

export { popupTargetIsApp } from './popup-opener.js'
export { appTabArgsFor, appTabFlagChanged, appTabOrigins, appTabViews, partitionChanged, partitionForTarget } from './tab-partition.js'
export type { PartitionSwap } from './tab-partition.js'

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

/** Every tab's webPreferences, with the standard, non-negotiable ones
 * (contextIsolation/sandbox/no Node integration/webSecurity) -- shared by
 * makeTabView() and a popup's own, so no tab can drift from them (Rule 3).
 *
 * `webviewTag` only for a registered app's tab (ADR-0039): the element is
 * inert everywhere else, and even there every attach is decided by
 * `../embed/embed-host.ts` against the live `web.embed` grant, so turning
 * the tag on grants nothing by itself.
 *
 * Neither `disableDialogs` nor `nodeIntegrationInSubFrames` is set: a page's
 * `alert` and `confirm` are answered by `./page-dialogs.ts` from Electron's own
 * dialog event, which Chromium raises per frame once its own checks pass. */
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
 * `opts.backgroundColor`: painted before this view is ever attached to the
 * screen -- createTab() (tabs.ts) attaches it BEFORE `loadURL`, since a
 * detached view's first paint has nowhere live to land, so whatever colour
 * the view already carries when attached is what actually paints first, for
 * however long the page then takes to apply its own CSS background. Only
 * the shell's OWN pages (the new-tab dashboard, orivon:// internal pages)
 * get one here -- an ordinary website's tab is deliberately left at the
 * default, matching every browser's own new-tab-vs-site distinction (a site
 * may itself be transparent/dark/light and this shell has no opinion on
 * that). A tab built with one is reset to `DEFAULT_BACKGROUND` the moment it
 * stops being the dashboard or an internal page (`resetViewBackground`,
 * called from wireView's did-navigate below) -- the SAME view keeps
 * carrying its old colour across an ordinary navigation that needs no
 * partition swap, and a page with no CSS background of its own would
 * otherwise render on top of it instead of the white the web expects.
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

/** Puts a view's background back to Electron's own default -- called the
 * moment a tab that had one (the dashboard, an internal page) stops being
 * that (wireView's did-navigate below): the colour `makeTabView` set no
 * longer describes this tab, and the SAME view keeps showing it forever
 * otherwise, since Electron never repaints a view's background on its own
 * past the first `setBackgroundColor` call. */
function resetViewBackground (view: WebContentsView): void {
  // A sheet over this view keeps its own surface colour until the sheet goes.
  const color = sheetBackdropOf(view) ?? DEFAULT_BACKGROUND
  view.setBackgroundColor(color)
  recordViewBackground(view.webContents.id, color)
}

/** Each of a dozen subsystems watches a tab's `did-navigate` once, which is past Node's limit of ten and would print
 * a leak warning for every tab. A ceiling just above that count, not unlimited, so a listener added per navigation or per move still warns. */
const TAB_LISTENER_ROOM = 24

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
  wc.setMaxListeners(Math.max(wc.getMaxListeners(), TAB_LISTENER_ROOM))
  // False while this view is swapped out or parked: its events are then
  // not the tab's. A parked view acting on a navigation would swap the tab
  // it no longer shows.
  const shown = (): boolean => record.view === view
  wireSignInIdentity(wc) // ./sign-in-identity-tab.ts's own header says why this runs here.
  trackInflightUrl(wc, record, shown)
  wc.on('page-title-updated', () => { record.host.emitState() })
  watchLoadFailure(wc, () => { record.host.emitState() })
  // A press in a pane is the person choosing it, in a split. Not focus, which a page loading in the other pane can take.
  wc.on('input-event', (_event, input) => { if (input.type === 'mouseDown') record.host.paneClicked(id) })
  // A page in a tab may not send it, or any of its frames, to a page of the shell. The new-tab page is loaded
  // by the main process and reached again by Back, neither of which fires these events.
  const refuseShellPage = (event: { readonly url: string, preventDefault: () => void }): void => {
    if (isShellSchemeUrl(event.url)) event.preventDefault()
  }
  wc.on('will-frame-navigate', refuseShellPage)
  wc.on('will-redirect', refuseShellPage)
  wc.on('did-navigate', (_event, navigatedUrl: string) => {
    // Unconditional, ahead of the `shown()` gate below: a parked or
    // background view's own navigation still changes which origin's
    // document count this WebContents holds, and `retireView`'s own
    // about:blank load is where a session teardown for the origin just left
    // actually fires.
    trackDocumentOrigin(wc, navigatedUrl, record.host.broker)
    if (!shown()) return
    record.host.paneCommitted(id)
    // History's icon only while history is remembering: a private window reads nothing kept on disk.
    const history = record.host.services?.history
    faviconOnCommit(record, navigatedUrl, (address) => history?.remembering === true ? knownIcon(history, address) : null)
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
    // By address, not origin: about:blank, data: and file: pages share the dashboard's opaque origin.
    if (record.isDashboardTab && !isDashboardUrl(navigatedUrl, record.host.dashboardUrl)) {
      record.isDashboardTab = false
      // The dashboard's own pre-paint colour (makeTabView's own doc) must not
      // bleed through a site with no CSS background of its own -- and a
      // navigation with nothing to swap partitions over (the common case:
      // an ordinary site with no grants yet) reuses THIS SAME view below,
      // never rebuilding it fresh.
      resetViewBackground(view)
    }
    // guardInternalView (../pages/internal-tab.ts) refuses every navigation
    // an internal page's OWN content could trigger, so this fires only for
    // one path it cannot see: the address bar (tabs.ts's navigate()) typing
    // something with no derivable origin -- about:blank, say -- straight
    // onto this view with no partition to swap either. Same one-way rule as
    // the dashboard's own flag just above: only ever cleared here, and the
    // view's colour reset the moment it is.
    if (record.internalPage !== null && parseInternalUrl(navigatedUrl)?.page !== record.internalPage) {
      record.internalPage = null
      resetViewBackground(view)
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
  watchBacking(view, record, shown)
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
  // Electron callback, and index.ts's top-level handler exits the whole
  // process on such a throw (electron/electron#19887).
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
    if (leaveAllowed(wc)) event.preventDefault()
  })
  wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) forgetNavigation(wc) })
  watchPageDialogs(wc, shown)
  refuseHeldNavigation(wc)
  loadServedAddresses(wc, () => record.internalPage !== null)
  wc.on('context-menu', (_event, params) => {
    const { window } = record.host
    if (window === undefined) return
    const { devtools, services, runCommand } = record.host
    showContextMenu(wc, params, {
      window,
      ...(services?.kiosk === true ? { kiosk: true } : {}),
      // Beside the page being read, as a middle click opens a link.
      openInNewTab: (url) => { record.host.openTab(url, false) },
      openInFront: (url) => { record.host.openTab(url) },
      openInSplit: (url) => { record.host.openInSplit(id, url) },
      openInWindow: (url) => { record.host.openWindow(url) },
      // A private window has no way back to the profile: it offers no second private session.
      ...(services === undefined || services.isPrivate ? {} : { openInPrivate: (url: string) => { services.profiles.openPrivate(url) } }),
      page: { bare: () => record.internalPage !== null || record.isDashboardTab, viewSource: () => canViewSource(record, wc.getURL()), readable: () => readableNow(wc), reload: () => { record.host.reload(id) } },
      ...(services === undefined ? {} : { services }),
      runCommand,
      ...(devtools?.allowed(wc) === true ? { inspect: (x: number, y: number) => { void devtools.inspect(wc, x, y) } } : {}),
      extraItems: (menuParams) => pageMenuItems(wc, menuParams)
    })
  })

  // T18: a popup the page can talk to becomes a tab, never an OS window
  // (./popups.ts); a shift-click opens a new window instead, but with a
  // fresh tab in it, partitioned exactly as an ordinary tab there would be
  // -- never the opener's own session.
  wc.setWindowOpenHandler(windowOpenHandler({
    atCapacity: () => record.host.atCapacity(),
    openTab: (url, active, loadOptions) => record.host.openTab(url, active, loadOptions),
    adoptPopup: (view, partition, url, active) => {
      watchAppTab(view, appTabArgsFor(url, record.host.broker), url)
      record.host.adoptPopup(view, partition, active)
    },
    openBlobTab: (url, partition, active, loadOptions) => record.host.openBlobTab(url, partition, active, loadOptions),
    openWindow: (url, loadOptions) => record.host.openWindow(url, loadOptions),
    partitionFor: (url) => partitionForTarget(url),
    webPreferencesFor: (url) => tabWebPreferences(record.host.preloadPath, undefined, appTabArgsFor(url, record.host.broker)),
    isApp: (url) => popupTargetIsApp(url, record.host.broker),
    popupBlocked: (details, from) => refuseHeldWindow(wc, details.url) || sitePopups.check(wc, from.url, details.url)
  }, () => ({ url: wc.getURL(), partition: record.partition })))
  wireTabSignals(id, record)
}

/** A snapshot of a page, for the floating preview a tear-off drag shows (tear-drag.ts). `null` for a gone or
 * already-destroyed webContents, or when the capture itself throws -- none of which are worth failing a drag
 * over; the caller (`TabManager.capturePage`) falls back to showing no thumbnail at all.
 *
 * A page behind the one in front is captured as it is, hidden (`stayHidden`): a capture that shows it for
 * the length of the snapshot can still be in flight when a split puts that page on screen, and the pane is
 * then laid out at the size the page had before. A hidden page gives an empty image, which is no thumbnail. */
export async function captureTabPage (wc: WebContents | undefined): Promise<NativeImage | null> {
  if (wc === undefined) return null
  try {
    return await wc.capturePage(undefined, { stayHidden: true })
  } catch {
    return null
  }
}
