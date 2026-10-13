// What the shell reads to put a website in the session its tunnel state calls for: main supplies the answer once, as
// `leaving-routes.ts` does, and a caller asks per navigation, so a switch flipped meanwhile is followed.

import { originFromUrl } from '../../broker/policy/origin.js'
import { canTunnel, isSitePartition, sitePartitionFor as nameOf } from './site-partition.js'

export interface SiteRoutes {
  /** Whether the website at `origin` runs in a session of its own (`RouteHub.usesOwnSession`). */
  readonly usesOwnSession: (origin: string) => boolean
}

let source: SiteRoutes | undefined
/** The origin each session name handed out stands for: a session made before its first page loads is prepared from it. */
const origins = new Map<string, string>()

/** Called once at start by whoever owns the routes. */
export function setSiteRoutes (next: SiteRoutes | undefined): void {
  source = next
  origins.clear()
}

/** The session the website at `origin` must run in, or undefined for the shared one. */
export function sitePartitionForOrigin (origin: string): string | undefined {
  if (source === undefined || !canTunnel(origin) || !source.usesOwnSession(origin)) return undefined
  const partition = nameOf(origin)
  origins.set(partition, origin)
  return partition
}

/**
 * Whether a navigation of a tab in the shared session to `url` must be refused: the website has a session of its own, and a
 * load that did not go through the shell's own move (a tab waking, Back onto an older page, a script's `loadURL`) would
 * otherwise reach it without the tunnel and with the shared session's cookies. The tab's own view is moved by the shell
 * before it loads an address it is asked to open, so a refusal here only ever stops what that move missed.
 */
export function mustLeaveSharedSession (url: string, servedFromCache: (origin: string) => boolean): boolean {
  const origin = originFromUrl(url)
  return origin !== null && !servedFromCache(origin) && sitePartitionForOrigin(origin) !== undefined
}

let ensurer: ((partition: string) => void) | undefined

/** Called once at start by whoever owns the routes: what makes a website's session ready before a view is made in it. */
export function setSiteSessionEnsurer (next: ((partition: string) => void) | undefined): void {
  ensurer = next
}

/** Makes the website session named `partition` ready for a view about to be made in it. A name that is not one does nothing. */
export function ensureSiteSession (partition: string): void {
  if (isSitePartition(partition)) ensurer?.(partition)
}

/** The origin a session of its own stands for, or undefined for a name this process has not handed out. */
export function siteOriginOf (partition: string | undefined): string | undefined {
  return isSitePartition(partition) && partition !== undefined ? origins.get(partition) : undefined
}
