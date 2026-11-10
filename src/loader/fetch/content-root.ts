// One bundle, one root: every request of a load from a content-addressed
// origin names the root CID the load began with, and the server refuses a
// request once the name points elsewhere. Without it, a name updated while a
// bundle downloads would pin files from two releases under one hash.

import type { Fetch } from './budget.js'

/** The request header the verifier's loopback server checks against the root it is serving. */
export const CONTENT_ROOT_HEADER = 'x-orivon-content-root'

/** Set by the verifier on an answer that proves the content is not what its name or address names (`unverifiable`), and on no other: a gateway's outage reads as `unavailable`. */
export const FAILURE_HEADER = 'x-orivon-failure'

/** The failure a request fails with when the file it named is not the file the app's declared tree says it is (`EXPECT_LEAF_HEADER`). */
export const DDOC_MISMATCH = 'ddoc-mismatch'

/**
 * The leaf (`sha256:<hex>`) the app's declared tree gives the file this request names. The verifier buffers that
 * one file, hashes it with the loader's own leaf function and sends none of it unless the two agree.
 */
export const EXPECT_LEAF_HEADER = 'x-orivon-expect-leaf'

/**
 * The top-level page origin a request to the verifier belongs to. The
 * verifier keeps one cache per value, so no site can time what another
 * opened. Only the shell sets it, from a page's frame; the loader's own
 * requests need none, since the verifier gives a request no page started
 * the name's own partition, the one its tab uses.
 */
export const PARTITION_HEADER = 'x-orivon-partition'

/**
 * Set by the main process on a read it makes of a host the verifier serves, for its own purposes (`own-read.ts`): the
 * value is a secret chosen at random for the run, and a request that carries it is answered by the verifier and never handed to the
 * shell's handler for that host, which may be the very code making the read.
 */
export const OWN_READ_HEADER = 'x-orivon-own-read'

/**
 * Set to `1` by the verifier's server, and by nothing else, on every response the shell answered for a request it relayed: the
 * shell's own headers never carry it (the server drops a copy the shell wrote, and an upstream's headers are never copied to a
 * response), so a document that has it was answered by the shell's handler and by no gateway or network page.
 */
export const SHELL_ANSWERED_HEADER = 'x-orivon-shell-answered'

/**
 * Set to `tunnel` on every request a website session of the tunnel profile makes to the verifier, and stripped from
 * every other: the verifier then reads and proves the name through the tunnel and nowhere else.
 */
export const ROUTE_HEADER = 'x-orivon-route'

export function pinnedToRoot (fetch: Fetch, cid: string | undefined): Fetch {
  if (cid === undefined) return fetch
  return async (url, pinnedAddresses, signal, headers) => await fetch(url, pinnedAddresses, signal, { ...headers, [CONTENT_ROOT_HEADER]: cid })
}
