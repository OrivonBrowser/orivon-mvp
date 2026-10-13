// Turning an installed app's route on or off: the one path the app card's switch and the question a routed app's page
// raises ("use my proxy for this app too") both take. Electron-free.

import type { RouteService } from './route-service.js'

/** What decides whether an app can be routed: its files are held here, and its origin is written to disk. */
export interface RouteSwitchWorld {
  readonly isPinned: (origin: string) => boolean
  readonly isPersistable: (origin: string) => boolean
}

export interface RouteSwitch {
  /** Why the switch cannot be turned on now (it can always be turned off), or undefined when it can. */
  blockedFor: (origin: string) => 'no-proxy' | 'not-cached' | undefined
  /** Resolves once the app's sessions follow the switch, so nothing is told it is on while they are still direct. */
  set: (origin: string, routed: boolean) => Promise<void>
}

export function createRouteSwitch (routes: Pick<RouteService, 'proxy' | 'store' | 'controller'>, world: RouteSwitchWorld): RouteSwitch {
  return {
    // An app whose files are not held here has a first visit to pause; an origin not written to disk would be routed until the next start and then go direct.
    blockedFor: (origin) => routes.proxy() === undefined ? 'no-proxy' : world.isPinned(origin) && world.isPersistable(origin) ? undefined : 'not-cached',
    set: async (origin, routed) => {
      routes.store.set(origin, routed)
      await routes.controller.settled()
    }
  }
}
