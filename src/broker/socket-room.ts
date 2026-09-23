// A cheap look at the origin's socket count before an outbound dial.
// `HandleTable.acquire` stays the authority -- a concurrent dial can take the
// last slot between this look and the acquire -- but without it every dial
// past the allowance completes a TCP connect and, for connectSecure, a full
// TLS handshake with the remote host, only to be refused and torn down.

import type { HandleTable } from './handles/handles.js'
import { fail } from './errors.js'

/** Throws 'limit', in `acquire`'s own words, when the origin already holds `limit` sockets. Creates no table. */
export function assertSocketRoom (handleTable: HandleTable, origin: string, limit: number): void {
  if (handleTable.counts(origin).sockets >= limit) throw fail('limit', `origin holds ${String(limit)} sockets`)
}
