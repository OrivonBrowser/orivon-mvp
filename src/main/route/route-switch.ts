// Turning an origin's tunnel on or off: the one path the app card's switch, the site-info popover's switch, the Settings
// list and the question a routed app's page raises ("use my tunnel for this app too") all take. Electron-free.

import { sitePartitionFor, canTunnel } from './site-partition.js'
import type { RouteState } from './route-hub.js'
import type { RouteService } from './route-service.js'
import type { TunnelEntry } from './route-state.js'

/** What decides whether an app can be routed: its files are held here, and its origin is written to disk. */
export interface RouteSwitchWorld {
  readonly isPinned: (origin: string) => boolean
  readonly isPersistable: (origin: string) => boolean
  /** Clears what a website's session of its own stored. */
  readonly removeSiteStorage?: (partition: string) => Promise<void>
}

/** One origin that has a setting of its own, or storage of its own, for the Settings list. */
export interface TunnelRow {
  readonly origin: string
  /** An installed app, or a website. */
  readonly kind: 'app' | 'site'
  readonly entry: TunnelEntry | undefined
  readonly state: RouteState
  /** A website with storage of its own that "Remove its separate storage" clears. */
  readonly apart: boolean
}

export interface RouteSwitch {
  /** Why an app's switch cannot be turned on now (it can always be turned off), or undefined when it can. */
  blockedFor: (origin: string) => 'no-proxy' | 'not-cached' | undefined
  /** Resolves once the app's sessions follow the switch, so nothing is told it is on while they are still direct. */
  set: (origin: string, routed: boolean) => Promise<void>
  /** Why a website's switch cannot be turned on now (it can always be turned off), or undefined when it can. */
  siteBlockedFor: (origin: string) => 'no-proxy' | 'local' | undefined
  /** Whether turning the switch on moves the website into storage of its own for the first time, so the person is told first. */
  siteNeedsNotice: (origin: string) => boolean
  /** Turns a website's tunnel on, or back to following the default. Resolves once its sessions follow it. */
  setSite: (origin: string, on: boolean) => Promise<void>
  /** Every origin with a setting of its own or storage of its own. */
  rows: () => TunnelRow[]
  /** Clears a website's own storage, keeping its setting. False for an origin that is not a website with storage of its own. */
  removeSiteStorage: (origin: string) => Promise<boolean>
}

export function createRouteSwitch (routes: Pick<RouteService, 'proxy' | 'store' | 'controller' | 'hub'>, world: RouteSwitchWorld): RouteSwitch {
  const { store } = routes
  return {
    // An app whose files are not held here has a first visit to pause; an origin not written to disk would be routed until the next start and then go direct.
    blockedFor: (origin) => routes.proxy() === undefined ? 'no-proxy' : world.isPinned(origin) && world.isPersistable(origin) ? undefined : 'not-cached',
    set: async (origin, routed) => {
      store.set(origin, routed)
      await routes.controller.settled()
    },
    siteBlockedFor: (origin) => routes.proxy() === undefined ? 'no-proxy' : canTunnel(origin) ? undefined : 'local',
    siteNeedsNotice: (origin) => !store.isApart(origin),
    setSite: async (origin, on) => {
      if (on && !canTunnel(origin)) return
      store.setEntry(origin, on ? 'on' : undefined)
      // The record that its storage is kept follows the entry: a failure to save it must not undo a switch already made.
      if (on) {
        try {
          store.keepApart(origin)
        } catch (error) {
          console.error('[route] could not record that a website has storage of its own:', error)
        }
      }
      await routes.controller.settled()
    },
    rows: () => {
      const entries = new Map(store.entries())
      const origins = new Set([...entries.keys(), ...store.apart()])
      return [...origins].map((origin) => ({
        origin,
        kind: store.isApart(origin) || !world.isPinned(origin) ? 'site' : 'app',
        entry: entries.get(origin),
        state: routes.hub.state(origin),
        apart: store.isApart(origin)
      }))
    },
    removeSiteStorage: async (origin) => {
      if (!store.isApart(origin) || world.removeSiteStorage === undefined) return false
      await world.removeSiteStorage(sitePartitionFor(origin))
      if (store.stateOf(origin) === undefined) store.dropApart(origin)
      return true
    }
  }
}
