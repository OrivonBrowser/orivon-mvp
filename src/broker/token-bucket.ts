// A per-origin token bucket -- the rate-limit half of T11b's mitigation
// (security-model.md: "Per-origin in-flight cap + token-bucket rate limit
// on IPC dispatch"). HandleTable's inFlight counter (./handles.ts) is the
// first half, and bounds how many operations an origin has OUTSTANDING at
// once; it does not bound how often an origin may call at all, which is the
// gap open-questions.md A38 records. This is that second, independent
// bound, bounding call FREQUENCY.
//
// Pure and Electron-free, the same way ./port-registry.ts is: time is read
// once per `tryConsume` call via an injected clock rather than
// `Date.now()`, mirroring `CreateBrokerOptions.now` (./index.ts), so tests
// drive refill deterministically instead of waiting on real timers.
//
// NEVER QUEUES -- mirrors HandleTable.run's own "reject immediately" rule
// (handle-contracts.md). An unbounded queue on the broker's UI thread is
// exactly how one misbehaving origin freezes every tab; a rejection the app
// must retry keeps the broker responsive to every other origin.
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

export function createTokenBucketLimiter (options: TokenBucketOptions): RateLimiter {
  const { capacity, refillPerSecond, now } = options
  const buckets = new Map<string, { tokens: number, lastRefillMs: number }>()

  return {
    tryConsume (origin) {
      const nowMs = now()
      const existing = buckets.get(origin)
      let tokens = existing?.tokens ?? capacity

      if (existing !== undefined) {
        const elapsedMs = Math.max(0, nowMs - existing.lastRefillMs)
        tokens = Math.min(capacity, tokens + (elapsedMs * refillPerSecond) / 1000)
      }

      if (tokens < 1) {
        buckets.set(origin, { tokens, lastRefillMs: nowMs })
        return false
      }

      buckets.set(origin, { tokens: tokens - 1, lastRefillMs: nowMs })
      return true
    }
  }
}
