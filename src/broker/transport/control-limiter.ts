// The per-origin call-rate limits on CONTROL_CHANNEL (T11b's token-bucket
// half), and which budget each method draws on. See ./README.md's Design
// notes for why handle-scoped I/O has a budget of its own and why that
// budget paces rather than refuses.

import type { ControlMethod } from './ipc-validation.js'
import { createPacingLimiter, createTokenBucketLimiter } from './token-bucket.js'
import type { RateLimiter } from './token-bucket.js'

/**
 * Calls against a handle the origin already holds: no path to confine, no
 * grant to consult, no new resource. Everything else, including the `fs.dir*`
 * calls (each one names a path inside a picked folder), is a control call.
 */
const HANDLE_IO_METHODS: ReadonlySet<string> = new Set<ControlMethod>([
  'fs.read', 'fs.write', 'fs.fstat', 'fs.truncate', 'fs.sync', 'fs.close',
  'net.close', 'net.setNoDelay', 'net.setKeepAlive'
])

export interface ControlLimiter extends RateLimiter {
  /** The handle-I/O budget. Absent (a test double) means handle-scoped calls fall back to `tryConsume`. */
  readonly admitHandleIo?: (origin: string) => Promise<boolean>
}

/** False when `method`'s budget refuses `origin`. No limiter at all admits everything. */
export async function admitControlCall (limiter: ControlLimiter | undefined, origin: string, method: string): Promise<boolean> {
  if (limiter === undefined) return true
  if (HANDLE_IO_METHODS.has(method) && limiter.admitHandleIo !== undefined) return await limiter.admitHandleIo(origin)
  return limiter.tryConsume(origin)
}

// Provisional (open-questions.md A38), not owner decisions.
const CONTROL_CAPACITY = 200
const CONTROL_REFILL_PER_SECOND = 100
const HANDLE_IO_CAPACITY = 4096
const HANDLE_IO_REFILL_PER_SECOND = 4096
const HANDLE_IO_MAX_WAIT_MS = 1_000

/** The production pair: the shared control bucket, and the pacing budget handle-scoped I/O draws on instead. */
export function createControlLimiter (now: () => number): ControlLimiter {
  const control = createTokenBucketLimiter({ capacity: CONTROL_CAPACITY, refillPerSecond: CONTROL_REFILL_PER_SECOND, now })
  const handleIo = createPacingLimiter({
    capacity: HANDLE_IO_CAPACITY,
    refillPerSecond: HANDLE_IO_REFILL_PER_SECOND,
    maxWaitMs: HANDLE_IO_MAX_WAIT_MS,
    now
  })
  return { tryConsume: control.tryConsume, admitHandleIo: handleIo.admit }
}
