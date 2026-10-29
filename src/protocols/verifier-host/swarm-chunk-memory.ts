// The memory a Swarm gatherer keeps verified chunks in when the host also keeps them on disk: the usual in-memory
// cache in front, the database behind it. What is shared between callers in flight stays in memory alone.

import { BlockCache } from '../gateways/cache.js'
import type { BlockMemory, SharedFetch } from '../gateways/cache.js'
import type { Refusal } from '../resolution/providers.js'
import { CHECK_HERE } from '../swarm/chunk-check.js'
import type { CheckedOn, ChunkChecker } from '../swarm/chunk-check.js'
import type { KeptRow, SwarmChunkDatabase } from './swarm-chunk-database.js'

export class KeptChunkMemory implements BlockMemory {
  private readonly memory = new BlockCache()
  /** The disk reads, one after another: each waits for the one before it and for a turn of the event loop of its own. */
  private reading: Promise<unknown> = Promise.resolve()

  /**
   * `namespace` is what keeps the chunks of one route apart on disk, as the in-memory caches of the routes are
   * kept apart: a website in a tunnel's profile must never be answered by what the direct profile (or the other
   * tunnel) kept for the same origin. The direct route's is empty. `checker` is where a row read back is hashed against
   * its address; unset, in the host's own thread.
   */
  constructor (private readonly database: SwarmChunkDatabase, private readonly namespace = '', private readonly checker: ChunkChecker = CHECK_HERE) {}

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
   * The disk behind the cache: a chunk only the disk has is hashed against its address, and then answers from the cache. The
   * rows are read one at a time, each on a turn of the event loop of its own, so a file of a thousand chunks read from here
   * lets every other request the host serves through between two of them. The hash is not part of that chain: the checker
   * makes it while the next rows are read, and a row that fails it is deleted so the chunk is fetched anew.
   */
  recallKept (partition: string, key: string, ran?: (on: CheckedOn) => void): Promise<Uint8Array | undefined> {
    const row = this.reading.then(async () => {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      return this.readRow(partition, key)
    })
    this.reading = row
    return row.then(async (found) => await this.settle(partition, key, found, ran))
  }

  share (partition: string, key: string, start: (signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<Uint8Array>): SharedFetch {
    return this.memory.share(partition, key, start)
  }

  private readRow (partition: string, key: string): KeptRow | undefined {
    try {
      return this.database.read(this.site(partition), key)
    } catch {
      return undefined
    }
  }

  private async settle (partition: string, key: string, row: KeptRow | undefined, ran?: (on: CheckedOn) => void): Promise<Uint8Array | undefined> {
    if (row === undefined) return undefined
    try {
      const genuine = row.checked || await this.checker.verify(key, row.bytes, ran)
      const kept = this.database.settle(row, genuine)
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
