// Turning an origin's tunnel on or off: the one path the app card's switch, the site-info popover's switch, the Settings
// list and the question a routed app's page raises ("use my tunnel for this app too") all take. Electron-free.

import { canTunnel, profileOf, profilePartitionFor, PROFILES } from './site-partition.js'
import type { Profile } from './site-partition.js'
import type { RouteState } from './route-hub.js'
import type { RouteService } from './route-service.js'
import { entryFor } from './route-state.js'
import type { TunnelEntry, TunnelKind } from './route-state.js'

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
  /** What the person set: a tunnel, or off; none for an origin kept only for its storage. */
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
  /** Why `origin` cannot be sent through the tunnel `kind` now (it can always be turned off), or undefined when it can: the tunnel has no address, a website is this computer, an app's files are not held here. */
  blockedFor: (origin: string, kind: TunnelKind) => 'no-proxy' | 'local' | 'not-cached' | undefined
  /** The profile choosing `kind` (null: none) moves a website into when it has no storage there yet, so the person is told first; undefined when nothing moves for the first time, and for an app, which has no storage notice. */
  noticeFor: (origin: string, kind: TunnelKind | null) => Profile | undefined
  /**
   * Sends the website or app through the tunnel `kind`, or through none (null): an entry when that differs from what the browser
   * does with it, else it follows the default. Resolves once its sessions follow it, so nothing is told it is on while they are still direct.
   */
  choose: (origin: string, kind: TunnelKind | null) => Promise<void>
  /** Takes a website's entry away, so it follows the default: unlike choosing none, which is an entry of its own while the whole browser is on a tunnel. Its storage stays. Nothing for an app or this computer. */
  forget: (origin: string) => Promise<void>
  /** Every origin with a setting of its own or storage in a profile. */
  rows: () => TunnelRow[]
  /** Clears what a website stored in the profiles, keeping its setting. False for an origin that is not a website with storage there. */
  removeSiteStorage: (origin: string) => Promise<boolean>
}

export function createRouteSwitch (routes: Pick<RouteService, 'targetOf' | 'defaultKind' | 'store' | 'controller' | 'hub'>, world: RouteSwitchWorld): RouteSwitch {
  const { store } = routes
  const entryOf = (kind: TunnelKind | null): TunnelEntry | undefined => entryFor(kind ?? 'off', routes.hub.isEverywhere())
  /** Gives a website `entry` (undefined: none), keeps the record of the storage it now has, and resolves once the sessions follow. */
  const setWebsiteEntry = async (origin: string, entry: TunnelEntry | undefined): Promise<void> => {
    const before = profileOf(store.stateOf(origin))
    // Cookies the proxy's sites left in Nym's profile (a move that could not be made) are cleared before the website arrives, never reused there; a failure to clear stops the switch.
    if (profileOf(entry) === 'nym' && store.isForeignToNym(origin) && world.removeSiteStorage !== undefined) {
      await world.removeSiteStorage(profilePartitionFor('nym', origin), origin)
      store.dropApart(origin, 'nym')
    }
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
    // A website that moved to another session must not wake in the one it left: its workers there would run with the other session's route.
    if (profile !== before) {
      try {
        await world.dropServiceWorkers?.(before === undefined ? undefined : profilePartitionFor(before, origin), origin)
      } catch (error) {
        console.error('[route] could not unregister a website\'s service workers in the session it left:', error)
      }
    }
  }
  return {
    // An app whose files are not held here has a first visit to pause; an origin not written to disk would be routed until the next start and then go direct.
    blockedFor: (origin, kind) => {
      if (routes.targetOf(kind) === undefined) return 'no-proxy'
      if (routes.hub.isApp(origin)) return world.isPinned(origin) && world.isPersistable(origin) ? undefined : 'not-cached'
      return canTunnel(origin) ? undefined : 'local'
    },
    noticeFor: (origin, kind) => {
      if (routes.hub.isApp(origin)) return undefined
      const profile = profileOf(entryOf(kind))
      // Storage in Nym's profile that is really the proxy's is not the website's own there: the person is told as for a first move.
      return profile !== undefined && (!store.isApart(origin, profile) || (profile === 'nym' && store.isForeignToNym(origin))) ? profile : undefined
    },
    choose: async (origin, kind) => {
      if (routes.hub.isApp(origin)) {
        // With the whole browser on the tunnel, switching an app off is an entry of its own; switching it on again follows the default.
        store.setEntry(origin, entryOf(kind))
        await routes.controller.settled()
        return
      }
      if (!canTunnel(origin)) return
      await setWebsiteEntry(origin, entryOf(kind))
    },
    forget: async (origin) => {
      if (routes.hub.isApp(origin) || !canTunnel(origin)) return
      await setWebsiteEntry(origin, undefined)
    },
    rows: () => {
      const entries = new Map(store.entries())
      const origins = new Set([...entries.keys(), ...PROFILES.flatMap((profile) => store.apart(profile))])
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
