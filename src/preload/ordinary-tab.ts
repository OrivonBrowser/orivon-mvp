import { exposeOrivon } from './surface/orivon.js'
import { exposeFetchRoute } from './expose-fetch-route.js'
import { installDisplayCapture } from './display-capture.js'
import { exposeShimGlobals } from './expose-shim-globals.js'
import { exposeChildHostConnect } from './expose-child-host-connect.js'
import { installEmbedEventRelay } from './embed-event-relay.js'
import { installFormWatch } from './form-watch.js'
import { installManifestHintWatcher } from './manifest-hint.js'
import { installPageKeys } from './page-keys.js'
import { installPageVisibility } from './page-visibility.js'
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
  // A tab out of sight reads as hidden to its page, as in Chrome -- ./page-visibility.ts. First, so it is in
  // place before any page script reads the state.
  installPageVisibility()
  exposeOrivon()
  // ADR-0055, ADR-0061: the page's getDisplayMedia asks for Orivon's picker; this world arms the ticket and starts the
  // real call the wrapper makes in the page's world. A tab's page and a new-tab page that went to a site get it; an
  // extension's page and an embed do not.
  installDisplayCapture()
  // ADR-0046: lets a real app tab's page reach its app's child host, gated
  // on the app-tab flag. Must run AFTER exposeOrivon() and BEFORE
  // exposeFetchRoute(): its entries take their page-caller check from the
  // internal-net slot the first creates and the second releases.
  exposeChildHostConnect()
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
  // Saving and filling passwords: inert until main says the vault can keep logins, and it
  // exposes nothing to the page. Never reaches a subframe.
  installFormWatch()
  // A registered app's Ctrl+F that the app did not use: the browser's find bar opens. Exposes nothing.
  installPageKeys()
  // ADR-0047: the popups and downloads of a page this tab shows in a
  // <webview>, told to the element. Idle until main sends.
  installEmbedEventRelay()
}
