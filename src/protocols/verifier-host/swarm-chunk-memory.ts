// The memory a Swarm gatherer keeps verified chunks in when the host also keeps them on disk: the usual in-memory
// cache in front, the database behind it. What is shared between callers in flight stays in memory alone.

import { BlockCache } from '../gateways/cache.js'
import type { BlockMemory, SharedFetch } from '../gateways/cache.js'
import type { Refusal } from '../resolution/providers.js'
import type { FeedId, KeptFeedUpdates, KeptUpdate } from '../swarm/feed.js'
import type { SwarmChunkDatabase } from './swarm-chunk-database.js'

export class KeptChunkMemory implements BlockMemory, KeptFeedUpdates {
  private readonly memory = new BlockCache()
  /** The disk reads, one after another: each waits for the one before it and for a turn of the event loop of its own. */
  private reading: Promise<unknown> = Promise.resolve()

  /**
   * `namespace` is what keeps the chunks of one route apart on disk, as the in-memory caches of the routes are
   * kept apart: a website in a tunnel's profile must never be answered by what the direct profile (or the other
   * tunnel) kept for the same origin. The direct route's is empty.
   */
  constructor (private readonly database: SwarmChunkDatabase, private readonly namespace = '') {}

  remember (partition: string, key: string, block: Uint8Array): void {
    this.memory.remember(partition, key, block)
    this.database.put(this.site(partition), key, block)
  }

  /** The cache alone, which never waits; a hit also marks the chunk as used on disk, so what is read all day is not what goes first. */
  recall (partition: string, key: string): Uint8Array | undefined {
    const hot = this.memory.recall(partition, key)
    if (hot !== undefined) this.database.touch(this.site(partition), key)
    return hot
  }

  /**
   * The disk behind the cache: a chunk only the disk has is hashed against its address there, and then answers from the
   * cache. A read is hashed on the host's event loop (about a millisecond and a half for 4 KB), so the reads are made
   * one at a time, each on its own turn of the loop: a file of a thousand chunks read from here lets every other request
   * the host serves through between two of them.
   */
  recallKept (partition: string, key: string): Promise<Uint8Array | undefined> {
    const answer = this.reading.then(async () => {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      return this.readKept(partition, key)
    })
    this.reading = answer
    return answer
  }

  share (partition: string, key: string, start: (signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<Uint8Array>): SharedFetch {
    return this.memory.share(partition, key, start)
  }

  /** The update kept for `feed`, read on a turn of the event loop of its own and not queued behind the chunk reads: it is one row, and a mount waits for it. */
  async recallUpdate (partition: string, feed: FeedId): Promise<KeptUpdate | undefined> {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    try {
      return this.database.getFeedUpdate(this.site(partition), feed)
    } catch {
      return undefined
    }
  }

  rememberUpdate (partition: string, feed: FeedId, index: bigint, chunk: Uint8Array): void {
    try { this.database.putFeedUpdate(this.site(partition), feed, index, chunk) } catch { /* the store says so itself, once */ }
  }

  forgetUpdate (partition: string, feed: FeedId, index: bigint): void {
    try { this.database.dropFeedUpdate(this.site(partition), feed, index) } catch { /* the store says so itself, once */ }
  }

  private readKept (partition: string, key: string): Uint8Array | undefined {
    try {
      const kept = this.database.get(this.site(partition), key)
      if (kept !== undefined) this.memory.remember(partition, key, kept)
      return kept
    } catch {
      return undefined
    }
  }

  private site (partition: string): string {
    return this.namespace === '' ? partition : `${this.namespace}\n${partition}`
  }
}

/** The options that keep a gatherer's chunks and the feed updates it follows in `database`, for the route `namespace` names. */
export function keptIn (database: SwarmChunkDatabase, namespace = ''): { readonly memory: KeptChunkMemory, readonly keptUpdates: KeptChunkMemory } {
  const kept = new KeptChunkMemory(database, namespace)
  return { memory: kept, keptUpdates: kept }
}
