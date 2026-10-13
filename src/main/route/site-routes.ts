// What the shell reads to put a website in the session its tunnel entry calls for: main supplies the answer once, as
// `leaving-routes.ts` does, and a caller asks per navigation, so a switch flipped meanwhile is followed.

import { originFromUrl } from '../../broker/policy/origin.js'
import { canTunnel, isProfilePartition, profileOfPartition, profilePartitionFor } from './site-partition.js'
import type { Profile } from './site-partition.js'

export interface SiteRoutes {
  /** The profile the website at `origin` runs in (`RouteHub.profileFor`), or undefined for a website that follows the default session. */
  readonly profileFor: (origin: string) => Profile | undefined
  /**
   * Whether the website at `origin`, loaded in the session named `partition`, is sent no less tunnelled than in its own session:
   * a session that is not tunnelled for an address that is gives no.
   */
  readonly sentLikeItsOwn?: (partition: string | undefined, origin: string) => boolean
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

/** `sentLikeItsOwn` for a web address: true when nothing is known (a test, a start-up not done) or the address has no origin the tunnel can carry. */
export function sessionRoutesLike (partition: string | undefined, url: string): boolean {
  const origin = originFromUrl(url)
  if (source?.sentLikeItsOwn === undefined || origin === null || !canTunnel(origin)) return true
  return source.sentLikeItsOwn(partition, origin)
}

/** What a guard on a session knows of it when a main-frame load starts there. */
export interface LoadingSession {
  /** The default session, which a website that has a profile must never load in. */
  readonly shared: boolean
  /** Whether the session is pointed at a front (or held shut), or sets a proxy of its own that reaches nothing. */
  readonly tunnelled: boolean
  /** A session a routed app's page opened a website in "through my tunnel": any website may load there. */
  readonly temporary: boolean
}

/**
 * Whether a main-frame load of `url` in `session` must be cancelled because it belongs to another session and the shell did not
 * move it there first: a website with a profile in the shared session, and a website that is routed in a session that is not
 * (a direct profile, an app set to off, a session not yet pointed), which would reach it without the tunnel. A load the shell
 * moves is stopped before it starts (`../shell/pre-partition.ts`), so this only ever stops what that move missed.
 */
export function mustLeaveSession (url: string, session: LoadingSession, servedFromCache: (origin: string) => boolean, routed: (origin: string) => boolean): boolean {
  const origin = originFromUrl(url)
  if (origin === null || session.temporary || servedFromCache(origin)) return false
  if (session.shared && sitePartitionForOrigin(origin) !== undefined) return true
  return canTunnel(origin) && !session.tunnelled && routed(origin)
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
