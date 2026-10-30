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

/** A pause that `cancel` ends at once, clearing its timer; `done` settles either way. */
export interface Pause {
  readonly done: Promise<void>
  readonly cancel: () => void
}

/** A pause of any length, taken in slices of what setTimeout allows; zero yields once to the event loop. */
export function pause (ms: number): Pause {
  let timer: ReturnType<typeof setTimeout> | undefined
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const slice = (left: number): void => {
    timer = setTimeout(() => {
      timer = undefined
      if (left > MAX_TIMER_MS) slice(left - MAX_TIMER_MS)
      else finish()
    }, Math.max(0, Math.min(left, MAX_TIMER_MS)))
  }
  slice(ms)
  return { done, cancel: () => { clearTimeout(timer); timer = undefined; finish() } }
}

/** A pause nothing ends early. */
export async function delay (ms: number): Promise<void> {
  await pause(ms).done
}

/** Fresh random bytes, in a buffer of their own: getRandomValues refuses a view over shared memory. */
export function randomBytes (length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += RANDOM_CHUNK) crypto.getRandomValues(bytes.subarray(offset, offset + RANDOM_CHUNK))
  return bytes
}
