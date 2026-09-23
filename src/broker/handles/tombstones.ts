// What one origin's table remembers about handles and grants that are gone:
// how a recently-ended handle ended, and which grants were revoked. Both are
// bounded FIFO memories, split out of ./handle-store.ts (code-guidelines.md
// Rule 2) because they are one concern -- a tombstone and its eviction rule.

import { LIMITS } from '../../contracts/index.js'
import type { CloseReason } from './handle-contracts.js'

/**
 * How many recently-ended ids an origin remembers, so that using a handle it
 * no longer holds answers 'closed' or 'revoked' rather than 'denied', and so
 * that closing twice is a no-op rather than an error.
 *
 * BOUNDED on purpose: an unbounded set of dead ids is a memory leak an app
 * drives by opening and closing in a loop. The bound is the sum of the two
 * per-kind budgets -- large enough that an origin operating inside its limits
 * always recognises an id it just closed, and derived from the specification's
 * own numbers rather than invented. Past the bound the answer degrades to
 * 'denied', which is the safe direction.
 */
export const CLOSED_ID_MEMORY = LIMITS.concurrentSockets + LIMITS.concurrentFileHandles

/**
 * How many revoked grant ids an origin remembers, so that an acquisition which
 * lands after the cascade has swept is refused rather than registered.
 *
 * BOUNDED for the same reason CLOSED_ID_MEMORY is, and to the same derived
 * value. Past the bound the oldest tombstone is forgotten, which fails OPEN --
 * so the bound has to exceed any plausible number of grants one origin holds.
 * It does, by two orders of magnitude: a Grant is keyed on (origin, capability,
 * pattern set) over six capability kinds (manifest.ts's `CapabilityKind`).
 */
export const REVOKED_GRANT_MEMORY = LIMITS.concurrentSockets + LIMITS.concurrentFileHandles

/** Drops the oldest entry once `memory` is at `bound`. Sets and Maps iterate in insertion order, so the first key is oldest. */
export function makeRoom<T> (memory: Set<T> | Map<T, unknown>, bound: number): void {
  if (memory.size < bound) return
  const oldest = memory.keys().next()
  if (oldest.done !== true) memory.delete(oldest.value)
}

/** Adds `value` to a bounded FIFO memory, evicting the oldest entry first if it is full. */
export function remember<T> (memory: Set<T>, value: T, bound: number): void {
  if (memory.has(value)) return
  makeRoom(memory, bound)
  memory.add(value)
}

/**
 * How a handle ended, as its owner is told on a later operation: 'revoked'
 * when a grant or the session was withdrawn from under it, 'closed' for
 * everything the app or the resource itself ended.
 */
export type EndedAs = 'closed' | 'revoked'

export function endedAs (reason: CloseReason): EndedAs {
  return reason === 'revoked' || reason === 'sessionEnded' ? 'revoked' : 'closed'
}
