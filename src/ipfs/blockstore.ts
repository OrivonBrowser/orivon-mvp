// Blocks from trustless gateways, each hashed against its CID before any of
// it is returned. What the exporter reads is only ever what this file
// returned, so every link it walks is verified.

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { GatewayPool, TooLarge, readCapped } from './gateways.js'
import type { Fetch } from './gateways.js'
import type { IpfsLimits } from './limits.js'
import { BlockRefused, checkCidAccepted, inlineBlock, verifyBlock } from './verify-block.js'

const CACHE_BYTES = 64 * 1024 * 1024

/**
 * Verified blocks, least recently used dropped first, keyed by partition as
 * well as CID: a block one site's pages fetched answers another site's
 * request no faster, so its timing tells that site nothing (A256).
 */
export class BlockCache {
  private readonly blocks = new Map<string, Uint8Array>()
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
}

export class BlockSource {
  constructor (
    private readonly fetch: Fetch,
    private readonly pool: GatewayPool,
    readonly limits: IpfsLimits,
    private readonly cache: BlockCache = new BlockCache(),
    private readonly partition = ''
  ) {}

  private remember (key: string, bytes: Uint8Array): void {
    this.cache.remember(this.partition, key, bytes)
  }

  private recall (key: string): Uint8Array | undefined {
    return this.cache.recall(this.partition, key)
  }

  private async fetchRaw (gateway: string, cid: CID, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetch(`${gateway}/ipfs/${cid.toString()}?format=raw`, {
      headers: { accept: 'application/vnd.ipld.raw' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.limits.blockTimeoutMs)])
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${gateway} answered ${String(response.status)}`)
    }
    return await readCapped(response, this.limits.maxBlockBytes)
  }

  /** Throws a ResolutionError: `unverifiable` when a source lied or the block breaks a limit, `unavailable` when none answered. */
  async get (cid: CID, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Uint8Array> {
    const key = cid.toString()
    try {
      checkCidAccepted(cid)
    } catch (error) {
      throw new ResolutionError('unsupported', (error as Error).message)
    }
    const inline = inlineBlock(cid)
    if (inline !== undefined) {
      await this.verifyOrThrow(cid, inline)
      return inline
    }
    const cached = this.recall(key)
    if (cached !== undefined) return cached

    const gateways = this.pool.usable()
    // The pool is never configured empty, so an empty list means every gateway lied.
    if (gateways.length === 0) throw new ResolutionError('unverifiable', `block ${key}: every gateway was dropped this session for sending bytes that failed their hash`)
    const reasons: string[] = []
    let lied = false
    for (const gateway of gateways) {
      if (signal.aborted) throw new ResolutionError('unavailable', 'aborted')
      let bytes: Uint8Array
      try {
        bytes = await this.pool.withSlot(async () => await this.fetchRaw(gateway, cid, signal))
      } catch (error) {
        reasons.push(error instanceof TooLarge ? `${gateway} sent more than a block may be` : `${gateway}: ${(error as Error).message}`)
        continue
      }
      try {
        await verifyBlock(cid, bytes, this.limits)
      } catch (error) {
        if (!(error instanceof BlockRefused) || error.reason !== 'mismatch') throw this.limitFailure(error)
        lied = true
        onRefusal({ source: gateway, resource: key })
        this.pool.drop(gateway)
        reasons.push(`${gateway} sent a block that does not hash to its CID`)
        continue
      }
      this.remember(key, bytes)
      return bytes
    }
    throw new ResolutionError(lied ? 'unverifiable' : 'unavailable', `block ${key}: ${reasons.join('; ')}`)
  }

  private async verifyOrThrow (cid: CID, bytes: Uint8Array): Promise<void> {
    try {
      await verifyBlock(cid, bytes, this.limits)
    } catch (error) {
      throw this.limitFailure(error)
    }
  }

  /** A block that hashed correctly but breaks a limit or a format: no other source can do better. */
  private limitFailure (error: unknown): ResolutionError {
    const message = error instanceof Error ? error.message : String(error)
    const unsupported = error instanceof BlockRefused && (error.reason === 'codec' || error.reason === 'hash-function')
    return new ResolutionError(unsupported ? 'unsupported' : 'unverifiable', message)
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
