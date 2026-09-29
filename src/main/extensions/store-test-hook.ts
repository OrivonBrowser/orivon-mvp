// Test builds only: exposes the Chrome Web Store methods on `globalThis`,
// reachable from Playwright's ElectronApplication.evaluate() -- it runs
// inside this same process, the same reasoning as ../dev/dev-grant.ts's own
// hook. test/e2e-extensions-store.test.ts has no real
// chromewebstore.google.com page to drive the real install flow from, so it
// drives ctx.extensions' store methods directly instead. Gated on the same
// compiled-in flag as the developer grant, so an ordinary build carries
// none of it; scripts/check-dev-grant-absent.mjs proves that by looking for
// __orivonDevExtensionsStore in the output.
import type { StoreApi } from './store-runner.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // `var`, not `let`/`const`: TypeScript requires it for a `declare global`
  // augmentation. Undefined except inside a process this hook was installed
  // in -- see installStoreTestHook.
  var __orivonDevExtensionsStore: StoreApi | undefined
}

/** Reachable only by code with direct access to this Node process's global
 * scope -- not by any IPC channel, not by any preload, not by
 * window.orivon. */
export function installStoreTestHook (store: StoreApi): void {
  if (!SEAM_ENABLED) return
  globalThis.__orivonDevExtensionsStore = store
}
