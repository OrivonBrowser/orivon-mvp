import { exposeOrivon } from './surface/orivon.js'
import { exposeFetchRoute } from './expose-fetch-route.js'
import { exposeShimGlobals } from './expose-shim-globals.js'
import { installManifestHintWatcher } from './manifest-hint.js'
import { hideUserAgentDataOnSignInHosts } from './sign-in-identity.js'

/**
 * What every ordinary tab gets: `window.orivon` and everything that depends
 * on it. An extension's own page (a `chrome-extension:` tab) gets none of
 * it -- a tab's preload reaches such a page the same as any other, measured,
 * so without this gate it would receive `window.orivon` too.
 *
 * Shared by `app.ts` and `newtab.ts`'s own fallback branch (a dashboard tab
 * the user has navigated away from is an ordinary tab too).
 */
export function exposeOrdinaryTabSurface (): void {
  if (location.protocol === 'chrome-extension:') return
  // Google's sign-in hosts are shown Firefox's identity, which has no
  // navigator.userAgentData -- ./sign-in-identity.ts.
  hideUserAgentDataOnSignInHosts()
  exposeOrivon()
  // ADR-0017: routes this tab's own fetch(), XMLHttpRequest and
  // EventSource through orivon.net for a registered app's granted hosts.
  // Must run AFTER exposeOrivon() -- it depends on window.orivon already
  // existing in the main world.
  exposeFetchRoute()
  // A151: installs orivon-node-shim's process/setImmediate/clearImmediate
  // for a real app tab, gated on the identical --orivon-app-tab flag
  // exposeFetchRoute() reads -- see expose-shim-globals.ts's own header.
  exposeShimGlobals()
  // S4-2: the discovery trigger. Order relative to the calls above does
  // not matter -- this never touches window.orivon, only the DOM and
  // ipcRenderer.
  installManifestHintWatcher()
}
