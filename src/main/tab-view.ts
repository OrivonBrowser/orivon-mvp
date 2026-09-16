// How one tab's WebContentsView is constructed and which Electron session
// partition it gets -- split out of tabs.ts (see that directory's README,
// `## Design notes`, for why). Pure with respect to TabManager: neither
// function here reads or writes any tab-collection state.
import { WebContentsView } from 'electron'
import { partitionFor } from '../broker/grants/origin-hash.js'
import { originFromUrl } from '../broker/policy/origin.js'
import type { Broker } from '../broker/broker-contracts.js'

/** Which Electron session `target` must run in: an installed app's own
 * isolated partition, or undefined for the shell's shared default session.
 *
 * **Only an installed app is isolated** -- owner's decision, 2026-09-15,
 * resolving A109. Partitioning every origin meant every cross-origin
 * navigation swapped the whole `WebContentsView` (Electron fixes a partition
 * at construction), and a fresh view starts with empty `navigationHistory`
 * -- so on an ordinary browse, one clicked link or one redirect killed the
 * back button and reloaded the page from scratch. Measured before the change:
 * same-origin back worked, every cross-origin back was dead. An ordinary
 * website has no grant and no app storage to protect, so the isolation was
 * buying nothing there while costing that.
 *
 * `partitionFor`/`originFromUrl` are the SAME functions the broker uses to
 * key its grant ledger and (ADR-0007) to register a cached bundle's own
 * protocol interception -- so a tab and its eventual grant always agree on
 * which Electron session an origin means. `broker` undefined (not yet
 * published) reads as "nothing is registered", the same fallback
 * `appTabArgsFor` below already takes. */
export function partitionForTarget (target: string, broker: Broker | undefined): string | undefined {
  const origin = originFromUrl(target)
  if (origin === null || broker === undefined) return undefined
  return broker.app.isRegisteredSync(origin) ? partitionFor(origin) : undefined
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
 * own dashboard-URL check) tells `src/preload/fetch-route.ts` whether to
 * install its routed `fetch` override, with NO async round trip to race
 * against a page's own first script. `Broker.app.isRegisteredSync`
 * (`../broker/index.ts`) is what makes this possible without one: it reads
 * the SAME in-memory ledger `orivon.app.manifest()` would, in-process, with
 * no IPC. Returns undefined (no flag) for anything with no derivable origin
 * or no broker to ask, same fallback shape as `partitionForTarget` -- an
 * ordinary tab must never carry this flag by accident. The literal
 * '--orivon-app-tab' is duplicated in fetch-route.ts rather than imported
 * (src/preload/README.md forbids importing anything under src/main/ except
 * ./channels.ts, and this is not a channel) -- the same choice
 * '--orivon-newtab-url=' already made. */
export function appTabArgsFor (target: string, broker: Broker | undefined): string[] | undefined {
  if (broker === undefined) return undefined
  const origin = originFromUrl(target)
  if (origin === null) return undefined
  return broker.app.isRegisteredSync(origin) ? ['--orivon-app-tab'] : undefined
}

/** Builds one tab's WebContentsView with the standard, non-negotiable
 * webPreferences (contextIsolation/sandbox/no Node integration/
 * webSecurity), shared by tabs.ts's createTab() and repartitionView() so
 * the two can never drift apart on these (Rule 3). */
export function makeTabView (preload: string, partition: string | undefined, additionalArguments?: string[]): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      preload,
      ...(additionalArguments !== undefined ? { additionalArguments } : {}),
      ...(partition !== undefined ? { partition } : {}),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
}
