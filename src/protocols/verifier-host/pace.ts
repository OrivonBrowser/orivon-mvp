// How long the host waits at each step, by the route its requests travel (../route-pace.ts). A mixnet opens a stream in
// a few seconds and needs several round trips of about a second each before a first byte, so the steps that wait on the
// network (the light client's first sync and a name's proof) are stretched by how much slower the route is; on a direct
// connection they are what they were written as.

import { DIRECT_ROUTE, RouteMeter, TUNNEL_PROFILE, ceilingWait } from '../route-pace.js'
import type { RoutePace } from '../route-pace.js'

export interface Pace {
  /** How long a `.eth` load waits for the light client's first sync before it says "cannot verify yet". */
  readonly syncWaitMs: number
  /** How long a name is proved before the load fails. */
  readonly mountTimeoutMs: number
  /** How long after the host starts the shared light client starts syncing if no `.eth` name has asked for it by then; see below. */
  readonly lightClientStartAfterMs: number
}

/** The waits below, written for a direct connection. */
const SYNC_WAIT_MS = 8_000
const MOUNT_TIMEOUT_MS = 45_000

/**
 * The light client's first sync fetches about two megabytes from the beacon API, which a mixnet carries at some 15 to 20
 * kilobytes a second: two minutes in which every other request through the same tunnel crawls, an `ipfs://` page included.
 * On a slow route the client starts when a `.eth` name first needs it, or three minutes after the host starts (so the stored
 * checkpoint is still renewed while a `.eth` name is never visited), whichever comes first.
 */
const SLOW_ROUTE_START_AFTER_MS = 3 * 60_000

export function paceOn (route: RoutePace): Pace {
  return {
    syncWaitMs: route.firstWait(SYNC_WAIT_MS),
    mountTimeoutMs: route.firstWait(MOUNT_TIMEOUT_MS),
    lightClientStartAfterMs: route.slow() ? SLOW_ROUTE_START_AFTER_MS : 0
  }
}

/** The most `paceOn(route).mountTimeoutMs` can be for a route of this kind, whatever it has measured: the shell asks the host for a mount and must not give up before the host does. */
export function mountCeilingMs (tunnelled: boolean): number {
  return tunnelled ? ceilingWait({ ...TUNNEL_PROFILE }, MOUNT_TIMEOUT_MS) : MOUNT_TIMEOUT_MS
}

/** The route of requests that leave through the tunnel, or the direct one. A tunnel route keeps what it has measured. */
export function routeFor (tunnelled: boolean): RoutePace {
  return tunnelled ? new RouteMeter(TUNNEL_PROFILE) : DIRECT_ROUTE
}

/** What the light client takes of a pace. */
export function lightClientPace (pace: Pace): { readonly syncWaitMs: number, readonly startAfterMs: number } {
  return { syncWaitMs: pace.syncWaitMs, startAfterMs: pace.lightClientStartAfterMs }
}
