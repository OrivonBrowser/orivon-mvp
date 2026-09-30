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
 * way in and restore it on the way out. Three events, because each catches
 * a way a sign-in flow moves between these hosts and none catches all:
 * `will-navigate` (a clicked link or form submit) and `will-redirect` (a
 * server redirect) both fire BEFORE the request goes out, so the User-Agent
 * of that request already carries the new identity; `did-start-navigation`
 * also covers a programmatic `loadURL` and history navigation, but
 * `setUserAgent` called from it lands after the navigation's own request
 * headers are fixed. Requests to a sign-in host are corrected at the network
 * layer regardless (./sign-in-identity-headers.ts); the first request of a
 * navigation that starts elsewhere from a `loadURL` while the tab is on a
 * sign-in host still leaves with the Firefox User-Agent.
 *
 * `setUserAgent()` is called only on an actual CHANGE of state: an ordinary
 * tab that never visits a sign-in host never calls it (Electron has no
 * "unset"). */
export function wireSignInIdentity (webContents: WebContents): void {
  const hosts = resolveSignInHosts()
  const follow = (url: string): void => {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return
    }
    const shouldUseFirefox = isSignInHost(host, hosts)
    // The live string, not a remembered flag: a popup opened from a tab in
    // the Firefox state starts with that tab's override.
    const usingFirefox = webContents.getUserAgent().includes('Firefox/')
    if (shouldUseFirefox === usingFirefox) return
    webContents.setUserAgent(shouldUseFirefox
      ? firefoxUserAgent(process.platform)
      : chromeUserAgent(process.versions.chrome, process.platform))
  }
  webContents.on('will-navigate', (details) => { if (details.isMainFrame) follow(details.url) })
  webContents.on('will-redirect', (details) => { if (details.isMainFrame) follow(details.url) })
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) follow(details.url)
  })
}
