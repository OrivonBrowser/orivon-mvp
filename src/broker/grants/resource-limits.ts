// An origin's resource ALLOWANCES -- how many concurrent sockets and how
// many filesystem bytes it may use at once. Split out of grant-ledger.ts
// (code-guidelines.md Rule 2) along the seam that file's own README.md
// design notes already named: this is a "how much may this origin use"
// question, a different concern from "what was this origin actually
// granted" (grant-persistence.ts) or "may this origin still install what it
// offers" (update-safety.ts), and none of the three ever need to share a
// comparison or a write path.
//
// Pure functions over the caller's own record, same shape as
// update-safety.ts and declined-consent.ts -- GrantLedger keeps the record
// and the public surface, this file keeps the rules.

import { LIMITS } from '../../contracts/index.js'
import type { Manifest } from '../../contracts/index.js'

/** The two fields of an origin's record this module reads and writes. `GrantLedger`'s own `OriginRecord` satisfies it structurally. */
export interface ResourceLimitsRecord {
  manifest: Manifest | undefined
  fsBytesUsed: number
}

/**
 * How many sockets this origin may hold at once: what its manifest declared
 * (`net.concurrentSockets`), clamped to `LIMITS.concurrentSockets`, or
 * `LIMITS.defaultConcurrentSockets` when it declared nothing.
 *
 * CLAMPED, not rejected, and the manifest validator deliberately accepts a
 * larger number for the same reason: changing the platform ceiling must
 * never turn an already-published manifest into an invalid one.
 *
 * Takes the record itself (possibly `undefined`, for an origin `GrantLedger`
 * has no row for yet) rather than an origin string, so merely asking about
 * an origin never creates a row for it -- `GrantLedger.socketAllowance`
 * reads via `#origins.get`, not `#record`, to preserve that.
 */
export function socketAllowance (record: ResourceLimitsRecord | undefined): number {
  const declared = record?.manifest?.capabilities.net?.concurrentSockets
  if (declared === undefined) return LIMITS.defaultConcurrentSockets
  return Math.min(declared, LIMITS.concurrentSockets)
}

/**
 * The quota check AND the reservation, as one synchronous step. Reading
 * the counter and only updating it later -- after an `await` -- lets every
 * concurrent caller observe the same pre-write value and all pass; the
 * ONLY thing that closes that gap is doing both in the same synchronous
 * turn, before anything yields to another call. No lock is needed for
 * that: JavaScript does not interleave two synchronous stretches of code,
 * only what sits either side of an `await`.
 *
 * Returns false, reserving nothing, when `bytes` would push the running
 * total over `quotaBytes`. Reserves unconditionally (and returns true)
 * when the origin has no declared quota -- `quotaBytes?: number` is
 * optional -- mirroring the old unconditional counter, so a quota added
 * to the manifest later still sees every byte written before it existed.
 *
 * The caller must call `releaseFsBytes` for whatever it reserved here if
 * the write does not end up landing.
 */
export function reserveFsBytes (record: ResourceLimitsRecord, bytes: number): boolean {
  const quotaBytes = record.manifest?.capabilities.fs?.quotaBytes
  if (quotaBytes !== undefined && record.fsBytesUsed + bytes > quotaBytes) return false
  record.fsBytesUsed += bytes
  return true
}

/** Adds bytes already on disk -- measured, not requested -- so no quota check applies. */
export function chargeFsBytes (record: ResourceLimitsRecord, bytes: number): void {
  record.fsBytesUsed += bytes
}

/**
 * Refunds a reservation `reserveFsBytes` made for a write that did not
 * land -- refused before the real I/O ran, or that I/O itself rejected.
 * Clamped at zero rather than trusted to balance exactly, so a mismatched
 * caller degrades to an over-strict quota instead of a negative counter
 * that would then let a future write past the real limit.
 */
export function releaseFsBytes (record: ResourceLimitsRecord, bytes: number): void {
  record.fsBytesUsed = Math.max(0, record.fsBytesUsed - bytes)
}
