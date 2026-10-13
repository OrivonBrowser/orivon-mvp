// What the shell asks of the routes when a routed app's page opens an address outside the app's own sessions: whether to
// ask, a session to open the page in "through my tunnel", and the app switch for "use my tunnel for this app too". Main
// supplies it once, as `lookup-session.ts` does; a caller asks per open, so a switch flipped meanwhile is followed.

import { leavesRoute, routedPageOrigin } from './leave-decision.js'
import type { Leave, LeaveWorld } from './leave-decision.js'
import type { RouteSwitch } from './route-switch.js'
import type { TemporaryRoutes } from './temporary-routes.js'

export interface LeavingRoutes {
  readonly world: LeaveWorld
  readonly temporary: Pick<TemporaryRoutes, 'open' | 'owns' | 'isLive'>
  readonly routeSwitch: RouteSwitch
}

let source: LeavingRoutes | undefined

/** Called once at start by whoever owns the routes. */
export function setLeavingRoutes (next: LeavingRoutes | undefined): void {
  source = next
}

/** Whether the page at `url` in `partition` is a routed app's: the cheap question every navigation of every tab asks first. */
export function isRoutedPage (url: string, partition: string | undefined): boolean {
  return source !== undefined && routedPageOrigin(url, partition, source.world) !== undefined
}

/** What asking is about when the page at `fromUrl` (in `partition`) opens `toUrl`, or undefined when nothing needs asking (including a browser with no routes). */
export function leaveFor (fromUrl: string, toUrl: string, partition?: string): Leave | undefined {
  return source === undefined ? undefined : leavesRoute(fromUrl, toUrl, source.world, partition)
}

/** A new in-memory session behind a front of its own, as the partition a tab is made in. */
export async function openTemporaryRoute (): Promise<string> {
  if (source === undefined) throw new Error('no routes are running')
  return await source.temporary.open()
}

/** Whether `session` is a temporary routed one. */
export function isTemporaryRouteSession (session: object | undefined): boolean {
  return source?.temporary.owns(session) === true
}

/** Whether `partition` names a temporary routed session that is still alive. */
export function isTemporaryRoutePartitionLive (partition: string | undefined): boolean {
  return partition !== undefined && source?.temporary.isLive(partition) === true
}

/** Turns the app's route on, as its card does. False when it cannot be turned on (no proxy, or its files are not held here). */
export async function routeAppToo (origin: string): Promise<boolean> {
  if (source === undefined || source.routeSwitch.blockedFor(origin) !== undefined) return false
  await source.routeSwitch.set(origin, true)
  return true
}
