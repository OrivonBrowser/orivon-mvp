// Blocks from trustless gateways, each hashed against its CID before any of
// it is returned. What the exporter reads is only ever what this file
// returned, so every link it walks is verified. The actual gateway
// scheduling (hedging, passes, cooldowns) lives in block-fetch.ts; this
// file owns the cache and the in-flight sharing in front of it.

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { fetchVerifiedBlock } from './block-fetch.js'
import type { FetchDeps } from './block-fetch.js'
import type { Fetch, GatewayPool } from './gateways.js'
import type { IpfsLimits } from './limits.js'

const CACHE_BYTES = 64 * 1024 * 1024

/**
 * One fetch, shared by every caller that asks for the same key before it
 * settles -- `start` runs at most once, no matter how many `join`.
 *
 * A joiner's OWN `signal` races against the shared result: if it aborts
 * first, `join` rejects for that caller alone, and only when the LAST
 * joiner has left this way does the underlying fetch actually stop
 * (`start`'s own signal aborts). Every remaining joiner still gets the
 * refusals a lying gateway earned, whichever joiner's request happened to
 * trigger the fetch that caught it.
 */
export class SharedFetch {
  private readonly controller = new AbortController()
  private readonly refusals: Refusal[] = []
  private liveJoiners = 0
  private settled = false
  private readonly result: Promise<Uint8Array>

  constructor (
    start: (signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<Uint8Array>,
    private readonly onSettled: () => void
  ) {
    this.result = start(this.controller.signal, (refusal) => { this.refusals.push(refusal) })
    // Always observed, whatever happens: a fetch every joiner has already
    // left (aborted) still needs its rejection caught here, or it becomes
    // an unhandled rejection in the process that started it.
    this.result.then(
      () => { this.settled = true; this.onSettled() },
      () => { this.settled = true; this.onSettled() }
    )
  }

  async join (signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Uint8Array> {
    // Checked before subscribing, not only via the 'abort' listener below --
    // adding a listener to a signal that has ALREADY fired never calls it
    // (the event already happened), so a caller joining with a signal that
    // was aborted moments earlier would otherwise wait out the full shared
    // fetch instead of giving up immediately, as this method's own contract
    // promises.
    if (signal.aborted) throw signal.reason
    this.liveJoiners++
    try {
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        const onAbort = (): void => { reject(signal.reason) }
        signal.addEventListener('abort', onAbort, { once: true })
        this.result.then(
          (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
          (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) }
        )
      })
      for (const refusal of this.refusals) onRefusal(refusal)
      return bytes
    } finally {
      this.liveJoiners--
      if (this.liveJoiners === 0 && !this.settled) this.controller.abort(signal.reason)
    }
  }
}

/** Where verified blocks are kept between requests, keyed by partition as
 * well as CID, and where an in-flight fetch for one is shared. */
export interface BlockMemory {
  remember: (partition: string, key: string, block: Uint8Array) => void
  recall: (partition: string, key: string) => Uint8Array | undefined
  /** The in-flight fetch for `key` in `partition`, starting one with
   * `start` if none is already running. */
  share: (partition: string, key: string, start: (signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<Uint8Array>) => SharedFetch
}

/** For a mount with no partition: it keeps nothing and shares nothing, so
 * nothing it fetched can be timed later, and two callers never join the
 * same fetch across two such mounts either (A256 needs a real partition to
 * key on; two unpartitioned mounts have none in common by construction). */
export const NO_BLOCK_MEMORY: BlockMemory = {
  remember: () => {},
  recall: () => undefined,
  share: (_partition, _key, start) => new SharedFetch(start, () => {})
}

/**
 * Verified blocks, least recently used dropped first, keyed by partition as
 * well as CID: a block one site's pages fetched answers another site's
 * request no faster, so its timing tells that site nothing (A256). The same
 * partitioning applies to in-flight sharing, for the same reason.
 */
export class BlockCache implements BlockMemory {
  private readonly blocks = new Map<string, Uint8Array>()
  private readonly inFlight = new Map<string, SharedFetch>()
  private bytes = 0

  remember (partition: string, key: string, block: Uint8Array): void {
    if (block.length > CACHE_BYTES) return
    this.blocks.set(`${partition}\n${key}`, block)
    this.bytes += block.length
    for (const [oldest, old] of this.blocks) {
      if (this.bytes <= CACHE_BYTES) break
      this.blocks.delete(oldest)
      this.bytes -= old.length
    }
  }

  recall (partition: string, key: string): Uint8Array | undefined {
    const id = `${partition}\n${key}`
    const block = this.blocks.get(id)
    if (block === undefined) return undefined
    this.blocks.delete(id)
    this.blocks.set(id, block)
    return block
  }

  share (partition: string, key: string, start: (signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<Uint8Array>): SharedFetch {
    const id = `${partition}\n${key}`
    const existing = this.inFlight.get(id)
    if (existing !== undefined) return existing
    const fetch = new SharedFetch(start, () => { this.inFlight.delete(id) })
    this.inFlight.set(id, fetch)
    return fetch
  }
}

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
