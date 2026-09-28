// Installs orivon-node-shim's Node globals (process, global, setImmediate,
// clearImmediate -- src/shim/globals.ts -- and Buffer, ./page-buffer.ts) into
// a real Orivon app tab's own main-world scope, once, before that tab's own
// page script runs. Without them any app whose dependency graph touches
// `stream` fails at load with `process is not defined`, and Node code using a
// bare `Buffer` with `Buffer is not defined`.
//
// GATED ON THE SAME `--orivon-app-tab` FLAG ./expose-fetch-route.ts already
// reads (src/main/tab-view.ts's `appTabArgsFor`): shimmed Node globals must
// never reach an ordinary browsing tab. `window.orivon` itself is exposed to
// every tab (./surface/orivon.ts's own design notes explain why), but that is
// a capability surface an ungranted caller only ever sees denials through;
// `process` is an ambient global a plain page's own script could stumble
// into, a different and wider kind of leak.
//
// NO REPORTER IS PASSED, on purpose: a function crossing contextBridge runs
// in this isolated world, so an uncaught nextTick/setImmediate error would
// land in a console the page cannot see. Omitted, installGlobals reports to
// the page's own reportError, which fires the app's window 'error' handlers.

import { contextBridge } from 'electron'
import { installGlobals, VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../shim/globals.js'
import type { InstallGlobalsOptions } from '../shim/globals.js'
import { installPageBuffer } from './page-buffer.js'

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
  const options: InstallGlobalsOptions = { root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR }
  try {
    contextBridge.executeInMainWorld({ func: installGlobals, args: [options] })
  } catch (error) {
    console.error('[orivon] shim globals not installed', error)
  }
  try {
    contextBridge.executeInMainWorld({ func: installPageBuffer })
  } catch (error) {
    console.error('[orivon] Buffer global not installed', error)
  }
}
