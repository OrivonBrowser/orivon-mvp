// How one tab's WebContentsView is constructed and which Electron session
// partition it gets -- split out of tabs.ts (see that directory's README,
// `## Design notes`, for why). Pure with respect to TabManager: neither
// function here reads or writes any tab-collection state.
import { WebContentsView } from 'electron'
import { partitionFor } from '../broker/grants/origin-hash.js'
import { originFromUrl } from '../broker/policy/origin.js'
import type { Broker } from '../broker/broker-contracts.js'

/** `partitionFor`/`originFromUrl` are the SAME functions the broker uses to
 * key its grant ledger and (ADR-0007) to register a cached bundle's own
 * protocol interception -- so a tab and its eventual grant always agree on
 * which Electron session an origin means. Returns undefined for anything
 * with no derivable origin (about:blank, a rejected navigation), which
 * keeps that tab on the shell's own default session -- there is no app
 * storage to isolate for a page the user never reached. */
export function partitionForTarget (target: string): string | undefined {
  const origin = originFromUrl(target)
  return origin === null ? undefined : partitionFor(origin)
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
