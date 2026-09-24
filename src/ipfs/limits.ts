// Bounds on what a site's DAG may cost. Hitting one is an error, never a
// truncated success. Provisional until measured against real sites.

export interface IpfsLimits {
  /** The trustless gateway spec's own ceiling for one block. */
  readonly maxBlockBytes: number
  readonly maxLinksPerNode: number
  /** Also what bounds a DAG's depth: a chain of single-link nodes costs one block per level. */
  readonly maxBlocksPerOpen: number
  readonly maxBytesPerOpen: number
  readonly blockTimeoutMs: number
  readonly gatewayConcurrency: number
  /** IPNS and DNSLink hops from a name to its root. */
  readonly maxPointerHops: number
}

export const DEFAULT_LIMITS: IpfsLimits = {
  maxBlockBytes: 2 * 1024 * 1024,
  maxLinksPerNode: 20_000,
  maxBlocksPerOpen: 20_000,
  maxBytesPerOpen: 1024 * 1024 * 1024,
  blockTimeoutMs: 30_000,
  gatewayConcurrency: 8,
  maxPointerHops: 4
}
