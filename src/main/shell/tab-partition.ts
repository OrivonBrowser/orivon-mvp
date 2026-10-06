// Which Electron session a tab's view runs in, and whether it carries the app-tab
// flag: the two facts a navigation can change, decided from the target URL alone.
// Split out of tab-view.ts, which re-exports every name here.
import type { WebContentsView } from 'electron'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isolationKeyFromUrl, originFromUrl } from '../../broker/policy/origin.js'
import { localPartitionFor, partitionAfterFileBlock as fileBlockTarget } from '../local-files/partition.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { Broker } from '../../broker/broker-contracts.js'

/** The `additionalArguments` flag marking a registered app's tab. Spelled
 * again in preload/routed/fetch.ts rather than imported, for the reason
 * `appTabArgsFor` gives below; within this file it is one constant. */
export const APP_TAB_FLAG = '--orivon-app-tab'

/** Which Electron session `target` must run in: its own isolated partition,
 * or undefined for the shell's shared default session.
 *
 * ONLY a cache-served origin gets its own partition. ADR-0007 intercepts a
 * cached bundle with `protocol.handle`, scoped to one session, so an origin
 * served from cache whose tab sat on the default session could not load at
 * all; nothing there answers its scheme. This reads the registry
 * `registerAppOrigin` itself writes -- deciding it from a different one
 * makes a served app unreachable.
 *
 * A held grant, on its own, is not isolated: a Chrome extension runs as one
 * instance across every page, granted or not, so a granted app shares the
 * session an extension reaches (ADR-0044). Do not add
 * `broker.app.hasGrantsSync` back as an arm here.
 *
 * A local file always runs in a local-files session, whatever the shell had
 * it in before: its own once the person has let it use Orivon permissions,
 * the shared one before (`localPartitionFor`).
 *
 * `originFromUrl` derives an origin only for `http:`/`https:`, so a
 * `chrome-extension:` target always answers undefined: tabs.ts's
 * openTrusted() relies on this to put an extension-opened tab on
 * session.defaultSession, the one session extensions load into. */
export function partitionForTarget (target: string): string | undefined {
  const local = localPartitionFor(target)
  if (local !== undefined) return local
  const origin = originFromUrl(target)
  if (origin === null) return undefined
  return isOriginServedFromCacheSync(origin) ? partitionFor(origin) : undefined
}

/** Where a navigation must move a tab's view, or undefined for "stay put".
 *
 * `to: undefined` is a REAL answer, not a missing one -- it means "swap this
 * tab back onto the shared default session", which is what an app tab
 * navigating away to an ordinary website needs. Collapsing the two into one
 * `string | undefined` return would silently leave
 * that website running inside the app's own partition: its cookies, its
 * storage, and the partition a capability grant is scoped to. */
export interface PartitionSwap {
  readonly to: string | undefined
}

/** The one comparison that decides whether a navigation must swap a tab's
 * view -- shared by navigate()'s own explicit repartition and wireView()'s
 * did-navigate catch for a redirect, clicked link, form submission or script
 * navigation that changes origin without ever calling navigate().
 *
 * A target with no derivable origin (about:blank, a rejected navigation)
 * never swaps: there is nothing to isolate, and moving the tab off its
 * current session for a blank page would throw away history for nothing. */
export function partitionChanged (
  target: string,
  currentPartition: string | undefined
): PartitionSwap | undefined {
  if (isolationKeyFromUrl(target) === null) return undefined
  const next = partitionForTarget(target)
  return next === currentPartition ? undefined : { to: next }
}

/** Where a tab moves when the fence cancelled its main-frame `file:` load (`../local-files/partition.ts`'s `partitionAfterFileBlock`), as a swap. */
export function partitionAfterFileBlock (
  failedUrl: string,
  errorCode: number,
  isMainFrame: boolean,
  currentPartition: string | undefined
): PartitionSwap | undefined {
  const to = fileBlockTarget(failedUrl, errorCode, isMainFrame, currentPartition)
  return to === undefined ? undefined : { to }
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
  const origin = isolationKeyFromUrl(target)
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
  if (isolationKeyFromUrl(target) === null) return false
  return (appTabArgsFor(target, broker) !== undefined) !== appTabViews.has(view)
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
