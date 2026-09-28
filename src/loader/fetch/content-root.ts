// One bundle, one root: every request of a load from a content-addressed
// origin names the root CID the load began with, and the server refuses a
// request once the name points elsewhere. Without it, a name updated while a
// bundle downloads would pin files from two releases under one hash.

import type { Fetch } from './budget.js'

/** The request header the verifier's loopback server checks against the root it is serving. */
export const CONTENT_ROOT_HEADER = 'x-orivon-content-root'

/**
 * The top-level page origin a request to the verifier belongs to. The
 * verifier keeps one cache per value, so no site can time what another
 * opened. Only the shell sets it, from a page's frame; the loader's own
 * requests need none, since the verifier gives a request no page started
 * the name's own partition, the one its tab uses.
 */
export const PARTITION_HEADER = 'x-orivon-partition'

export function pinnedToRoot (fetch: Fetch, cid: string | undefined): Fetch {
  if (cid === undefined) return fetch
  return async (url, pinnedAddresses, signal, headers) => await fetch(url, pinnedAddresses, signal, { ...headers, [CONTENT_ROOT_HEADER]: cid })
}
