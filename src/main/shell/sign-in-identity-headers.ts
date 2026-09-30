// The wire half of the sign-in identity (./sign-in-identity.ts): a request to
// a sign-in host leaves with Firefox's User-Agent and none of Chromium's
// Sec-CH-UA* headers. ./sign-in-identity-tab.ts sets `navigator.userAgent`,
// but `setUserAgent()` called from `did-start-navigation` lands after the
// headers of that navigation's own request are already fixed, so only a
// handler at the network layer can correct them. Tied to Electron.
import { session } from 'electron'
import type { Session } from 'electron'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { Subsystem } from '../registry.js'
import { firefoxIdentityHeaders, firefoxUserAgent, isSignInHost } from './sign-in-identity.js'
import { resolveSignInHosts } from './sign-in-identity-test-seam.js'

/** Below RUN_LAST, which the verifier's partition stamp holds: the two never
 * match the same request, and nothing may run after that stamp. */
const SIGN_IN_HEADERS_ORDER = 0

/** Only requests addressed to a sign-in host reach the handler: a listener
 * with a wider filter puts every request of every site through the main
 * process. */
export function signInHeaderFilter (hosts: readonly string[]): { urls: string[] } {
  return { urls: hosts.map((host) => `*://${host}/*`) }
}

/** Registers on the owner for `target`, never on `target.webRequest`: Electron
 * keeps one listener per event per session, and a second registration
 * silently replaces the first. */
export function installSignInIdentityHeaders (target: Session, hosts: readonly string[] = resolveSignInHosts()): void {
  webRequestOwnerFor(target).onBeforeSendHeaders(
    SIGN_IN_HEADERS_ORDER,
    signInHeaderFilter(hosts),
    (url) => {
      try {
        return isSignInHost(new URL(url).host, hosts)
      } catch {
        return false
      }
    },
    (_details, current) => ({
      ...current,
      requestHeaders: firefoxIdentityHeaders(current.requestHeaders, firefoxUserAgent(process.platform))
    })
  )
}

/** The default session only, like every other owner registration: the embed,
 * internal-page and web-context sessions register on webRequest directly, and
 * a cache-served app's own partition is not covered. Ordinary tabs and
 * granted network-served apps run in the default session. */
export const signInIdentitySubsystem: Subsystem = {
  name: 'sign-in-identity',
  afterReady: () => { installSignInIdentityHeaders(session.defaultSession) }
}
