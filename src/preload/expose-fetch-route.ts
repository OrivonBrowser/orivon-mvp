// The preload-side wiring that installs the routed fetch into a tab's main
// world. Split from fetch-route.ts under code-guidelines.md Rule 2, along the
// boundary that file's own header already names: `installFetchRoute` is a
// payload SERIALISED into the main world and may reference nothing outside
// its own body, while this is ordinary preload code that imports freely.
// Keeping them in one file put a function that must not touch an import
// directly beside one that does, which is precisely the confusion that cost
// two near-misses while the decompression cap was being fixed.

import { contextBridge } from 'electron'
import { installFetchRoute } from './fetch-route.js'

/** The literal `webPreferences.additionalArguments` flag `src/main/
 * tab-view.ts`'s `appTabArgsFor` sets -- duplicated here rather than
 * imported (src/preload/README.md forbids importing anything under
 * src/main/ except ./channels.ts, and this is not a channel), the same
 * choice `newtab.ts`'s own `--orivon-newtab-url=` flag already made. */
const APP_TAB_FLAG = '--orivon-app-tab'

/**
 * Fail-open, same shape as orivon-surface.ts's own `exposeOrivon()`:
 * `contextBridge.executeInMainWorld` is `@experimental` and may be absent
 * or throw, in which case this leaves the page's native `fetch` alone
 * rather than abort the rest of preload. Reads `isAppTab` synchronously off
 * `process.argv` -- available here (the isolated world), unlike inside
 * `installFetchRoute` itself, which runs in the main world and has no
 * `process` -- so it crosses as a plain boolean argument instead.
 *
 * `args` carries ONLY `isAppTab` -- `installFetchRoute`'s `target` parameter
 * is deliberately left OMITTED, not passed as an explicit `undefined`, so
 * its own default (the real main-world `window`) applies -- the exact
 * pattern `orivon-surface.ts`'s own `exposeOrivon()` already uses for
 * `installOrivon`'s trailing `target` parameter.
 */
export function exposeFetchRoute (): void {
  const isAppTab = process.argv.includes(APP_TAB_FLAG)
  try {
    contextBridge.executeInMainWorld({ func: installFetchRoute, args: [isAppTab] })
  } catch (error) {
    console.error('[orivon] fetch routing not installed', error)
  }
}
