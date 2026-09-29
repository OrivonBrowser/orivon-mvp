// Gives a tab's own main frame a Firefox navigator.userAgent when it
// navigates to accounts.google.com or accounts.youtube.com
// (./sign-in-identity.ts's own header has the reasoning).
// Restored to this browser's ordinary Chrome identity the moment the tab
// leaves: webContents.setUserAgent has no "unset", so leaving it on the
// Firefox string after navigating away would carry it into every host the
// tab visits next.
//
// Wired once per tab from ./tab-view.ts's wireView(), which is already
// shared by createTab(), repartitionView() and an adopted popup (its own
// header, Rule 3) -- so a popup opened at one of these hosts gets exactly
// the same treatment as an ordinary tab navigating there.

import type { WebContents } from 'electron'
import { chromeUserAgent } from './user-agent.js'
import { firefoxUserAgent, isSignInHost } from './sign-in-identity.js'
import { resolveSignInHosts } from './sign-in-identity-test-seam.js'

/** Wires one webContents's main-frame navigations to swap identity on the
 * way in and restore it on the way out. `did-start-navigation`, not
 * `will-navigate`: the latter fires only for a renderer-initiated,
 * cancelable navigation (a clicked link or a form submit), missing a
 * redirect, a programmatic `loadURL`, or history navigation -- exactly the
 * ways a real sign-in flow (or an OAuth popup) moves between these hosts.
 *
 * Both UA strings are built lazily, inside the handler, and only on an
 * actual CHANGE of state -- never at wire time, and never on a navigation
 * that leaves the identity exactly as it already was. Two reasons, both
 * load-bearing: an ordinary tab that never visits a sign-in host must never
 * call `webContents.setUserAgent()` at all (Electron has no "unset", so a
 * redundant call is not a no-op, just a wasted one -- every navigation
 * would otherwise re-assert the same Chrome UA it already carries); and
 * `process.versions.chrome` (`chromeUserAgent`'s own input) does not exist
 * outside a real Electron process, which is exactly the environment
 * `tabs.test.ts` wires this same function under with a plain mocked
 * `WebContents` -- computing it unconditionally at wire time broke every
 * such test, not just a sign-in one. */
export function wireSignInIdentity (webContents: WebContents): void {
  const hosts = resolveSignInHosts()
  let usingFirefoxIdentity = false
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    let host: string
    try {
      host = new URL(details.url).host
    } catch {
      return
    }
    const shouldUseFirefox = isSignInHost(host, hosts)
    if (shouldUseFirefox === usingFirefoxIdentity) return
    webContents.setUserAgent(shouldUseFirefox
      ? firefoxUserAgent(process.platform)
      : chromeUserAgent(process.versions.chrome, process.platform))
    usingFirefoxIdentity = shouldUseFirefox
  })
}
