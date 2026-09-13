// Installs orivon-node-shim's Node globals (process, setImmediate,
// clearImmediate -- src/shim/globals.ts) into a real Orivon app tab's own
// main-world scope, once, before that tab's own page script runs. A151
// (docs/open-questions.md): nothing called installGlobals() in production
// before this file, so any real app whose dependency graph touches
// `stream` (this shim's own net/http/https do, transitively) failed at
// load with `process is not defined`.
//
// GATED ON THE SAME `--orivon-app-tab` FLAG ./expose-fetch-route.ts already
// reads (src/main/tab-view.ts's `appTabArgsFor`) -- CLAUDE.md's own
// instruction on this exact defect: shimmed Node globals must never reach
// an ordinary browsing tab just because it loaded before this preload ran.
// `window.orivon` itself is exposed to every tab (./orivon-surface.ts's own
// design notes explain why), but that is a capability surface an ungranted
// caller can only ever see denials through; `process`/`stream` are ambient
// globals a plain page's own script could stumble into, which is a
// different and wider kind of leak this file must not create.

import { contextBridge } from 'electron'
import { installGlobals } from '../shim/globals.js'
import type { GlobalsErrorReporter } from '../shim/globals.js'

/** Duplicated from expose-fetch-route.ts rather than imported -- src/preload/README.md forbids importing anything under src/main/ except ./channels.ts, and this is not a channel. */
const APP_TAB_FLAG = '--orivon-app-tab'

/**
 * Fail-open, same shape as expose-fetch-route.ts's own exposeFetchRoute():
 * `contextBridge.executeInMainWorld` is `@experimental` and may be absent
 * or throw, in which case an app tab is left without shimmed globals
 * rather than aborting the rest of preload -- the same degraded-not-broken
 * choice ADR-0014 already accepted for net.connect's own main-world path.
 */
export function exposeShimGlobals (): void {
  if (!process.argv.includes(APP_TAB_FLAG)) return
  const reportError: GlobalsErrorReporter = (error, origin) => { console.error(`[orivon-shim:${origin}]`, error) }
  try {
    contextBridge.executeInMainWorld({ func: installGlobals, args: [{ reportError }] })
  } catch (error) {
    console.error('[orivon] shim globals not installed', error)
  }
}
