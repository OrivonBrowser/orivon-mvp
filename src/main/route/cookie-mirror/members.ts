import { isProfilePartition } from '../site-partition.js'

/**
 * Whether the session named `partition` is one the cookie mirror keeps in step with the default session: the kept (`persist:`)
 * session of a profile, in a process that is not a private window's. A profile kept in memory, an app's session, an internal
 * session and a temporary one are never part of it.
 */
export function joinsMirror (partition: string | undefined, isPrivate: boolean): boolean {
  return !isPrivate && partition !== undefined && partition.startsWith('persist:') && isProfilePartition(partition)
}
