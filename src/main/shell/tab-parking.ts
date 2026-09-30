// Reusing a tab's view across a navigation that changes which session it
// must run in: an app tab leaving for another origin parks its view on
// about:blank instead of closing it, so returning to the app does not pay
// for a fresh renderer and a fresh capability re-check. A concern of its
// own -- park, retire, take back, or repartition outright -- separate from
// tab-view.ts's own "how one tab's WebContentsView is constructed and
// wired" (see that directory's README, `## Design notes`, for why the two
// stay apart).
import { originFromUrl } from '../../broker/policy/origin.js'
import { INTERNAL_PARTITION } from '../pages/internal-pages.js'
import type { TabRecord } from './tab-types.js'
import { appTabArgsFor, appTabOrigins, appTabViews, makeTabView, wireView } from './tab-view.js'
import type { WebContentsView } from 'electron'

function closeView (view: WebContentsView): void {
  if (!view.webContents.isDestroyed()) view.webContents.close()
}

/** The identity a view parks under, so a tab returning to it can find it
 * again. A cache-served app keeps its own partition string, unique per app
 * already. A registered app with NO partition of its own (ADR-0044: held
 * grants, delivered from the network) still needs a key that is unique to
 * IT and not to every other app sharing the default session -- its own
 * origin -- or the first such app to retire in this tab would hand its
 * parked view to whichever different app returns first. Neither an
 * unregistered page nor a partition-less view with no derivable origin has
 * anything worth keeping past a navigation away. */
function parkKeyFor (partition: string | undefined, isAppTab: boolean, origin: string | null): string | undefined {
  if (partition !== undefined) return partition
  return isAppTab && origin !== null ? `app:${origin}` : undefined
}

/** An app's view is parked on about:blank for the tab's return; any other
 * view is closed, an internal page's included: it is one per window and is
 * opened again from the shell, not returned to. */
function retireView (record: TabRecord, view: WebContentsView, partition: string | undefined): void {
  record.host.devtools?.closeFor(view.webContents)
  const key = parkKeyFor(partition, appTabViews.has(view), appTabOrigins.get(view) ?? null)
  if (key === undefined || partition === INTERNAL_PARTITION || view.webContents.isDestroyed()) {
    closeView(view)
    return
  }
  record.parkedViews.set(key, view)
  void view.webContents.loadURL('about:blank')
}

/** The view this tab parked for `target`, if it can serve it. Its app-tab
 * flag was fixed when it was built, so one that no longer matches its
 * origin's registration is closed, and the tab gets the fresh view it would
 * have had anyway. */
function takeParkedView (record: TabRecord, partition: string | undefined, appTabArgs: string[] | undefined, target: string): WebContentsView | undefined {
  const key = parkKeyFor(partition, appTabArgs !== undefined, originFromUrl(target))
  if (key === undefined) return undefined
  const view = record.parkedViews.get(key)
  if (view === undefined) return undefined
  record.parkedViews.delete(key)
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

/** Swaps the view `record` shows for one in `nextPartition` -- the ONLY way
 * to change a tab's Electron session partition after creation (Electron fixes
 * `webPreferences.partition` at construction; there is no live "reassign
 * session" API). Called from two places, both guarded by `partitionChanged`
 * so neither fires for a same-origin navigation, a rejected/about:blank
 * fallback or the dashboard: tabs.ts's navigate() (a typed target, pre-fetch)
 * and tab-view.ts's wireView()'s did-navigate handler (a redirect, clicked
 * link, form submission or script navigation -- the target is only known
 * once Chromium has already committed it).
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
  const parked = takeParkedView(record, nextPartition, appTabArgs, target)
  const newView = parked ?? makeTabView(host.preloadPath, nextPartition, appTabArgs, { target })
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
