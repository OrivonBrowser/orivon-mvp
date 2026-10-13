// The sessions a website can run in besides the default one, named from the website's own tunnel entry. Pure.
//
// A website with an `on` entry runs in the tunnel profile and one with an `off` entry in the direct profile: one session
// each, shared by every website that has that entry, so the person's extensions load once in each and not once per site.
// Both are kept across restarts (`persist:`). An origin that may not be written to disk (plain http) gets the same
// profile in a session with no `persist:` prefix, which Electron keeps in memory only.

import { isLoopbackHost, isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import type { TunnelEntry } from './route-state.js'

/** Which profile an entry puts a website in: `tunnel` for `on`, `direct` for `off`. */
export type Profile = 'tunnel' | 'direct'

export const PROFILES: readonly Profile[] = ['tunnel', 'direct']

/** The profile a website's own entry calls for, or undefined for a website that follows the default session. */
export function profileOf (entry: TunnelEntry | undefined): Profile | undefined {
  return entry === undefined ? undefined : entry === 'on' ? 'tunnel' : 'direct'
}

const NAME = (profile: Profile): string => `${profile}-profile`
const MEMORY = (profile: Profile): string => `${profile}-profile-memory`

/** The session name of `profile`, kept on disk or, for an origin that may not be written to disk, in memory. */
export function profilePartition (profile: Profile, persistable: boolean): string {
  return persistable ? `persist:${NAME(profile)}` : MEMORY(profile)
}

/** The session name for the website at `origin` when its entry puts it in `profile`. */
export function profilePartitionFor (profile: Profile, origin: string): string {
  return profilePartition(profile, isPersistableOrigin(origin))
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
