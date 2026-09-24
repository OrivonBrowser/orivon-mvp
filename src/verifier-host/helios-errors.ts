// What Helios's errors mean for a resolution. It throws plain Errors whose
// text is all there is to go on; the strings matched here are the ones the
// light-client spike recorded from helios 0.11.1.

import { ResolutionError } from '../resolution/records.js'

const REVERT = /execution reverted:?\s*(?:0x)?([0-9a-f]*)\s*$/i
const FAILED_PROOF = /invalid (?:storage |account |code )?proof|proof (?:mismatch|verification failed)|invalid (?:block|header|state root)/i
const OUT_OF_SYNC = /out of sync/i

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
  if (FAILED_PROOF.test(message)) return new ResolutionError('unverifiable', `the light client refused an answer: ${message}`)
  if (OUT_OF_SYNC.test(message)) return new ResolutionError('not-synced', message)
  return error
}
