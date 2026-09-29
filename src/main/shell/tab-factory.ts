// Builds a tab: its view, in the session and with the preload that kind of tab
// needs, and its record. TabManager registers and shows what this returns.
//
// Three kinds, because a view's preload and session are fixed when it is made:
// a content tab (a website or an app, or the new-tab page when no URL is given),
// one of the shell's own pages, and a popup Chromium already created.
import { join } from 'node:path'
import type { WebContentsView } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import { INTERNAL_PARTITION } from '../pages/internal-pages.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { InternalPageRegistry } from '../pages/internal-registry.js'
import { guardInternalView } from '../pages/internal-tab.js'
import type { TabRecord, TabViewHost } from './tab-types.js'
import { appTabArgsFor, makeTabView, partitionForTarget, wireView } from './tab-view.js'

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

export interface BuiltTab {
  readonly id: string
  readonly record: TabRecord
}

export class TabFactory {
  private readonly appPreload = join(import.meta.dirname, '../preload/app.js')
  private readonly newTabPreload = join(import.meta.dirname, '../preload/newtab.js')
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
      ...extra
    }
  }

  /** A website or an app, or the new-tab page when `url` is undefined. `target` is what to load. */
  content (url?: string): BuiltTab & { readonly target: string } {
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

    const view = makeTabView(
      isDashboard ? this.newTabPreload : this.appPreload,
      partition,
      // Tells the dashboard's own preload (src/preload/newtab.ts) what its
      // expected URL is, so it can verify `location.href` matches before
      // exposing anything -- necessary because a dashboard tab is an
      // ordinary, navigable tab (unlike the chrome view), and preload
      // cannot be un-set if the user later navigates away. A non-dashboard
      // tab instead gets appTabArgsFor's ADR-0017 flag, if this origin is
      // already a registered app.
      isDashboard ? [`--orivon-newtab-url=${this.dashboardUrl}`] : appTabArgsFor(target, this.broker()),
      target
    )
    const id = makeTabId()
    const record = this.recordFor(view, partition, { isDashboardTab: isDashboard })
    wireView(id, record)
    return { id, record, target }
  }

  /** One of the shell's own pages. Its view lives in the internal session with the
   * internal preload, and it stays on its page (../pages/internal-tab.ts). */
  internal (page: InternalPageId): BuiltTab {
    const view = makeTabView(this.internalPreload, INTERNAL_PARTITION, [`--orivon-internal-page=${page}`])
    const id = makeTabId()
    const record = this.recordFor(view, INTERNAL_PARTITION, { internalPage: page })
    wireView(id, record)
    guardInternalView(view, page, (target) => { record.host.openTab(target) })
    this.internalPages?.register(view.webContents, page)
    return { id, record }
  }

  /** A popup Chromium already created, with its opener, in the opener's
   * session (./popups.ts). It navigates itself; nothing is loaded. */
  popup (view: WebContentsView, partition: string | undefined): BuiltTab {
    const id = makeTabId()
    const record = this.recordFor(view, partition)
    wireView(id, record)
    return { id, record }
  }
}
