// The updates a Swarm gatherer keeps feeds at between runs: following a feed from the one kept, and the look for a newer one
// that such a mount starts and does not wait for. The look asks the network like any read, keeps what it finds for the next
// mount, and reports a failure in a word, never an address.

import { ResolutionError } from '../resolution/records.js'
import type { ChunkDeps } from './chunk-fetch.js'
import { followKept, resolveFeed } from './feed.js'
import type { FeedId, FeedIndexStore, KeptFeedUpdates, ResolvedFeed } from './feed.js'
import type { NodeWait } from './node-wait.js'

/** Why a check stopped, without the address or the text an error may carry. */
function reasonOf (error: unknown, timedOut: boolean): string {
  if (timedOut) return 'timed out'
  if (error instanceof ResolutionError) return error.failure
  return 'stopped'
}

export class KeptFeeds {
  /** Each running check's answer: the newest index it found, or undefined once it failed. */
  private readonly running = new Map<string, Promise<bigint | undefined>>()

  constructor (
    private readonly deps: ChunkDeps,
    private readonly store: FeedIndexStore,
    private readonly kept: KeptFeedUpdates,
    /** The look's time limit, asked for each look: a route's pace moves as it is measured. */
    private readonly timeoutMs: () => number,
    private readonly log: ((line: string) => void) | undefined
  ) {}

  /** The update kept for `feed` in `partition`, if it checks out and is no older than any seen: see `followKept`. */
  async follow (feed: FeedId, partition: string): Promise<ResolvedFeed | undefined> {
    return await followKept(feed, partition, this.kept, this.store)
  }

  /** Keeps the update the network gave for `feed`, in place of any older one. */
  keep (feed: FeedId, partition: string, resolved: ResolvedFeed): void {
    this.kept.rememberUpdate(partition, feed, resolved.index, resolved.chunk)
  }

  /**
   * The newest index a check of `feed` found, starting one if none is running, after `wait` says the node can be read from. An
   * update past `from` is kept for `partition` before this resolves, so the next mount opens it. At most one runs for each feed
   * in each partition, and a mount that asks while one runs joins it. Never rejects: a failure is one line in the log and an
   * undefined answer, and the check ends at its time limit whatever the node does.
   */
  newest (feed: FeedId, partition: string, from: bigint, wait: NodeWait): Promise<bigint | undefined> {
    const key = `${partition}\n${feed.owner}\n${feed.topic}`
    const running = this.running.get(key)
    if (running !== undefined) return running
    const check = this.run(feed, partition, from, wait).finally(() => { this.running.delete(key) })
    this.running.set(key, check)
    return check
  }

  private async run (feed: FeedId, partition: string, from: bigint, wait: NodeWait): Promise<bigint | undefined> {
    const limit = AbortSignal.timeout(this.timeoutMs())
    try {
      await wait(limit)
      const found = await resolveFeed(feed, this.deps, this.store, limit, () => {})
      if (found.index > from) {
        this.kept.rememberUpdate(partition, feed, found.index, found.chunk)
        this.log?.('swarm: a newer version of a feed was found and is used from the next load')
      }
      return found.index
    } catch (error) {
      this.log?.(`swarm: looking for a newer version of a feed failed (${reasonOf(error, limit.aborted)})`)
      return undefined
    }
  }
}
