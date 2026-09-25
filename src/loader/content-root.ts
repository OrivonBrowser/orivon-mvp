// One bundle, one root: every request of a load from a content-addressed
// origin names the root CID the load began with, and the server refuses a
// request once the name points elsewhere. Without it, a name updated while a
// bundle downloads would pin files from two releases under one hash. Each
// request also names the verifier cache it may use: the origin's own, the
// one its tab would use (A256).

import type { Fetch } from './fetch-budget.js'

/** The request header the verifier's loopback server checks against the root it is serving. */
export const CONTENT_ROOT_HEADER = 'x-orivon-content-root'

/**
 * The top-level page origin a request to the verifier belongs to. The
 * verifier keeps one cache per value, so no site can time what another
 * opened. The shell sets it on every page's request; a request without it
 * shares nothing.
 */
export const PARTITION_HEADER = 'x-orivon-partition'

export function pinnedToRoot (fetch: Fetch, cid: string | undefined, origin: string): Fetch {
  if (cid === undefined) return fetch
  return async (url, pinnedAddresses, signal, headers) => await fetch(url, pinnedAddresses, signal, { ...headers, [CONTENT_ROOT_HEADER]: cid, [PARTITION_HEADER]: origin })
}
