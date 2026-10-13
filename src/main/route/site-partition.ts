// The session a website gets when its tunnel state differs from the browser's default, named from its origin. Pure.
//
// Kept across restarts (`persist:`) for an origin that may be written to disk; an origin that may not (plain http, a
// loopback name) gets the same name without the prefix, so Electron keeps that session in memory only.

import { originHash } from '../../broker/grants/origin-hash.js'
import { isLoopbackHost, isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'

const NAME = 'site-'
const DISK = `persist:${NAME}`

/** The session name for the website at `origin`. */
export function sitePartitionFor (origin: string): string {
  return `${isPersistableOrigin(origin) ? DISK : NAME}${originHash(origin)}`
}

/** Whether `partition` names a website's session of its own. */
export function isSitePartition (partition: string | undefined): boolean {
  return partition !== undefined && (partition.startsWith(DISK) || partition.startsWith(NAME))
}

/** Whether a website at `origin` can go through the tunnel: a web origin that is not this computer. */
export function canTunnel (origin: string): boolean {
  if (originFromUrl(origin) !== origin) return false
  return !isLoopbackHost(new URL(origin).hostname)
}
