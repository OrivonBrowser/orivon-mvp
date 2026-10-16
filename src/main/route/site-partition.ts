// The sessions a website can run in besides the default one, named from the website's own tunnel entry. Pure.
//
// A website whose entry is a tunnel runs in that tunnel's profile (Nym's, or the person's proxy's) and one with an `off`
// entry in the direct profile: one session each, shared by every website that has that entry, so the person's extensions
// load once in each and not once per site. All are kept across restarts (`persist:`). An origin that may not be written to disk (plain http) gets the same
// profile in a session with no `persist:` prefix, which Electron keeps in memory only.

import { isLoopbackHost, isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import type { TunnelEntry, TunnelKind } from './route-state.js'

/** Which profile an entry puts a website in: a tunnel's own for a tunnel, `direct` for `off`. */
export type Profile = TunnelKind | 'direct'

export const PROFILES: readonly Profile[] = ['nym', 'socks5', 'direct']

/** The profile a website's own entry calls for, or undefined for a website that follows the default session. */
export function profileOf (entry: TunnelEntry | undefined): Profile | undefined {
  return entry === undefined ? undefined : entry === 'off' ? 'direct' : entry
}

/** The tunnel a profile sends its websites through, or undefined for the direct profile. */
export function kindOfProfile (profile: Profile): TunnelKind | undefined {
  return profile === 'direct' ? undefined : profile
}

/** The profile's session name, without `persist:`. Nym's keeps the name it has always had, so the storage of the websites in it stays where it is. */
const NAMES: Readonly<Record<Profile, string>> = { nym: 'tunnel-profile', socks5: 'proxy-profile', direct: 'direct-profile' }
const NAME = (profile: Profile): string => NAMES[profile]
const MEMORY = (profile: Profile): string => `${NAME(profile)}-memory`

/** The session name of `profile`, kept on disk or, for an origin that may not be written to disk, in memory. */
export function profilePartition (profile: Profile, persistable: boolean): string {
  return persistable ? `persist:${NAME(profile)}` : MEMORY(profile)
}

/** The session name for the website at `origin` when its entry puts it in `profile`. */
export function profilePartitionFor (profile: Profile, origin: string): string {
  return profilePartition(profile, isPersistableOrigin(origin))
}

/**
 * The profile sessions a clear of site data must reach: the kept session of each profile some website has an entry in, and
 * the memory session of a profile only if `made` (the session names this run has made) holds it, so that a clear never makes
 * a session just to empty it.
 */
export function profilePartitionsToClear (hasEntries: (profile: Profile) => boolean, made: readonly string[]): string[] {
  const names: string[] = []
  for (const profile of PROFILES) {
    if (hasEntries(profile)) names.push(profilePartition(profile, true))
    if (made.includes(profilePartition(profile, false))) names.push(profilePartition(profile, false))
  }
  return names
}

/** The profile a session name stands for, or undefined for any other session. */
export function profileOfPartition (partition: string | undefined): Profile | undefined {
  if (partition === undefined) return undefined
  for (const profile of PROFILES) if (partition === `persist:${NAME(profile)}` || partition === MEMORY(profile)) return profile
  return undefined
}

/** Whether `partition` names one of the profile sessions. */
export function isProfilePartition (partition: string | undefined): boolean {
  return profileOfPartition(partition) !== undefined
}

/** Whether a website at `origin` can go through the tunnel: a web origin that is not this computer. */
export function canTunnel (origin: string): boolean {
  if (originFromUrl(origin) !== origin) return false
  return !isLoopbackHost(new URL(origin).hostname)
}
