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
/** Helios's whole failure for a newest block older than its clock allows, nothing quoted around it; the number is how many seconds old the block is. */
const HEAD_TOO_OLD = /^(?:Error: )?(?:sync failed: )?out of sync: (\d+) seconds behind\s*$/i

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

/** How many seconds old Helios found the newest block, when it refused it as older than its clock allows: a clock that is ahead, or a server behind the chain. */
export function outOfSync (error: unknown): number | undefined {
  const match = HEAD_TOO_OLD.exec(error instanceof Error ? error.message : String(error))
  return match === null ? undefined : Number(match[1])
}

/** Helios's failure when the consensus server answers 404 to the bootstrap request: the checkpoint it was given is not one that server starts a light client from. A 404 of any other request, and a failed request, are not it. */
const BOOTSTRAP_MISSING = /could not fetch bootstrap:.*status: 404/s

/** Whether Helios failed to start because the consensus server has no bootstrap for the checkpoint it was given. */
export function bootstrapMissing (error: unknown): boolean {
  return BOOTSTRAP_MISSING.test(error instanceof Error ? error.message : String(error))
}

/** What Settings and a .eth error page say when the clock stands in the way and the servers' time could not be used to allow for it. */
export const CLOCK_BEHIND_REASON = "this computer's clock is behind, so the chain's newest blocks look as if they come from the future. Setting the clock right, in the system's date and time settings, lets the light client start"

/** What Settings and a .eth error page say when the newest block looks too old and the servers' time could not be used to tell why. */
export const CLOCK_AHEAD_REASON = "the newest block looks too old by this computer's clock, which may be set ahead of the chain's. If it is, setting the clock right, in the system's date and time settings, lets the light client start"

/** What they say when the servers agree this computer's clock is right, so the old block is a server's. */
export function serverBehindReason (seconds: number): string {
  return `the newest block the servers gave is ${String(seconds)} seconds old, though this computer's clock agrees with theirs, so a server is behind the chain`
}
