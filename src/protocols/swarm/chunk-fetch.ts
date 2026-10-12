// One verified chunk from the endpoints, the only place a Swarm endpoint's
// bytes are read. An endpoint is trusted for availability only: a chunk is
// used after its address has been recomputed from the bytes, and an endpoint
// that sent bytes failing that is dropped for the session.

import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { BlockCache } from '../gateways/cache.js'
import type { BlockMemory } from '../gateways/cache.js'
import { failedAttempt, fetchAcrossGateways } from '../gateways/fetch-passes.js'
import { askGateway, readCapped } from '../gateways/gateways.js'
import type { Fetch, GatewayPool } from '../gateways/gateways.js'
import type { AttemptOutcome } from '../gateways/race.js'
import { MAX_CHUNK_BYTES, MAX_SOC_BYTES, verifyCac, verifySoc } from './chunk.js'
import type { VerifiedSoc } from './chunk.js'
import type { SwarmLimits } from './limits.js'

export interface ChunkDeps {
  readonly fetch: Fetch
  readonly pool: GatewayPool
  readonly limits: SwarmLimits
}

/** What a kind of chunk is checked against: its size cap, and a check returning what the bytes mean, or undefined when they are not the chunk at `address`. */
interface Acceptance<T> {
  readonly maxBytes: number
  readonly verify: (address: string, bytes: Uint8Array) => Promise<T | undefined> | T | undefined
}

async function attemptEndpoint<T> (endpoint: string, address: string, accept: Acceptance<T>, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void, unwell: Set<string>): Promise<AttemptOutcome<T>> {
  let bytes: Uint8Array
  try {
    bytes = await askGateway(
      deps.pool, deps.fetch, endpoint,
      { url: `${endpoint}/chunks/${address}`, accept: 'application/octet-stream', timeoutMs: deps.limits.chunkTimeoutMs },
      async (response) => await readCapped(response, accept.maxBytes),
      signal
    )
  } catch (error) {
    return failedAttempt(error, endpoint, unwell)
  }
  unwell.delete(endpoint)
  const verified = await accept.verify(address, bytes)
  if (verified === undefined) {
    onRefusal({ source: endpoint, resource: address })
    deps.pool.drop(endpoint)
    return { kind: 'lied', reason: `${endpoint} sent bytes that failed their address` }
  }
  return { kind: 'verified', value: verified }
}

async function fetchChunk<T> (address: string, accept: Acceptance<T>, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<T> {
  return await fetchAcrossGateways(`chunk ${address}`, { pool: deps.pool, hedgeDelayMs: deps.limits.hedgeDelayMs }, (endpoint, attemptSignal, unwell) => attemptEndpoint(endpoint, address, accept, deps, attemptSignal, onRefusal, unwell), signal)
}

const CAC: Acceptance<Uint8Array> = { maxBytes: MAX_CHUNK_BYTES, verify: (address, bytes) => verifyCac(address, bytes) ? bytes : undefined }
const SOC: Acceptance<VerifiedSoc> = { maxBytes: MAX_SOC_BYTES, verify: verifySoc }

/**
 * The single-owner chunk at `address`, verified. Throws a ResolutionError:
 * `unavailable` when no endpoint has it, which is how the end of a feed
 * shows, `unverifiable` once an endpoint sent a forgery.
 */
export async function fetchVerifiedSoc (address: string, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<VerifiedSoc> {
  return await fetchChunk(address, SOC, deps, signal, onRefusal)
}

/**
 * Verified content-addressed chunks, kept per partition and fetched once for
 * every caller that asks at the same time.
 */
export class ChunkSource {
  constructor (
    private readonly deps: ChunkDeps,
    private readonly memory: BlockMemory = new BlockCache(),
    private readonly partition = ''
  ) {}

  /** Throws a ResolutionError: `unverifiable` once an endpoint has lied, `unavailable` when none answered. */
  async get (address: string, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(address)) throw new ResolutionError('unverifiable', `${address} is not a chunk address`)
    const cached = this.memory.recall(this.partition, address)
    if (cached !== undefined) return cached
    const shared = this.memory.share(this.partition, address, async (sharedSignal, sharedOnRefusal) => {
      const bytes = await fetchChunk(address, CAC, this.deps, sharedSignal, sharedOnRefusal)
      this.memory.remember(this.partition, address, bytes)
      return bytes
    })
    return await shared.join(signal, onRefusal)
  }
}
