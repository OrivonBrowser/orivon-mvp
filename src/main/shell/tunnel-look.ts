// What the address bar's tunnel button says: about the page a tab shows, and about a new tab that shows none yet. A tab that
// carries a tunnel choice sends the websites it opens by the choice (ADR-0101), so the page's tunnel is the choice's, whatever
// its own origin would have been on. Electron-free: the session a page runs in arrives as an opaque object.
import { canTunnel, kindOfProfile } from '../route/site-partition.js'
import { profileOrigin, SHARED_ORIGIN } from '../route/route-hub.js'
import type { RouteHub } from '../route/route-hub.js'
import type { RouteController } from '../route/route-controller.js'
import { tunnelForTab } from '../route/tab-tunnel.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { TunnelKind } from '../route/route-state.js'
import { tunnelLookFor, tunnelMarkFor } from '../route/tunnel-mark.js'
import type { TunnelLook } from '../route/tunnel-mark.js'

export interface LookRoutes {
  readonly hub: Pick<RouteHub, 'kindOf' | 'state' | 'profileFor' | 'isApp' | 'unreadable'>
  readonly controller: Pick<RouteController, 'tunnelOf'>
}

export interface PageFacts {
  readonly origin: string
  /** The session the page runs in. */
  readonly holder: object
  /** The page runs in a temporary session opened through an app's tunnel. */
  readonly temporary: boolean
  /** The choice of the tab showing the page. */
  readonly choice: TabTunnelChoice | undefined
}

/**
 * The look of the tab's page. A website in a tab with a choice is on the tunnel its profile calls for, and its health is that
 * profile's; an installed app, a temporary session and this computer keep the look their own origin gives them.
 */
export function pageTunnelLook (routes: LookRoutes, page: PageFacts): TunnelLook {
  const { hub } = routes
  const byTab = page.choice !== undefined && !page.temporary && canTunnel(page.origin) && !hub.isApp(page.origin)
  const own = byTab ? tunnelForTab(page.choice, page.origin, hub.profileFor(page.origin)) : hub.kindOf(page.origin)
  const state = !byTab ? hub.state(page.origin) : own === undefined ? 'off' : hub.state(profileOrigin(own))
  return tunnelLookFor({ state, temporary: page.temporary, own, session: routes.controller.tunnelOf(page.holder) })
}

/** The tunnel a new tab's first address will leave by: the tab's choice, else where a website with no entry of its own goes. */
function newTabKind (hub: LookRoutes['hub'], choice: TabTunnelChoice | undefined): TunnelKind | undefined {
  if (choice === 'direct') return undefined
  if (choice !== undefined) return choice
  if (!hub.unreadable()) return hub.kindOf(SHARED_ORIGIN)
  // With the tunnel settings unreadable every website takes one tunnel's profile, though Orivon's own requests do not change.
  const profile = hub.profileFor(SHARED_ORIGIN)
  return profile === undefined ? undefined : kindOfProfile(profile)
}

/**
 * The look of a new tab, which shows no website yet: the tunnel its first address will leave by (`newTabKind`), and the health
 * of the profile that address will run in (the shared route while the tab has no choice and the settings are readable).
 */
export function newTabTunnelLook (routes: LookRoutes, choice: TabTunnelChoice | undefined): TunnelLook {
  const kind = newTabKind(routes.hub, choice)
  if (kind === undefined) return { mark: null, via: null }
  const route = choice === undefined && !routes.hub.unreadable() ? SHARED_ORIGIN : profileOrigin(kind)
  const mark = tunnelMarkFor({ state: routes.hub.state(route), temporary: false })
  return { mark, via: mark === null ? null : kind }
}
