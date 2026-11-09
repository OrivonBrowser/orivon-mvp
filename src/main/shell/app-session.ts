// Which session an allowed app runs in: its own partition, or where a website at its origin runs. The one answer every
// reader of "does this app have a partition of its own" asks (`tab-partition.ts`, `../sessions/session-attribution.ts`,
// the block, the extensions' reach), so that none decides it a second time.
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { sharedSessionRoutesLike } from '../route/site-routes.js'
import { isRelayable } from '../verifier/shell-serves.js'

/**
 * Whether the allowed app at `origin` runs in the shared session, as a website does. That needs two things: the verifier
 * hands every request for the host to the shell, which answers with the app's own handler (`../verifier/shell-serves.ts`),
 * so the shared session can serve the kept copy; and the shared session sends the app as its own route would, which a
 * tunnel entry of the app's own is not (a tunnel profile's requests are never handed to the shell, and the app's reads
 * leave by its own route).
 */
export function runsAsWebsite (origin: string): boolean {
  return isOriginServedFromCacheSync(origin) && isRelayable(origin) && sharedSessionRoutesLike(origin)
}

/** Whether the allowed app at `origin` runs in a partition of its own: every served origin the shared session cannot serve. */
export function hasOwnPartition (origin: string): boolean {
  return isOriginServedFromCacheSync(origin) && !runsAsWebsite(origin)
}

/** The session the allowed app at `origin` runs in: undefined for the shared one, else the app's own partition. */
export function appSessionPartition (origin: string): string | undefined {
  return hasOwnPartition(origin) ? partitionFor(origin) : undefined
}
