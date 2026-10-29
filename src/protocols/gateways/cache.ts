// Verified answers kept between requests, and one in-flight fetch shared by
// every caller that wants the same key. Generic over the key: IPFS keys it by
// CID and Swarm by chunk address, and either way only bytes already checked
// against their address are ever remembered.

import type { Refusal } from '../resolution/providers.js'

const CACHE_BYTES = 64 * 1024 * 1024

/**
 * One fetch, shared by every caller that asks for the same key before it
 * settles -- `start` runs at most once, no matter how many `join`.
 *
 * A joiner's OWN `signal` races against the shared result: if it aborts
 * first, `join` rejects for that caller alone, and only when the LAST
 * joiner has left this way does the underlying fetch actually stop
 * (`start`'s own signal aborts). Every joiner still waiting when the fetch
 * settles gets the refusals a lying gateway earned, whether the fetch
 * succeeded or not, and whichever joiner's request triggered it.
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
    let answered = false
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const onAbort = (): void => { reject(signal.reason) }
        signal.addEventListener('abort', onAbort, { once: true })
        const settle = (): void => { signal.removeEventListener('abort', onAbort); answered = true }
        this.result.then(
          (value) => { settle(); resolve(value) },
          (error: unknown) => { settle(); reject(error) }
        )
      })
    } finally {
      this.liveJoiners--
      if (this.liveJoiners === 0 && !this.settled) this.controller.abort(signal.reason)
      // A fetch that ended unverifiable is exactly the one whose report
      // must name the gateway that lied.
      if (answered) for (const refusal of this.refusals) onRefusal(refusal)
    }
  }
}

/** Where verified blocks are kept between requests, keyed by partition as
 * well as CID, and where an in-flight fetch for one is shared. */
export interface BlockMemory {
  remember: (partition: string, key: string, block: Uint8Array) => void
  recall: (partition: string, key: string) => Uint8Array | undefined
  /**
   * For a memory with a slower store behind its cache (the verifier host's Swarm chunks on disk): the block the store
   * holds for `key`, checked against its address, or undefined. Asked after `recall` found nothing. It reads the store
   * on a turn of the event loop of its own, so a caller that asks for hundreds at once does not hold the process while
   * they are read. Never rejects.
   */
  recallKept?: (partition: string, key: string) => Promise<Uint8Array | undefined>
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
    const id = `${partition}\n${key}`
    const replaced = this.blocks.get(id)
    if (replaced !== undefined) this.bytes -= replaced.length
    this.blocks.delete(id)
    this.blocks.set(id, block)
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
