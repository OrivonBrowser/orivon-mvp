// Gives a tab's own main frame a Firefox navigator.userAgent when it
// navigates to accounts.google.com or accounts.youtube.com
// (./sign-in-identity.ts's own header has the reasoning).
// Restored to this browser's ordinary Chrome identity once the tab
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
 * way in and restore it on the way out. `did-start-navigation` is the point
 * Chromium accepts a user-agent change without reloading the tab: the
 * navigation that is starting takes the new override itself. It is never
 * done from `will-navigate` or `will-redirect`: there the entry overrides
 * the user agent while the tab is mid-load, so Chromium cancels the
 * navigation and reloads the last committed page, which a post-sign-in
 * redirect off the sign-in host turns into an endless reload.
 *
 * A server redirect that crosses the boundary fires no `did-start-navigation`,
 * so `did-stop-loading` catches it up: with nothing loading, a change reloads
 * nothing. Until then that document loads under the identity of the page
 * before the redirect (its requests to a sign-in host are corrected at the
 * network layer regardless, ./sign-in-identity-headers.ts, but a landing page
 * off the host sees the Firefox string and Chromium's own client hints).
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
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) follow(details.url)
  })
  webContents.on('did-stop-loading', () => { follow(webContents.getURL()) })
}
