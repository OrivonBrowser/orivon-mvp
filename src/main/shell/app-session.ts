// Which session an allowed app runs in: its own partition, or where a website at its origin runs. The one answer every
// reader of "does this app have a partition of its own" asks (`tab-partition.ts`, `../sessions/session-attribution.ts`,
// the block, the extensions' reach), so that none decides it a second time.
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { sharedSessionRoutesLike } from '../route/site-routes.js'
import { isRelayable } from '../verifier/shell-serves.js'

/**
 * Whether the allowed app at `origin` runs in the shared session, as a website does. That needs two things: the verifier
 * hands the shell the requests that are the site's own, which answers with the app's own handler
 * (`../verifier/shell-serves.ts`), so the shared session can serve the kept copy; and the shared session sends the app as
 * its own route would, which a tunnel entry of the app's own is not (the app's reads leave by its own route).
 */
export function runsAsWebsite (origin: string): boolean {
  return isOriginServedFromCacheSync(origin) && couldRunAsWebsite(origin)
}

/** Whether the allowed app at `origin` would run in the shared session once the shell serves it: `runsAsWebsite` without the serving. */
export function couldRunAsWebsite (origin: string): boolean {
  return isRelayable(origin) && sharedSessionRoutesLike(origin)
}

/** Whether the allowed app at `origin` runs in a partition of its own: every served origin the shared session cannot serve. */
export function hasOwnPartition (origin: string): boolean {
  return isOriginServedFromCacheSync(origin) && !runsAsWebsite(origin)
}

/** The session the allowed app at `origin` runs in: undefined for the shared one, else the app's own partition. */
export function appSessionPartition (origin: string): string | undefined {
  return hasOwnPartition(origin) ? partitionFor(origin) : undefined
}

/**
 * Whether the allowed app at `origin` is answered with no verifier host running: served from its pin, in a partition of its
 * own. An app that runs where websites run reaches the host for every request, pinned or not, so its tab keeps the host awake.
 */
export function needsNoVerifierHost (origin: string): boolean {
  return isOriginPinnedSync(origin) && hasOwnPartition(origin)
}
