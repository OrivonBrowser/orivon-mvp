// Bounds on what a site's DAG may cost. Hitting one is an error, never a
// truncated success. Set with margin over what real sites measured: the
// largest block 318 KB, 289 links in one node, a file DAG six levels deep.

import type { PatientRetry } from '../gateways/fetch-passes.js'

export interface IpfsLimits {
  /** The trustless gateway spec's own ceiling for one block. */
  readonly maxBlockBytes: number
  readonly maxLinksPerNode: number
  readonly maxBlocksPerOpen: number
  /** A file's DAG, counted from its root node. */
  readonly maxDagDepth: number
  readonly maxBytesPerOpen: number
  readonly blockTimeoutMs: number
  /** For a source that remembers a failed lookup: a block it could not give is asked for again after its memory has passed. Unset for public gateways, whose passes already retry. */
  readonly blockRetry?: PatientRetry
  /** The wait for one IPNS record from one source; `blockTimeoutMs` when unset. */
  readonly recordTimeoutMs?: number
  /** Per gateway, not a total shared across all of them -- a hung gateway
   * must not be able to starve the others of their own slots. */
  readonly perGatewayConcurrency: number
  /** The longest wait for the first attempt before starting a second,
   * different gateway for the same block -- a hedge, not a replacement:
   * the first attempt keeps running, and whichever verifies first wins.
   * A block fetch waits less once gateways have answered (`GatewayPool.hedgeDelay`). */
  readonly hedgeDelayMs: number
  /** IPNS and DNSLink hops from a name to its root. */
  readonly maxPointerHops: number
}

export const DEFAULT_LIMITS: IpfsLimits = {
  maxBlockBytes: 2 * 1024 * 1024,
  maxLinksPerNode: 10_000,
  maxBlocksPerOpen: 10_000,
  maxDagDepth: 64,
  maxBytesPerOpen: 1024 * 1024 * 1024,
  blockTimeoutMs: 30_000,
  perGatewayConcurrency: 4,
  hedgeDelayMs: 2_000,
  maxPointerHops: 4
}
