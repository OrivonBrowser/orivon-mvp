// A per-origin token bucket -- the rate-limit half of T11b's mitigation
// (security-model.md: "Per-origin in-flight cap + token-bucket rate limit
// on IPC dispatch"). HandleTable's inFlight counter (../handles/handles.ts) is the
// first half, and bounds how many operations an origin has OUTSTANDING at
// once; it does not bound how often an origin may call at all, which is the
// gap open-questions.md A38 records. This is that second, independent
// bound, bounding call FREQUENCY.
//
// Pure and Electron-free, the same way ./port-registry.ts is: time is read
// once per `tryConsume` call via an injected clock rather than
// `Date.now()`, mirroring `CreateBrokerOptions.now` (../index.ts), so tests
// drive refill deterministically instead of waiting on real timers.
//
// `createTokenBucketLimiter` NEVER QUEUES: an unbounded queue on the
// broker's UI thread is how one misbehaving origin freezes every tab.
// `createPacingLimiter` delays instead of refusing, but only by a bounded
// amount per call -- see ../README.md's Design notes for which calls get it.
//
// REFILL IS CONTINUOUS, NOT A DISCRETE WINDOW: tokens accrue proportional
// to elapsed time, not in fixed steps. A discrete window (e.g. "reset to
// full every second") lets an origin spend a full burst at the tail of one
// window and another full burst at the head of the next, doubling the
// effective burst at the boundary -- exactly the failure mode a token
// bucket exists to avoid.

export interface TokenBucketOptions {
  readonly capacity: number
  readonly refillPerSecond: number
  /** Clock, read once per `tryConsume` call. Injected so a test can drive it deterministically. */
  readonly now: () => number
}

export interface RateLimiter {
  /** Spends one token for `origin` if one is available. Returns false, spending nothing, once the bucket is empty. */
  tryConsume: (origin: string) => boolean
}

type Bucket = { tokens: number, lastRefillMs: number }

/**
 * Drops every bucket that has fully recovered by `nowMs` -- R1-02.
 * ../handles/origin-registry.ts's `reap` exists, in its own words, because
 * "without this every origin the broker ever asked about keeps a permanent
 * row"; `buckets` had no equivalent, so a page that made one call and never
 * returned kept a row here forever. A fully-recovered bucket holds nothing
 * a fresh one would not also start with (both read as `capacity` tokens),
 * so discarding it changes nothing the next caller for that origin sees --
 * no free burst, no leftover throttle.
 *
 * Runs on every call rather than on a timer, the same reason the rest of
 * this file has no timer: there is no Electron-free way to wake up on a
 * schedule, only the clock already read for the call in progress. The scan
 * costs nothing extra in the common case, because it is what keeps
 * `buckets` small enough to stay cheap to scan.
 */
function reapIdle (buckets: Map<string, Bucket>, capacity: number, refillPerSecond: number, nowMs: number): void {
  for (const [origin, bucket] of buckets) {
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs)
    if (bucket.tokens + (elapsedMs * refillPerSecond) / 1000 >= capacity) buckets.delete(origin)
  }
}

/** `origin`'s tokens as of `nowMs` -- a fresh origin starts full, and refill never exceeds `capacity`. */
function refilled (buckets: Map<string, Bucket>, origin: string, capacity: number, refillPerSecond: number, nowMs: number): number {
  const existing = buckets.get(origin)
  if (existing === undefined) return capacity
  const elapsedMs = Math.max(0, nowMs - existing.lastRefillMs)
  return Math.min(capacity, existing.tokens + (elapsedMs * refillPerSecond) / 1000)
}

export function createTokenBucketLimiter (options: TokenBucketOptions): RateLimiter & {
  /** Origins with a live bucket. Exists so R1-02's reap is testable -- mirrors ../handles/origin-registry.ts's own `size()`. */
  size: () => number
} {
  const { capacity, refillPerSecond, now } = options
  const buckets = new Map<string, Bucket>()

  return {
    tryConsume (origin) {
      const nowMs = now()
      reapIdle(buckets, capacity, refillPerSecond, nowMs)

      const tokens = refilled(buckets, origin, capacity, refillPerSecond, nowMs)
      if (tokens < 1) {
        buckets.set(origin, { tokens, lastRefillMs: nowMs })
        return false
      }

      buckets.set(origin, { tokens: tokens - 1, lastRefillMs: nowMs })
      return true
    },
    size: () => buckets.size
  }
}

export interface PacingOptions extends TokenBucketOptions {
  /** The longest one call may be made to wait for its token. A call that would wait longer is refused, borrowing nothing. */
  readonly maxWaitMs: number
  /** Injected so a test can observe the delay instead of waiting it out. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface PacingLimiter {
  /** Resolves true once `origin` may proceed, after waiting for its token if the bucket is empty; false, spending nothing, if that wait would exceed `maxWaitMs`. */
  admit: (origin: string) => Promise<boolean>
  /** Origins with a live bucket, as `createTokenBucketLimiter`'s own `size()`. */
  size: () => number
}

async function realSleep (ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * The same bucket, but a caller past it BORROWS its token and sleeps until
 * that token would have accrued, instead of being refused. Tokens may go
 * negative (debt); each borrower waits one refill interval longer than the
 * one before it, so borrowers are paced at exactly `refillPerSecond`. The
 * debt is bounded by `maxWaitMs`, which also bounds how many calls can be
 * waiting at once: `maxWaitMs * refillPerSecond / 1000`.
 */
export function createPacingLimiter (options: PacingOptions): PacingLimiter {
  const { capacity, refillPerSecond, maxWaitMs, now, sleep = realSleep } = options
  const buckets = new Map<string, Bucket>()

  return {
    async admit (origin) {
      const nowMs = now()
      reapIdle(buckets, capacity, refillPerSecond, nowMs)

      const tokens = refilled(buckets, origin, capacity, refillPerSecond, nowMs)
      const after = tokens - 1
      const waitMs = after >= 0 ? 0 : (-after * 1000) / refillPerSecond
      if (waitMs > maxWaitMs) {
        buckets.set(origin, { tokens, lastRefillMs: nowMs })
        return false
      }

      buckets.set(origin, { tokens: after, lastRefillMs: nowMs })
      if (waitMs > 0) await sleep(waitMs)
      return true
    },
    size: () => buckets.size
  }
}
