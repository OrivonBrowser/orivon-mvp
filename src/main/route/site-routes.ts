// What the shell reads to put a website in the session its tunnel entry calls for: main supplies the answer once, as
// `leaving-routes.ts` does, and a caller asks per navigation, so a switch flipped meanwhile is followed.

import { originFromUrl } from '../../broker/policy/origin.js'
import { canTunnel, isProfilePartition, kindOfProfile, profileOfPartition, profilePartitionFor } from './site-partition.js'
import type { Profile } from './site-partition.js'
import type { TunnelKind } from './route-state.js'
import { profileForTab } from './tab-tunnel.js'
import type { TabTunnelChoice } from './tab-tunnel.js'

export interface SiteRoutes {
  /** The profile the website at `origin` runs in (`RouteHub.profileFor`), or undefined for a website that follows the default session. */
  readonly profileFor: (origin: string) => Profile | undefined
  /**
   * Whether the website at `origin`, loaded in the session named `partition`, is sent as it would be in its own session:
   * a session that is not tunnelled, or goes through the other tunnel, for an address that has a tunnel gives no.
   */
  readonly sentLikeItsOwn?: (partition: string | undefined, origin: string) => boolean
  /** Records that the website at `origin` has storage in `profile` that stays until the person removes it: a website a tab's tunnel choice put there has no entry to say so. */
  readonly keepApart?: (origin: string, profile: Profile) => void
}

let source: SiteRoutes | undefined

/** Called once at start by whoever owns the routes. */
export function setSiteRoutes (next: SiteRoutes | undefined): void {
  source = next
}

/** The session the website at `origin` must run in when it is opened in a tab with `choice` (none: by its own entry alone), or undefined for the shared one. */
export function sitePartitionForTab (origin: string, choice: TabTunnelChoice | undefined): string | undefined {
  if (source === undefined || !canTunnel(origin)) return undefined
  const profile = profileForTab(choice, origin, source.profileFor(origin))
  return profile === undefined ? undefined : profilePartitionFor(profile, origin)
}

/** The session the website at `origin` must run in by its own entry, or undefined for the shared one. */
export function sitePartitionForOrigin (origin: string): string | undefined {
  return sitePartitionForTab(origin, undefined)
}

/** Records that the website at `origin` has storage in the profile a tab's choice put it in. Nothing before routes run. */
export function keepSiteApart (origin: string, profile: Profile): void {
  source?.keepApart?.(origin, profile)
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
  /** How the session sends: through the tunnel of the front it is pointed at, `held` when it is stopped or sets a proxy of its own that reaches nothing, undefined when it follows the system. */
  readonly via: TunnelKind | 'held' | undefined
  /** A session a routed app's page opened a website in "through my tunnel": any website may load there. */
  readonly temporary: boolean
}

/**
 * Whether a main-frame load of `url` in `session` must be cancelled because it belongs to another session and the shell did not
 * move it there first: a website with a profile in the shared session, and a website that is routed in a session that is not
 * (a direct profile, an app set to off, a session not yet pointed) or that goes through the other tunnel, which would reach it
 * without its tunnel. A load the shell moves is stopped before it starts (`../shell/pre-partition.ts`), so this only ever stops
 * what that move missed. `kindOf` is the tunnel an origin goes through, undefined when it is not routed. `choice` is the tunnel
 * choice of the tab that loads, when it has one: it decides the profile and the tunnel the website is judged against.
 */
export function mustLeaveSession (url: string, session: LoadingSession, servedFromCache: (origin: string) => boolean, kindOf: (origin: string) => TunnelKind | undefined, choice?: TabTunnelChoice): boolean {
  const origin = originFromUrl(url)
  if (origin === null || session.temporary || servedFromCache(origin)) return false
  if (session.shared && sitePartitionForTab(origin, choice) !== undefined) return true
  if (!canTunnel(origin)) return false
  const wanted = tunnelWanted(origin, kindOf, choice)
  return wanted !== undefined && session.via !== 'held' && session.via !== wanted
}

/** The tunnel a load of `origin` must leave by: the tab's tunnel choice, else the website's own; a `direct` choice asks for none unless the website has a tunnel of its own. */
function tunnelWanted (origin: string, kindOf: (origin: string) => TunnelKind | undefined, choice: TabTunnelChoice | undefined): TunnelKind | undefined {
  if (choice === undefined) return kindOf(origin)
  if (choice !== 'direct') return choice
  const own = source?.profileFor(origin)
  return own === undefined ? undefined : kindOfProfile(own)
}

let ensurer: ((partition: string, wake: boolean) => void) | undefined

/** Called once at start by whoever owns the routes: what makes a profile's session ready before a view is made in it. */
export function setSiteSessionEnsurer (next: ((partition: string, wake: boolean) => void) | undefined): void {
  ensurer = next
}

/**
 * Makes the profile session named `partition` ready for a view about to be made in it, or, with `wake` false, for a request
 * made in it with no view (a lookup): held on its route, with the person's extensions left as they are. A name that is not one does nothing.
 */
export function ensureSiteSession (partition: string, wake = true): void {
  if (isProfilePartition(partition)) ensurer?.(partition, wake)
}

/** The profile a session name stands for, or undefined for any other session. */
export function siteProfileOf (partition: string | undefined): Profile | undefined {
  return profileOfPartition(partition)
}

let made: (() => string[]) | undefined

/** Called once at start by whoever owns the routes: which profile sessions this run has made. */
export function setMadeSiteSessions (next: (() => string[]) | undefined): void {
  made = next
}

/** The names of the profile sessions made so far in this run; none before start. */
export function madeSiteSessions (): string[] {
  return made?.() ?? []
}
