// Operation scoring (ADR-0006's "Operation" ladder, generalised): counts and
// classifies what fs/net/id operations actually occurred. Pure, no I/O.
//
// DELIBERATELY DOES NOT PRE-COMPUTE A NARRATIVE CLAIM. ADR-0006's own worked
// example is "the app performed a Nostr signing operation via `orivon.id`,
// fully locally, with no server involved" -- but deciding that a given
// breakdown SUPPORTS that claim is exactly the kind of judgement the
// click-through contract (this lane's scope item 5) leaves to the UI: this
// module hands over the counts a UI needs to make that statement itself
// ("N `id` operations, zero `net` operations"), never the statement.

import type { CapabilityKind } from '../contracts/index.js'
import type { ConnectionLogEntry } from './connection-log.js'

export interface OperationScore {
  readonly surface: CapabilityKind
  readonly allowed: number
  /** Refused because the resolved address fell in a blocked range (T12). Always 0 for a surface with no address concept. */
  readonly blockedAddressRange: number
  readonly blockedPolicy: number
  readonly error: number
}

export interface OperationScoringResult {
  /** One entry per surface that appeared at least once -- a surface with zero observed operations is absent, not present with zero counts, so its absence cannot be misread as "checked and found clean". */
  readonly bySurface: readonly OperationScore[]
  readonly totalOperations: number
}

function emptyScore (surface: CapabilityKind): OperationScore {
  return { surface, allowed: 0, blockedAddressRange: 0, blockedPolicy: 0, error: 0 }
}

/** Counts and classifies observed operations by capability surface. See this file's header for what it deliberately does not conclude. */
export function scoreOperations (entries: readonly ConnectionLogEntry[]): OperationScoringResult {
  const bySurface = new Map<CapabilityKind, OperationScore>()

  for (const e of entries) {
    const score = bySurface.get(e.surface) ?? emptyScore(e.surface)
    switch (e.outcome) {
      case 'allowed':
        bySurface.set(e.surface, { ...score, allowed: score.allowed + 1 })
        break
      case 'blocked-address-range':
        bySurface.set(e.surface, { ...score, blockedAddressRange: score.blockedAddressRange + 1 })
        break
      case 'blocked-policy':
        bySurface.set(e.surface, { ...score, blockedPolicy: score.blockedPolicy + 1 })
        break
      case 'error':
        bySurface.set(e.surface, { ...score, error: score.error + 1 })
        break
    }
  }

  return { bySurface: Array.from(bySurface.values()), totalOperations: entries.length }
}
