// Bounds on what a Swarm site may cost. Hitting one is an error, never a
// truncated success.

export interface SwarmLimits {
  readonly maxBytesPerOpen: number
  /** Levels of intermediate chunks above a file's leaves. */
  readonly maxTreeDepth: number
  /** One Mantaray node, which is stored as a file. */
  readonly maxManifestNodeBytes: number
  /** Manifest nodes read to resolve one path. */
  readonly maxNodesPerLookup: number
  /** Feeds followed from a name to its content. */
  readonly maxPointerHops: number
  /** SOC probes spent finding the newest update of one feed. */
  readonly maxFeedProbes: number
  readonly chunkTimeoutMs: number
  /** Per endpoint, so a hung one cannot starve the others of their own slots. */
  readonly perEndpointConcurrency: number
  /** How long the first attempt runs alone before a second endpoint is asked for the same chunk. */
  readonly hedgeDelayMs: number
}

export const DEFAULT_LIMITS: SwarmLimits = {
  maxBytesPerOpen: 1024 * 1024 * 1024,
  maxTreeDepth: 8,
  maxManifestNodeBytes: 1024 * 1024,
  maxNodesPerLookup: 256,
  maxPointerHops: 4,
  maxFeedProbes: 64,
  chunkTimeoutMs: 30_000,
  perEndpointConcurrency: 6,
  hedgeDelayMs: 1_500
}
