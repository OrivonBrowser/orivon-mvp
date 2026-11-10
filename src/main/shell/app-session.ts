// Which session an allowed app runs in: its own partition, or where a website at its origin runs. The one answer every
// reader of "does this app have a partition of its own" asks (`tab-partition.ts`, `../sessions/session-attribution.ts`,
// the block, the extensions' reach, the routes), so that none decides it a second time.
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { isRelayable } from '../verifier/shell-serves.js'

/**
 * Whether the allowed app at `origin` runs where a website at its address runs, with a website's session, tunnel and identity:
 * the verifier hands the shell the requests that are the site's own, which answers with the app's own handler
 * (`../verifier/shell-serves.ts`), so a session that websites run in can serve the kept copy. That session is the shared one,
 * or the profile of the tunnel the site has an entry for (`./tab-partition.ts`).
 */
export function runsAsWebsite (origin: string): boolean {
  return isOriginServedFromCacheSync(origin) && couldRunAsWebsite(origin)
}

/** Whether the allowed app at `origin` would run as a website once the shell serves it: `runsAsWebsite` without the serving. */
export function couldRunAsWebsite (origin: string): boolean {
  return isRelayable(origin)
}

/** Whether the allowed app at `origin` runs in a partition of its own: every served origin the shared session cannot serve. */
export function hasOwnPartition (origin: string): boolean {
  return isOriginServedFromCacheSync(origin) && !runsAsWebsite(origin)
}

/** The partition of its own the allowed app at `origin` runs in, or undefined when it has none: it then runs where a website does, in the session `site-routes.ts` names. */
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

/**
 * Whether the page at `url`, in a view built with or without the app-tab flag, is a website's page at an origin that has become an
 * app running where websites run: it was open when the person allowed the site, and nothing the shell checked ever ran in it.
 * A page of an app in a view that has the flag, and a page at any other origin, are not.
 */
export function isWebsitePageOfApp (url: string, viewHasAppTabFlag: boolean): boolean {
  if (viewHasAppTabFlag) return false
  const origin = originFromUrl(url)
  return origin !== null && runsAsWebsite(origin)
}
