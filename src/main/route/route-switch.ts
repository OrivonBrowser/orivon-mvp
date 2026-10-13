// Turning an origin's tunnel on or off: the one path the app card's switch, the site-info popover's switch, the Settings
// list and the question a routed app's page raises ("use my tunnel for this app too") all take. Electron-free.

import { canTunnel, profileOf, profilePartitionFor, PROFILES } from './site-partition.js'
import type { Profile } from './site-partition.js'
import type { RouteState } from './route-hub.js'
import type { RouteService } from './route-service.js'
import { entryFor } from './route-state.js'
import type { TunnelEntry } from './route-state.js'

/** What decides whether an app can be routed: its files are held here, and its origin is written to disk. */
export interface RouteSwitchWorld {
  readonly isPinned: (origin: string) => boolean
  readonly isPersistable: (origin: string) => boolean
  /** Clears what the website at `origin` stored in the profile session named `partition`. */
  readonly removeSiteStorage?: (partition: string, origin: string) => Promise<void>
  /** Unregisters the service workers of the website at `origin` in the session named `partition` (the shared session when undefined), so that a push or a sync wake cannot run it there. */
  readonly dropServiceWorkers?: (partition: string | undefined, origin: string) => Promise<void>
}

/** One origin that has a setting of its own, or storage of its own, for the Settings list. */
export interface TunnelRow {
  readonly origin: string
  /** An installed app, or a website. */
  readonly kind: 'app' | 'site'
  readonly entry: TunnelEntry | undefined
  readonly state: RouteState
  /** The profile the origin's entry puts it in, for a website. */
  readonly profile: Profile | undefined
  /** A website with storage in a profile that "Remove its separate storage" clears. */
  readonly apart: boolean
  /** The profiles it has storage in. */
  readonly apartIn: readonly Profile[]
}

export interface RouteSwitch {
  /** Why an app's switch cannot be turned on now (it can always be turned off), or undefined when it can. */
  blockedFor: (origin: string) => 'no-proxy' | 'not-cached' | undefined
  /** Resolves once the app's sessions follow the switch, so nothing is told it is on while they are still direct. */
  set: (origin: string, routed: boolean) => Promise<void>
  /** Why a website's switch cannot be turned on now (it can always be turned off), or undefined when it can. */
  siteBlockedFor: (origin: string) => 'no-proxy' | 'local' | undefined
  /** The profile setting the website's tunnel to `on` moves it into when it has no storage there yet, so the person is told first; undefined when nothing moves for the first time. */
  siteNotice: (origin: string, on: boolean) => Profile | undefined
  /** Sets a website's tunnel to `on` or off: an entry when that differs from the browser's default, else the website follows the default. Resolves once its sessions follow it. */
  setSite: (origin: string, on: boolean) => Promise<void>
  /** Every origin with a setting of its own or storage in a profile. */
  rows: () => TunnelRow[]
  /** Clears what a website stored in the profiles, keeping its setting. False for an origin that is not a website with storage there. */
  removeSiteStorage: (origin: string) => Promise<boolean>
}

export function createRouteSwitch (routes: Pick<RouteService, 'proxy' | 'store' | 'controller' | 'hub'>, world: RouteSwitchWorld): RouteSwitch {
  const { store } = routes
  return {
    // An app whose files are not held here has a first visit to pause; an origin not written to disk would be routed until the next start and then go direct.
    blockedFor: (origin) => routes.proxy() === undefined ? 'no-proxy' : world.isPinned(origin) && world.isPersistable(origin) ? undefined : 'not-cached',
    set: async (origin, routed) => {
      // With the whole browser on the tunnel, switching an app off is an entry of its own; switching it on again follows the default.
      store.setEntry(origin, entryFor(routed ? 'on' : 'off', routes.hub.isEverywhere()))
      await routes.controller.settled()
    },
    siteBlockedFor: (origin) => routes.proxy() === undefined ? 'no-proxy' : canTunnel(origin) ? undefined : 'local',
    siteNotice: (origin, on) => {
      const profile = profileOf(entryFor(on ? 'on' : 'off', routes.hub.isEverywhere()))
      return profile !== undefined && !store.isApart(origin, profile) ? profile : undefined
    },
    setSite: async (origin, on) => {
      if (!canTunnel(origin)) return
      const entry = entryFor(on ? 'on' : 'off', routes.hub.isEverywhere())
      const before = profileOf(store.stateOf(origin))
      store.setEntry(origin, entry)
      // The record that its storage is kept follows the entry: a failure to save it must not undo a switch already made.
      const profile = profileOf(entry)
      if (profile !== undefined) {
        try {
          store.keepApart(origin, profile)
        } catch (error) {
          console.error('[route] could not record that a website has storage in a profile:', error)
        }
      }
      await routes.controller.settled()
      // A website that moved into a profile must not wake in the session it left: its workers there would run with the other session's route.
      if (profile !== undefined && profile !== before) {
        try {
          await world.dropServiceWorkers?.(before === undefined ? undefined : profilePartitionFor(before, origin), origin)
        } catch (error) {
          console.error('[route] could not unregister a website\'s service workers in the session it left:', error)
        }
      }
    },
    rows: () => {
      const entries = new Map(store.entries())
      const origins = new Set([...entries.keys(), ...store.apart('tunnel'), ...store.apart('direct')])
      return [...origins].map((origin) => ({
        origin,
        kind: store.isApartAnywhere(origin) || !world.isPinned(origin) ? 'site' : 'app',
        entry: entries.get(origin),
        state: routes.hub.state(origin),
        profile: profileOf(entries.get(origin)),
        apart: store.isApartAnywhere(origin),
        apartIn: PROFILES.filter((profile) => store.isApart(origin, profile))
      }))
    },
    removeSiteStorage: async (origin) => {
      if (!store.isApartAnywhere(origin) || world.removeSiteStorage === undefined) return false
      for (const profile of PROFILES) {
        if (!store.isApart(origin, profile)) continue
        await world.removeSiteStorage(profilePartitionFor(profile, origin), origin)
        if (profileOf(store.stateOf(origin)) !== profile) store.dropApart(origin, profile)
      }
      return true
    }
  }
}
