// The memory a Swarm gatherer keeps verified chunks in when the host also keeps them on disk: the usual in-memory
// cache in front, the database behind it. What is shared between callers in flight stays in memory alone.

import { BlockCache } from '../gateways/cache.js'
import type { BlockMemory, SharedFetch } from '../gateways/cache.js'
import type { Refusal } from '../resolution/providers.js'
import type { SwarmChunkDatabase } from './swarm-chunk-database.js'

export class KeptChunkMemory implements BlockMemory {
  private readonly memory = new BlockCache()

  constructor (private readonly database: SwarmChunkDatabase) {}

  /** How many chunks `recall` has answered from disk, for the host's report log. */
  recalledFromDisk = (): number => this.database.fromDisk

  remember (partition: string, key: string, block: Uint8Array): void {
    this.memory.remember(partition, key, block)
    this.database.put(partition, key, block)
  }

  /** The cache first; a chunk only the disk has is checked there, and then answers from memory. */
  recall (partition: string, key: string): Uint8Array | undefined {
    const hot = this.memory.recall(partition, key)
    if (hot !== undefined) return hot
    const kept = this.database.get(partition, key)
    if (kept !== undefined) this.memory.remember(partition, key, kept)
    return kept
  }

  share (partition: string, key: string, start: (signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => Promise<Uint8Array>): SharedFetch {
    return this.memory.share(partition, key, start)
  }
}
