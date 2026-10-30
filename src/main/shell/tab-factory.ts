// Builds a tab: its view, in the session and with the preload that kind of tab
// needs, and its record. TabManager registers and shows what this returns.
//
// content()/trusted()/internal()/popup()/blob() -- one method per kind, because a view's preload
// and session are fixed when it is made: a content tab (a website or an app, or the new-tab page
// when no URL is given, or a trusted caller's own already-checked target), one of the shell's own
// pages, a popup Chromium already created, and a same-origin blob: URL a no-guest open wants.
import { join } from 'node:path'
import type { WebContentsView } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import { localPartitionFor } from '../local-files/partition.js'
import { markFirstDashboardLoad } from '../pages/dashboard-first-load.js'
import { INTERNAL_PARTITION } from '../pages/internal-pages.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { InternalPageRegistry } from '../pages/internal-registry.js'
import { guardInternalView } from '../pages/internal-tab.js'
import { gatewayRedirectFor } from './eth-gateway-rule.js'
import type { TabRecord, TabViewHost } from './tab-types.js'
import { appTabArgsFor, makeDashboardView, makeTabView, partitionForTab, partitionForTarget, wireView } from './tab-view.js'
import { allowedTabChoice } from '../route/site-routes.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import { paintBacking } from './tab-backing.js'
import { watchPopupOpener } from './popup-with-opener.js'
import { INTERNAL_PAGE_BACKGROUND, onThemeUpdated, resolveThemeColor } from './theme-colors.js'

/** The safe fallback for a REJECTED navigation (a dangerous typed scheme,
 * a bad window.open() URL, empty input) -- never the dashboard. Keeping
 * these landings on a plain, privilege-free page rather than the
 * dashboard matters structurally, not just cosmetically: an EXISTING
 * tab keeps whatever preload it was created with (preload is fixed at
 * WebContentsView creation, see TabFactory.content()), so a tab created with the
 * ordinary app.js preload that later lands here via a rejected
 * navigate() call must never show a page that expects the dashboard's
 * own preload to exist. */
export const BLANK_URL = 'about:blank'

let nextId = 1
function makeTabId (): string {
  return `tab-${nextId++}`
}

/** The record field for a tab's tunnel choice: absent when it has none, or when the window is held to a tunnel and the choice is another. */
function choiceOf (tunnelChoice: TabTunnelChoice | undefined): Pick<TabRecord, 'tunnelChoice'> {
  const allowed = allowedTabChoice(tunnelChoice)
  return allowed === undefined ? {} : { tunnelChoice: allowed }
}

export interface BuiltTab {
  readonly id: string
  readonly record: TabRecord
}

export class TabFactory {
  private readonly appPreload = join(import.meta.dirname, '../preload/app.js')
  private readonly internalPreload = join(import.meta.dirname, '../preload/internal.js')

  constructor (
    private readonly host: TabViewHost,
    /** A getter: the broker may still be undefined when the factory is made and published afterwards. */
    private readonly broker: () => Broker | undefined,
    private readonly dashboardUrl: string,
    private readonly internalPages: InternalPageRegistry | undefined
  ) {}

  private recordFor (view: WebContentsView, partition: string | undefined, extra: Partial<TabRecord> = {}): TabRecord {
    return {
      host: this.host,
      view,
      favicon: null,
      faviconOrigin: null,
      pendingFaviconUrl: null,
      partition,
      isDashboardTab: false,
      internalPage: null,
      parkedViews: new Map(),
      pinned: false,
      muted: false,
      crashed: null,
      groupId: null,
      sleeping: null,
      reader: null,
      ...extra
    }
  }

  /** `target`, or the `.eth` address it opens as: decided before the view exists, so the partition, the fragment and the address bar are those of the name from the first load. */
  private opensAs (target: string): string {
    return gatewayRedirectFor(this.host.services?.settings, target) ?? target
  }

  /** A website or an app, or the new-tab page when `url` is undefined. `target` is what to load. `tunnelChoice` is the choice of the tab that opens this one: the tab keeps it, and its session is the one that choice calls for from the first load. */
  content (url?: string, tunnelChoice?: TabTunnelChoice): BuiltTab & { readonly target: string } {
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
    const target = isDashboard ? this.dashboardUrl : this.opensAs(sanitizeDirectUrl(url) ?? BLANK_URL)

    // Excluded even though the dashboard's own URL is occasionally a real
    // http(s) address (electron-vite's dev server) -- `partitionForTarget`
    // cannot tell that apart from a real app on scheme alone, but the
    // dashboard is shell UI (ADR-0003's "browser state" tier), never app
    // content, and must never be isolated as if it were an app's own origin.
    const partition = isDashboard ? undefined : partitionForTab(target, tunnelChoice)

    // An ordinary website tab gets no pre-paint background (see makeTabView's own doc): a site with no CSS background of
    // its own renders white, as the web expects, and painting it dark first would make a transparent-background site
    // look wrong in dark mode. It gets appTabArgsFor's ADR-0017 flag if this origin is already a registered app.
    const view = isDashboard ? makeDashboardView(target) : makeTabView(this.appPreload, partition, appTabArgsFor(target, this.broker()), { target })
    if (isDashboard) markFirstDashboardLoad(view.webContents, this.dashboardUrl)
    const id = makeTabId()
    const record = this.recordFor(view, partition, { isDashboardTab: isDashboard, ...choiceOf(tunnelChoice) })
    wireView(id, record)
    this.host.tabLifecycle?.tabCreated(view.webContents, this.host.window)
    return { id, record, target }
  }

  /** A URL a trusted main-process caller has already checked against its own
   * policy (today: the extension host's extension-url-policy.ts) -- same
   * session/app-tab handling as content(), without its sanitizeDirectUrl
   * gate, which refuses chrome-extension: outright. `named` is the session the caller
   * says the page belongs in (a profile's, for a page of an extension in it, or the one a tunnel choice calls for), and
   * `tunnelChoice` is the choice the tab keeps. */
  trusted (requested: string, named?: string, tunnelChoice?: TabTunnelChoice): BuiltTab & { readonly target: string } {
    const target = this.opensAs(requested)
    const partition = named ?? partitionForTarget(target)
    const view = makeTabView(this.appPreload, partition, appTabArgsFor(target, this.broker()))
    const id = makeTabId()
    const record = this.recordFor(view, partition, choiceOf(tunnelChoice))
    wireView(id, record)
    this.host.tabLifecycle?.tabCreated(view.webContents, this.host.window)
    return { id, record, target }
  }

  /** A document from this computer: the session it belongs in (`localPartitionFor`), the ordinary preload (its `orivon` is refused for lack of a grant), never the app-tab flag.
   * `url` is loaded whole; undefined when it is not a local file. */
  localFile (url: string): (BuiltTab & { readonly target: string }) | undefined {
    const partition = localPartitionFor(url)
    if (partition === undefined) return undefined
    const view = makeTabView(this.appPreload, partition, undefined, { target: url })
    const id = makeTabId()
    const record = this.recordFor(view, partition)
    wireView(id, record)
    this.host.tabLifecycle?.tabCreated(view.webContents, this.host.window)
    return { id, record, target: url }
  }

  /** One of the shell's own pages. Its view lives in the internal session with the
   * internal preload, and it stays on its page (../pages/internal-tab.ts). */
  internal (page: InternalPageId): BuiltTab {
    const view = makeTabView(
      this.internalPreload,
      INTERNAL_PARTITION,
      [`--orivon-internal-page=${page}`],
      { backgroundColor: resolveThemeColor(INTERNAL_PAGE_BACKGROUND) }
    )
    const id = makeTabId()
    const record = this.recordFor(view, INTERNAL_PARTITION, { internalPage: page })
    wireView(id, record)
    guardInternalView(view, page, (target) => { record.host.openTab(target) })
    // The page never leaves orivon://, so its backing colour follows the theme for as long as the view lives.
    const stopTheme = onThemeUpdated(() => {
      if (!view.webContents.isDestroyed()) paintBacking(view, resolveThemeColor(INTERNAL_PAGE_BACKGROUND))
    })
    view.webContents.once('destroyed', stopTheme)
    this.internalPages?.register(view.webContents, page)
    this.host.tabLifecycle?.tabCreated(view.webContents, this.host.window)
    return { id, record }
  }

  /** A popup Chromium already created, with its opener, in the opener's
   * session (./popups.ts). It navigates itself; nothing is loaded. */
  popup (view: WebContentsView, partition: string | undefined, tunnelChoice?: TabTunnelChoice): BuiltTab {
    const id = makeTabId()
    const record = this.recordFor(view, partition, choiceOf(tunnelChoice))
    watchPopupOpener(view, record, () => { this.host.emitState() })
    wireView(id, record)
    this.host.tabLifecycle?.tabCreated(view.webContents, this.host.window)
    return { id, record }
  }

  /** A same-origin blob: URL a no-guest popup open wants (popups.ts's own doc), in `partition` --
   * the opener's own, where the blob was minted. Neither `partitionForTarget` nor
   * `sanitizeDirectUrl` (content()'s own gates) apply to a blob: URL: it has no derivable origin
   * of its own to compute a partition from, and nobody could ever type one into the address bar. */
  blob (url: string, partition: string | undefined, tunnelChoice?: TabTunnelChoice): BuiltTab & { readonly target: string } {
    const view = makeTabView(this.appPreload, partition, appTabArgsFor(url, this.broker()))
    const id = makeTabId()
    const record = this.recordFor(view, partition, choiceOf(tunnelChoice))
    wireView(id, record)
    this.host.tabLifecycle?.tabCreated(view.webContents, this.host.window)
    return { id, record, target: url }
  }
}
