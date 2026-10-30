// The bytes the loopback server holds whole before it sends them (server.ts): one share per partition, a combined
// backstop over every partition, and a line of readers per partition for the files taken as their bytes arrive.

import { MAX_ASSET_BYTES } from '../../../broker/policy/bundle-hash.js'

/** A file up to this size is read and verified whole before its first byte is sent to a page, so a failure is an error page, never half a document. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

/**
 * The most ONE partition's requests hold at once on the buffer-then-send
 * path. A file's chunks are views into blocks the cache already owns,
 * so buffering one costs little beyond holding those references -- but a
 * page that opens many requests before reading any of them queues one
 * pending response per socket, and `MAX_BUFFERED_BYTES` alone only bounds
 * ONE of those, never their sum. Four files' worth covers ordinary
 * concurrent tabs on one site; past it, THAT site's own further requests are
 * refused with `503` rather than added to the pile -- never another site's,
 * which is exactly what one shared, unpartitioned budget would cost every
 * OTHER `.eth`/`ipfs://` page the moment one page opened enough requests
 * and never read them.
 */
const MAX_PARTITION_BUFFERED_BYTES = 4 * MAX_BUFFERED_BYTES

/**
 * The most a partition holds while its oldest reader takes its next chunk: the partition's limit plus the largest
 * file an app may carry. Nothing else on the path bounds the size of a file a request names a leaf for, so this
 * ceiling is what keeps one read of a larger file from spending the backstop every partition shares.
 */
const MAX_OLDEST_READER_BUFFERED_BYTES = MAX_PARTITION_BUFFERED_BYTES + MAX_ASSET_BYTES

/**
 * The most every partition's requests hold at once, combined -- a backstop
 * against many partitions each spending up to their own share at the same
 * time, not a limit any single well-behaved partition should ever reach on
 * its own.
 */
const MAX_TOTAL_BUFFERED_BYTES = 16 * MAX_BUFFERED_BYTES

const BUDGET_POLL_MS = 25

/**
 * Buffered bytes held right now, kept per partition (the same key
 * `sites.ts` mounts by) so one page's unread requests cost only that
 * page's own budget, plus a combined total across every partition. A
 * request with no partition (`partitionOf` returning undefined) shares one
 * bucket, keyed by the empty string, which no real partition ever is.
 */
export class BufferBudget {
  private readonly perPartition = new Map<string, number>()
  private readonly lines = new Map<string, symbol[]>()
  private total = 0

  /** Joins the line of readers of a partition, oldest first, for a read that takes a file's bytes as they arrive. */
  enter (partition: string | undefined): symbol {
    const key = partition ?? ''
    const reader = Symbol('reader')
    const line = this.lines.get(key)
    if (line === undefined) this.lines.set(key, [reader])
    else line.push(reader)
    return reader
  }

  leave (partition: string | undefined, reader: symbol): void {
    const key = partition ?? ''
    const rest = (this.lines.get(key) ?? []).filter((each) => each !== reader)
    if (rest.length > 0) this.lines.set(key, rest)
    else this.lines.delete(key)
  }

  /**
   * True and reserved if both this partition's own budget and the global
   * backstop have room; false and unchanged otherwise. `first` raises the
   * partition's own limit by one file, and never the backstop.
   */
  reserve (partition: string | undefined, length: number, first = false): boolean {
    const key = partition ?? ''
    const current = this.perPartition.get(key) ?? 0
    const limit = first ? MAX_OLDEST_READER_BUFFERED_BYTES : MAX_PARTITION_BUFFERED_BYTES
    if (current + length > limit || this.total + length > MAX_TOTAL_BUFFERED_BYTES) return false
    this.perPartition.set(key, current + length)
    this.total += length
    return true
  }

  /**
   * `reserve` for a reader that entered the partition's line, waiting for a response held by someone else to finish
   * and free its share. It gives up only when nothing in the partition has moved for `waitMs`: an unread page that
   * moves nothing is refused after that long, and a slow read that keeps taking chunks never gets the others refused.
   *
   * The oldest reader of a partition may go one file past the partition's limit. Readers each hold part of a file
   * and wait for room only another can free, so without this they wait on each other; the oldest finishes and gives
   * its share back. A reader stays in line until its response is written, not merely gathered: passing the turn on
   * earlier would let a page that never reads step past the limit one file at a time.
   */
  async takeWithin (partition: string | undefined, length: number, waitMs: number, reader: symbol): Promise<boolean> {
    const key = partition ?? ''
    let seen = this.perPartition.get(key) ?? 0
    let until = Date.now() + waitMs
    while (!this.reserve(partition, length, this.lines.get(key)?.[0] === reader)) {
      const held = this.perPartition.get(key) ?? 0
      if (held !== seen) {
        seen = held
        until = Date.now() + waitMs
      } else if (Date.now() >= until) return false
      await new Promise((resolve) => setTimeout(resolve, BUDGET_POLL_MS))
    }
    return true
  }

  release (partition: string | undefined, length: number): void {
    const key = partition ?? ''
    const remaining = (this.perPartition.get(key) ?? 0) - length
    if (remaining > 0) this.perPartition.set(key, remaining)
    else this.perPartition.delete(key)
    this.total -= length
  }
}
