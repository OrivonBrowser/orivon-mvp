// What an origin may hold in the broker and what it holds. Read by the loader's reach pool (the allowance) and by
// `orivon://report` (both), so a user's report shows an app that ran out of sockets and how far it was from its allowance.

import type { Manifest } from '../contracts/index.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import { socketAllowance } from './grants/resource-limits.js'
import type { SocketUsage } from './handles/handle-contracts.js'
import type { HandleTable } from './handles/handles.js'
import { isolationKeyFromUrl } from './policy/origin.js'

/**
 * `Broker.app.socketAllowanceSync`'s answer, never throwing. `GrantLedger.socketAllowance` already answers the
 * platform default for a row it holds nothing for, so a malformed `origin` (the raw string) still gets a safe number
 * rather than a broker fault. A restored app not yet re-registered answers from its pinned manifest's declaration.
 */
export function socketAllowanceOf (ledger: GrantLedger, pinnedManifests: ReadonlyMap<string, Manifest>, origin: string): number {
  const key = isolationKeyFromUrl(origin) ?? origin
  const pinned = ledger.manifestFor(key) === undefined ? pinnedManifests.get(key) : undefined
  return pinned === undefined ? ledger.socketAllowance(key) : socketAllowance({ manifest: pinned, fsBytesUsed: 0 })
}

/** `Broker.app.socketUsageSync`'s answer: the handle table's count for the origin's isolation key. A malformed origin has no table, so it holds nothing. */
export function socketUsageOf (handleTable: HandleTable, origin: string, allowance: number): SocketUsage {
  const key = isolationKeyFromUrl(origin)
  const counts = key === null ? undefined : handleTable.counts(key)
  return { open: counts?.sockets ?? 0, inFlight: counts?.inFlight ?? 0, allowance }
}
