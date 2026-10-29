// One verified chunk from the endpoints, the only place a Swarm endpoint's
// bytes are read. An endpoint is trusted for availability only: a chunk is
// used after its address has been recomputed from the bytes, and an endpoint
// that sent bytes failing that sits out for a while.

import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { BlockCache } from '../gateways/cache.js'
import type { BlockMemory } from '../gateways/cache.js'
import { failedAttempt, fetchAcrossGateways } from '../gateways/fetch-passes.js'
import { GatewayFailure, askGateway, readCapped } from '../gateways/gateways.js'
import type { Fetch, GatewayPool } from '../gateways/gateways.js'
import type { AttemptOutcome } from '../gateways/race.js'
import { MAX_CHUNK_BYTES, MAX_SOC_BYTES, SPAN_BYTES, verifySoc } from './chunk.js'
import type { VerifiedSoc } from './chunk.js'
import { CHECK_HERE } from './chunk-check.js'
import type { ChunkChecker } from './chunk-check.js'
import type { SwarmLimits } from './limits.js'
import type { NodeWait } from './node-wait.js'

export interface ChunkDeps {
  readonly fetch: Fetch
  readonly pool: GatewayPool
  readonly limits: SwarmLimits
  /** A line for the report log, naming no site or address. */
  readonly log?: (line: string) => void
  /** Where a content-addressed chunk is checked against its address. Unset, in the thread that asks. */
  readonly checker?: ChunkChecker
}

/** What a kind of chunk is checked against: its size cap, and a check returning what the bytes mean, or undefined when they are not the chunk at `address`. */
interface Acceptance<T> {
  readonly maxBytes: number
  readonly verify: (address: string, bytes: Uint8Array) => Promise<T | undefined> | T | undefined
}

const ADDRESS = /^[0-9a-f]{64}$/

/** How long an endpoint that sent a bad answer is not asked again. Swarm's usual endpoint is the one node on this machine, which a restart can make send a truncated answer once, so a lie costs it a pause, not the session. */
export const QUARANTINE_MS = 30_000

/** What each endpoint's latest answer to a lookup was: `absent` for a 404, `other` for anything that says nothing about whether the chunk exists. */
type Answers = Map<string, 'absent' | 'other'>

async function attemptEndpoint<T> (endpoint: string, address: string, accept: Acceptance<T>, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void, unwell: Set<string>, answers: Answers): Promise<AttemptOutcome<T>> {
  let bytes: Uint8Array
  try {
    bytes = await askGateway(
      deps.pool, deps.fetch, endpoint,
      { url: `${endpoint}/chunks/${address}`, accept: 'application/octet-stream', timeoutMs: deps.limits.chunkTimeoutMs, maxBytes: accept.maxBytes },
      async (response, progress) => await readCapped(response, accept.maxBytes, progress),
      signal
    )
  } catch (error) {
    if (error instanceof GatewayFailure && error.outcome.kind !== 'cancelled') answers.set(endpoint, error.outcome.kind === 'miss' && error.status === 404 ? 'absent' : 'other')
    return failedAttempt(error, endpoint, unwell)
  }
  answers.set(endpoint, 'other')
  unwell.delete(endpoint)
  const verified = await accept.verify(address, bytes)
  if (verified === undefined) {
    onRefusal({ source: endpoint, resource: address })
    deps.pool.quarantine(endpoint, QUARANTINE_MS)
    return { kind: 'lied', reason: `${endpoint} sent bytes that failed their address` }
  }
  return { kind: 'verified', value: verified }
}

async function fetchChunk<T> (address: string, accept: Acceptance<T>, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void, answers: Answers = new Map()): Promise<T> {
  return await fetchAcrossGateways(`chunk ${address}`, { pool: deps.pool, hedgeDelayMs: deps.limits.hedgeDelayMs }, (endpoint, attemptSignal, unwell) => attemptEndpoint(endpoint, address, accept, deps, attemptSignal, onRefusal, unwell, answers), signal)
}

function cacOf (deps: ChunkDeps): Acceptance<Uint8Array> {
  const checker = deps.checker ?? CHECK_HERE
  return { maxBytes: MAX_CHUNK_BYTES, verify: async (address, bytes) => await checker.verify(address, bytes) ? bytes : undefined }
}
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
 * The single-owner chunk at `address`, or undefined when every endpoint
 * said it does not have it (a 404 from each). Anything short of that, a
 * timeout, an unreachable or unwell endpoint, one cooling or one that was
 * never asked, is `unavailable`: it does not tell whether the chunk exists,
 * and a caller must not read it as the end of a feed.
 */
export async function lookUpSoc (address: string, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<VerifiedSoc | undefined> {
  const answers: Answers = new Map()
  try {
    return await fetchChunk(address, SOC, deps, signal, onRefusal, answers)
  } catch (error) {
    if (!(error instanceof ResolutionError) || error.failure !== 'unavailable') throw error
    const endpoints = deps.pool.usable()
    if (endpoints.length > 0 && endpoints.every((endpoint) => answers.get(endpoint) === 'absent')) return undefined
    throw new ResolutionError('unavailable', `no answer from the Swarm node about whether ${address} exists: ${error.message}`)
  }
}

/** A leaf of the subtree under one intermediate chunk: its address, the bytes its parent says it holds, and where they start in the subtree. */
export interface SubtreeLeaf {
  readonly address: string
  readonly size: number
  readonly offset: number
}

interface Pending<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function pending<T> (): Pending<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveWith) => { resolve = resolveWith })
  return { promise, resolve }
}

/** A leaf rebuilt as the chunk its parent lists: the span its parent declares, then its bytes. */
function leafChunk (bytes: Uint8Array, size: number): Uint8Array {
  const chunk = new Uint8Array(SPAN_BYTES + size)
  new DataView(chunk.buffer).setBigUint64(0, BigInt(size), true)
  chunk.set(bytes, SPAN_BYTES)
  return chunk
}

/**
 * Verified content-addressed chunks, kept per partition and fetched once for
 * every caller that asks at the same time. `ready` is waited on before anything
 * is asked of an endpoint and before its timers start, so a chunk the memory or
 * the store holds never waits, and a wait never counts against a request.
 */
export class ChunkSource {
  constructor (
    private readonly deps: ChunkDeps,
    private readonly memory: BlockMemory = new BlockCache(),
    private readonly partition = '',
    private readonly ready?: NodeWait
  ) {}

  /** Throws a ResolutionError: `unverifiable` once an endpoint has lied, `unavailable` when none answered or `ready` says the node will not serve. */
  async get (address: string, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Uint8Array> {
    if (!ADDRESS.test(address)) throw new ResolutionError('unverifiable', `${address} is not a chunk address`)
    const cached = this.memory.recall(this.partition, address)
    if (cached !== undefined) return cached
    if (this.memory.recallKept !== undefined && !signal.aborted) {
      const kept = await this.memory.recallKept(this.partition, address)
      if (kept !== undefined) return kept
    }
    // A shared fetch starts as it is made, and a caller already gone never joins it to stop it again.
    if (signal.aborted) throw signal.reason
    // Not `await this.ready?.(...)`: without a wait the fetch must still start on this turn, so a read made next joins it.
    if (this.ready !== undefined) await this.ready(signal)
    const shared = this.memory.share(this.partition, address, async (sharedSignal, sharedOnRefusal) => {
      const bytes = await fetchChunk(address, cacOf(this.deps), this.deps, sharedSignal, sharedOnRefusal)
      this.memory.remember(this.partition, address, bytes)
      return bytes
    })
    return await shared.join(signal, onRefusal)
  }

  /**
   * The leaves of the subtree under the intermediate chunk at `parent`, in order. A leaf the memory's cache holds is taken
   * from it, and one only the store behind the cache holds (`recallKept`) from there, each read on a turn of the event
   * loop of its own, so a file read mostly from the store never holds the process. Neither costs a request: the leaves
   * neither holds go to `fetchLeaves`.
   */
  leaves (parent: string, leaves: readonly SubtreeLeaf[], signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Array<Promise<Uint8Array>> {
    if (this.memory.recallKept === undefined || signal.aborted || !ADDRESS.test(parent)) return this.fetchLeaves(parent, leaves, signal, onRefusal)
    const kept = leaves.map(async (leaf) => {
      if (!ADDRESS.test(leaf.address)) return undefined
      return this.memory.recall(this.partition, leaf.address) ?? await this.memory.recallKept?.(this.partition, leaf.address)
    })
    const rest = Promise.all(kept).then((found) => {
      const missing: SubtreeLeaf[] = []
      const slot = new Map<number, number>()
      found.forEach((chunk, at) => {
        if (chunk !== undefined) return
        slot.set(at, missing.length)
        missing.push(leaves[at]!)
      })
      return { slot, fetched: this.fetchLeaves(parent, missing, signal, onRefusal) }
    })
    return leaves.map(async (_leaf, at) => {
      const chunk = await kept[at]
      if (chunk !== undefined) return chunk
      const { slot, fetched } = await rest
      return await fetched[slot.get(at)!]!
    })
  }

  /**
   * The leaves of the subtree under `parent`, in order, each fetched from the endpoints unless the cache holds it. Each
   * is shared like any chunk: a read already fetching it is joined, and one that asks later joins this one. Those this
   * call starts are asked of one endpoint in a single `/bytes` request for the whole subtree, at most 512 KB, since a
   * 4 KB round trip each is what makes a file slow and a `Range` makes the node's answer many times slower. Each is used
   * only once its bytes, under the size its parent declares, hash to the address its parent lists: the endpoint is
   * trusted no more than over `/chunks`. A leaf that answer does not hold, or holds wrong, is fetched alone as `get`
   * fetches it, so a node that cannot or will not answer in bulk costs time, never a byte. The `/bytes` request ends
   * only once no read wants a leaf it has still to give, so a read that leaves never sends one that joined it to fetch
   * every leaf alone. Whether to send it is decided once every leaf this call owns is collected, which happens as the
   * call is made, so it is given the leaves that need fetching all together and never one at a time. The `/bytes`
   * request, and each leaf fetched alone, are sent only once `ready` has resolved.
   */
  private fetchLeaves (parent: string, leaves: readonly SubtreeLeaf[], signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Array<Promise<Uint8Array>> {
    if (signal.aborted || !ADDRESS.test(parent)) return leaves.map(async (leaf) => await this.get(leaf.address, signal, onRefusal))
    /** The leaves this call fetches, in order, each settled with its chunk from the bulk answer or undefined. */
    const owned: Array<{ readonly leaf: SubtreeLeaf, readonly answer: Pending<Uint8Array | undefined>, readonly wanted: AbortSignal }> = []
    const answers = leaves.map(async (leaf) => {
      if (!ADDRESS.test(leaf.address)) throw new ResolutionError('unverifiable', `${leaf.address} is not a chunk address`)
      const kept = this.memory.recall(this.partition, leaf.address)
      if (kept !== undefined) return kept
      const shared = this.memory.share(this.partition, leaf.address, async (sharedSignal, sharedOnRefusal) => {
        const answer = pending<Uint8Array | undefined>()
        owned.push({ leaf, answer, wanted: sharedSignal })
        const fromBulk = await answer.promise
        if (fromBulk === undefined && sharedSignal.aborted) throw sharedSignal.reason
        if (fromBulk === undefined && this.ready !== undefined) await this.ready(sharedSignal)
        const bytes = fromBulk ?? await fetchChunk(leaf.address, cacOf(this.deps), this.deps, sharedSignal, sharedOnRefusal)
        this.memory.remember(this.partition, leaf.address, bytes)
        return bytes
      })
      return await shared.join(signal, onRefusal)
    })
    let next = 0
    let stopped: string | undefined
    const bulk = new AbortController()
    for (const { wanted } of owned) {
      wanted.addEventListener('abort', () => { if (owned.slice(next).every((leaf) => leaf.wanted.aborted)) bulk.abort(wanted.reason) }, { once: true })
    }
    const alone = (): void => {
      if (stopped !== undefined && next < owned.length && !bulk.signal.aborted) this.deps.log?.(`swarm: a bulk read gave ${String(next)} of ${String(owned.length)} leaves (${stopped}); the rest are read one by one`)
      for (; next < owned.length; next++) owned[next]!.answer.resolve(undefined)
    }
    const endpoint = this.deps.pool.candidates()[0]
    if (owned.length < 2 || endpoint === undefined) {
      alone()
      return answers
    }
    const checker = this.deps.checker ?? CHECK_HERE
    const from = owned[0]!.leaf.offset
    const last = owned[owned.length - 1]!.leaf
    const body = new Uint8Array(last.offset + last.size - from)
    const bulkRead = async (): Promise<void> => {
      await askGateway(
        this.deps.pool, this.deps.fetch, endpoint,
        { url: `${endpoint}/bytes/${parent}`, accept: 'application/octet-stream', timeoutMs: this.deps.limits.chunkTimeoutMs, maxBytes: from + body.length, unnoted: true },
        async (response, progress) => {
          let skip = from
          stopped = 'the answer ended early'
          if (response.body === null) return
          const reader = response.body.getReader()
          let filled = 0
          let begun = 0
          let refused = false
          let settled: Promise<void> = Promise.resolve()
          try {
            while (filled < body.length && !refused) {
              const { done, value } = await reader.read()
              if (done) break
              progress()
              const used = Math.min(skip, value.length)
              skip -= used
              const take = Math.min(value.length - used, body.length - filled)
              body.set(value.subarray(used, used + take), filled)
              filled += take
              // Every leaf now whole is checked at once, and answered in order: the first that fails ends the read, and the rest are fetched alone.
              for (; begun < owned.length; begun++) {
                const { leaf, answer } = owned[begun]!
                const end = leaf.offset - from + leaf.size
                if (end > filled) break
                const chunk = leafChunk(body.subarray(leaf.offset - from, end), leaf.size)
                const verdict = checker.verify(leaf.address, chunk).catch(() => false)
                settled = settled.then(async () => {
                  if (refused) return
                  if (!await verdict) {
                    refused = true
                    stopped = 'a leaf that failed its address'
                    return
                  }
                  answer.resolve(chunk)
                  next++
                })
              }
            }
          } finally {
            await settled
            await reader.cancel().catch(() => {})
          }
        },
        bulk.signal
      )
    }
    // A node that will not serve fails each leaf's own fetch above, in its words: no bulk read went wrong, so none is logged.
    void (this.ready === undefined ? bulkRead() : this.ready(bulk.signal).then(bulkRead, () => {})).catch((error: unknown) => { stopped = error instanceof Error ? error.message : String(error) }).finally(alone)
    return answers
  }
}
