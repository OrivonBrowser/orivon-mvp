// Clocks, timers and randomness both WASI hosts read the same way.

/** setTimeout's largest delay; a longer wait is taken in slices of this. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** crypto.getRandomValues refuses more than this per call. */
const RANDOM_CHUNK = 65_536

/** Whole nanoseconds, from a millisecond count with a fraction. */
export function msToNs (ms: number): bigint {
  const whole = Math.trunc(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1_000_000))
}

export function realtimeNs (): bigint {
  return msToNs(performance.timeOrigin + performance.now())
}

export function monotonicNs (): bigint {
  return msToNs(performance.now())
}

/** A pause of any length; zero yields once to the event loop. */
export async function delay (ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= MAX_TIMER_MS) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, MAX_TIMER_MS)))
  }
  if (ms <= 0) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Fresh random bytes, in a buffer of their own: getRandomValues refuses a view over shared memory. */
export function randomBytes (length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += RANDOM_CHUNK) crypto.getRandomValues(bytes.subarray(offset, offset + RANDOM_CHUNK))
  return bytes
}
