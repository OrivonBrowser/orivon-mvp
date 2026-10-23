// What Helios's errors mean for a resolution. It throws plain Errors whose
// text is all there is to go on; the strings matched here are the ones the
// light-client spike recorded from helios 0.11.1.

import { ResolutionError } from '../../resolution/records.js'

/** Anchored at both ends: Helios quotes RPC error text inside other messages, and that text must never read as revert data. */
const REVERT = /^(?:Error: )?execution reverted:?\s*(?:0x)?([0-9a-f]*)\s*$/i
const FAILED_PROOF = /invalid (?:storage |account |code )?proof|proof (?:mismatch|verification failed)|invalid (?:block|header|state root)/i
const OUT_OF_SYNC = /out of sync/i
/** Helios's whole sync failure for an update signed in a slot this computer's clock has not reached, nothing quoted around it. */
const CLOCK_BEHIND = /^(?:Error: )?(?:sync failed: )?invalid timestamp\s*$/i

/**
 * A revert becomes the `{ code: 3, data }` shape viem reads revert data from,
 * so a CCIP-Read OffchainLookup and the Universal Resolver's own errors are
 * recognised. A proof that failed is `unverifiable`: something lied. Falling
 * behind the chain is `not-synced`. Anything else is rethrown as it came.
 */
export function heliosError (error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  const revert = REVERT.exec(message)
  if (revert !== null) return Object.assign(new Error('execution reverted'), { code: 3, data: `0x${revert[1]!.toLowerCase()}` })
  if (FAILED_PROOF.test(message)) return new ResolutionError('unverifiable', `the light client refused an answer: ${message}`, true)
  if (OUT_OF_SYNC.test(message)) return new ResolutionError('not-synced', message)
  return error
}

/** Whether Helios refused the sync because this computer's clock is behind the chain's. */
export function clockBehind (error: unknown): boolean {
  return CLOCK_BEHIND.test(error instanceof Error ? error.message : String(error))
}

/** What Settings and a .eth error page say when the clock stands in the way and the servers' time could not be used to allow for it. */
export const CLOCK_BEHIND_REASON = "this computer's clock is behind, so the chain's newest blocks look as if they come from the future. Setting the clock right, in the system's date and time settings, lets the light client start"
