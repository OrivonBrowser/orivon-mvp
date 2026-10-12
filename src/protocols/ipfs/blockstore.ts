// Blocks from trustless gateways, each hashed against its CID before any of
// it is returned. What the exporter reads is only ever what this file
// returned, so every link it walks is verified. The actual gateway
// scheduling (hedging, passes, cooldowns) lives in block-fetch.ts; the cache
// and the in-flight sharing in front of it are ../gateways/cache.ts.

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { fetchVerifiedBlock } from './block-fetch.js'
import type { FetchDeps } from './block-fetch.js'
import { BlockCache } from '../gateways/cache.js'
import type { BlockMemory } from '../gateways/cache.js'
import type { Fetch, GatewayPool } from '../gateways/gateways.js'
import type { IpfsLimits } from './limits.js'

export class BlockSource {
  constructor (
    private readonly fetch: Fetch,
    private readonly pool: GatewayPool,
    readonly limits: IpfsLimits,
    private readonly cache: BlockMemory = new BlockCache(),
    private readonly partition = ''
  ) {}

  /** Throws a ResolutionError: `unsupported` for a CID this build cannot
   * verify at all, `unverifiable` once a gateway has lied or a block
   * breaks a limit, `unavailable` when none answered. */
  async get (cid: CID, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Uint8Array> {
    const key = cid.toString()
    const cached = this.cache.recall(this.partition, key)
    if (cached !== undefined) return cached

    const deps: FetchDeps = { fetch: this.fetch, pool: this.pool, limits: this.limits }
    const shared = this.cache.share(this.partition, key, async (sharedSignal, sharedOnRefusal) => {
      const bytes = await fetchVerifiedBlock(cid, deps, sharedSignal, sharedOnRefusal)
      this.cache.remember(this.partition, key, bytes)
      return bytes
    })
    return await shared.join(signal, onRefusal)
  }
}

export interface OpenBudget {
  blocks: number
  bytes: number
}

/**
 * The exporter's view for one open: every `get` counts against the
 * open's block and byte limits, cache hits included, since a depth bomb
 * made of cached blocks costs the same walk.
 */
export function blockstoreFor (source: BlockSource, budget: OpenBudget, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): { get: (cid: CID) => AsyncGenerator<Uint8Array> } {
  return {
    async * get (cid: CID) {
      budget.blocks++
      if (budget.blocks > source.limits.maxBlocksPerOpen) throw new ResolutionError('unverifiable', `more than ${String(source.limits.maxBlocksPerOpen)} blocks for one request`)
      const bytes = await source.get(cid, signal, onRefusal)
      budget.bytes += bytes.length
      if (budget.bytes > source.limits.maxBytesPerOpen) throw new ResolutionError('unverifiable', `more than ${String(source.limits.maxBytesPerOpen)} bytes for one request`)
      yield bytes
    }
  }
}
