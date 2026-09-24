// Bounds on what a site's DAG may cost. Hitting one is an error, never a
// truncated success. Set with margin over what real sites measured: the
// largest block 318 KB, 289 links in one node, a file DAG six levels deep.

export interface IpfsLimits {
  /** The trustless gateway spec's own ceiling for one block. */
  readonly maxBlockBytes: number
  readonly maxLinksPerNode: number
  readonly maxBlocksPerOpen: number
  /** A file's DAG, counted from its root node. */
  readonly maxDagDepth: number
  readonly maxBytesPerOpen: number
  readonly blockTimeoutMs: number
  readonly gatewayConcurrency: number
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
  gatewayConcurrency: 8,
  maxPointerHops: 4
}
