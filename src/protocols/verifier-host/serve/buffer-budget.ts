// The bytes the loopback server holds whole before it sends them (server.ts): one share per partition, a combined
// backstop over every partition, and a line of readers per partition for the files taken as their bytes arrive.

import { MAX_ASSET_BYTES } from '../../../broker/policy/bundle-hash.js'
import { sleepOrAbort } from '../../resolution/timing.js'

/** A file up to this size is read and verified whole before its first byte is sent to a page, so a failure is an error page, never half a document. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

/**
 * The most ONE partition's requests hold at once on the buffer-then-send
 * path, except that its oldest reader may go as far as
 * `MAX_OLDEST_READER_BUFFERED_BYTES`. A file's chunks are views into blocks
 * the cache already owns, so buffering one costs little beyond holding those
 * references -- but a page that opens many requests before reading any of
 * them queues one pending response per socket, and `MAX_BUFFERED_BYTES`
 * alone only bounds ONE of those, never their sum. Four files' worth covers
 * ordinary concurrent tabs on one site; past it, THAT site's own further
 * requests are refused with `503` rather than added to the pile -- never
 * another site's, which is exactly what one shared, unpartitioned budget
 * would cost every OTHER `.eth`/`ipfs://` page the moment one page opened
 * enough requests and never read them.
 */
const MAX_PARTITION_BUFFERED_BYTES = 4 * MAX_BUFFERED_BYTES

/**
 * The most a partition holds while its oldest reader takes its next chunk: the partition's limit plus the largest
 * file an app may carry, so the oldest always has room for one whole file (the server answers a larger one without
 * reading it). It is also what caps a partition: only the oldest reader goes past the limit, and a read leaves the
 * line once its file is gathered.
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
  /** Counts every reserve and release, so a wait can tell that something, anywhere in the budget, has moved. */
  private moves = 0

  /** Joins the line of readers of a partition, oldest first, for a read that takes a file's bytes as they arrive. */
  enter (partition: string | undefined): symbol {
    const key = partition ?? ''
    const reader = Symbol('reader')
    const line = this.lines.get(key)
    if (line === undefined) this.lines.set(key, [reader])
    else line.push(reader)
    return reader
  }

  /** Leaves the line, whether or not the reader is in it, so a read may leave when it is done and again on any way out. */
  leave (partition: string | undefined, reader: symbol): void {
    const key = partition ?? ''
    const rest = (this.lines.get(key) ?? []).filter((each) => each !== reader)
    if (rest.length > 0) this.lines.set(key, rest)
    else this.lines.delete(key)
  }

  /**
   * True and reserved if both this partition's own budget and the global
   * backstop have room; false and unchanged otherwise. `first` raises the
   * partition's own limit to the oldest reader's ceiling, and never the backstop.
   */
  reserve (partition: string | undefined, length: number, first = false): boolean {
    const key = partition ?? ''
    const current = this.perPartition.get(key) ?? 0
    const limit = first ? MAX_OLDEST_READER_BUFFERED_BYTES : MAX_PARTITION_BUFFERED_BYTES
    if (current + length > limit || this.total + length > MAX_TOTAL_BUFFERED_BYTES) return false
    this.perPartition.set(key, current + length)
    this.total += length
    this.moves += 1
    return true
  }

  /**
   * `reserve` for a reader that entered the partition's line, waiting while there is no room. Only the oldest reader
   * of a partition can be refused, and only when nothing in the whole budget has moved for `waitMs`; any other reader
   * waits until it finds room or becomes the oldest, because on a slow route one block can take longer than `waitMs`
   * and a later read must not lose its file while the oldest waits on its source. False at once when `left` aborts.
   *
   * The oldest reader may go past the partition's limit, up to the ceiling. Readers each hold part of a file and wait
   * for room only another can free, so without this they wait on each other; the oldest finishes and gives its share
   * back. A reader leaves the line when its file is gathered, not when the response is written: the ceiling already
   * bounds what a page that never reads can hold, and staying would block the next read behind an unread response.
   */
  async takeWithin (partition: string | undefined, length: number, waitMs: number, reader: symbol, left: AbortSignal): Promise<boolean> {
    const key = partition ?? ''
    let seen = this.moves
    let until = Date.now() + waitMs
    while (!left.aborted) {
      const oldest = this.lines.get(key)?.[0] === reader
      if (this.reserve(partition, length, oldest)) return true
      if (!oldest || this.moves !== seen) {
        seen = this.moves
        until = Date.now() + waitMs
      } else if (Date.now() >= until) return false
      await sleepOrAbort(BUDGET_POLL_MS, left)
    }
    return false
  }

  release (partition: string | undefined, length: number): void {
    if (length === 0) return
    const key = partition ?? ''
    const remaining = (this.perPartition.get(key) ?? 0) - length
    if (remaining > 0) this.perPartition.set(key, remaining)
    else this.perPartition.delete(key)
    this.total -= length
    this.moves += 1
  }
}
