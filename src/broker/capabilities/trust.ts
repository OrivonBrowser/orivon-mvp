// orivon.trust's broker half (ADR-0058): the `trust.score` grant check and nothing else. The score lookup reads the
// person's settings and the network, which this layer never touches, so it runs in src/main/browsing/page-score-lookup.ts
// and the transport (../transport/dispatch/trust.ts) calls it only once this check has passed.

import { fail } from '../errors.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import type { Broker } from '../broker-contracts.js'

export interface TrustCapabilityOptions {
  readonly ledger: GrantLedger
  /** Origin normalisation plus the malformed-origin 'internal' throw: ../index.ts's own `canonical`. */
  readonly canonical: (origin: string) => string
}

export function createTrustCapability ({ ledger, canonical }: TrustCapabilityOptions): Broker['trust'] {
  return {
    // A denial carries no reason an app could use to probe the boundary.
    requireScoreGrant (origin) {
      if (ledger.currentGrant(canonical(origin), 'trust.score') === undefined) {
        throw fail('denied', 'trust.score is not granted to this origin')
      }
    }
  }
}
