// What the shell reads to put a website in the session its tunnel entry calls for: main supplies the answer once, as
// `leaving-routes.ts` does, and a caller asks per navigation, so a switch flipped meanwhile is followed.

import { originFromUrl } from '../../broker/policy/origin.js'
import { canTunnel, isProfilePartition, profileOfPartition, profilePartitionFor } from './site-partition.js'
import type { Profile } from './site-partition.js'

export interface SiteRoutes {
  /** The profile the website at `origin` runs in (`RouteHub.profileFor`), or undefined for a website that follows the default session. */
  readonly profileFor: (origin: string) => Profile | undefined
}

let source: SiteRoutes | undefined

/** Called once at start by whoever owns the routes. */
export function setSiteRoutes (next: SiteRoutes | undefined): void {
  source = next
}

/** The session the website at `origin` must run in, or undefined for the shared one. */
export function sitePartitionForOrigin (origin: string): string | undefined {
  if (source === undefined || !canTunnel(origin)) return undefined
  const profile = source.profileFor(origin)
  return profile === undefined ? undefined : profilePartitionFor(profile, origin)
}

/**
 * Whether a navigation of a tab in the shared session to `url` must be refused: the website has a profile, and a load that
 * did not go through the shell's own move (a tab waking, Back onto an older page, a script's `loadURL`) would otherwise
 * reach it with the shared session's cookies, and without the tunnel if its entry is `on`. The tab's own view is moved by
 * the shell before it loads an address it is asked to open, so a refusal here only ever stops what that move missed.
 */
export function mustLeaveSharedSession (url: string, servedFromCache: (origin: string) => boolean): boolean {
  const origin = originFromUrl(url)
  return origin !== null && !servedFromCache(origin) && sitePartitionForOrigin(origin) !== undefined
}

let ensurer: ((partition: string) => void) | undefined

/** Called once at start by whoever owns the routes: what makes a profile's session ready before a view is made in it. */
export function setSiteSessionEnsurer (next: ((partition: string) => void) | undefined): void {
  ensurer = next
}

/** Makes the profile session named `partition` ready for a view about to be made in it. A name that is not one does nothing. */
export function ensureSiteSession (partition: string): void {
  if (isProfilePartition(partition)) ensurer?.(partition)
}

/** The profile a session name stands for, or undefined for any other session. */
export function siteProfileOf (partition: string | undefined): Profile | undefined {
  return profileOfPartition(partition)
}
