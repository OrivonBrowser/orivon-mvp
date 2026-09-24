// One bundle, one root: every request of a load from a content-addressed
// origin names the root CID the load began with, and the server refuses a
// request once the name points elsewhere. Without it, a name updated while a
// bundle downloads would pin files from two releases under one hash.

import type { Fetch } from './fetch-budget.js'

/** The request header the verifier's loopback server checks against the root it is serving. */
export const CONTENT_ROOT_HEADER = 'x-orivon-content-root'

export function pinnedToRoot (fetch: Fetch, cid: string | undefined): Fetch {
  if (cid === undefined) return fetch
  return async (url, pinnedAddresses, signal, headers) => await fetch(url, pinnedAddresses, signal, { ...headers, [CONTENT_ROOT_HEADER]: cid })
}
