// A file that could not be read this moment is read again before the page is told it is missing: on a slow route a
// stylesheet that arrives late is a page that loads, and one answered with an error is a page without its colours.

import { ResolutionError } from '../../resolution/records.js'
import { sleepOrAbort } from '../../resolution/timing.js'
import type { RoutePace } from '../../route-pace.js'

/** Reads of one file after the first. */
export const FILE_RETRIES = 2
/** What is waited before the next read, and twice that before the one after: a breather for a source that was just unwell, not a wait for an answer, so the route does not stretch it. */
const RETRY_WAIT_MS = 1_500
/** A read that has already taken this long is not made again: the layers below were patient for as long as the route asks, and a file nobody has is not worth a person's next quarter hour. Written for a direct connection. */
const PATIENCE_MS = 30_000

/** Whether reading again could succeed: nothing answered in time. A missing path, a lie and an unsupported format would only fail again. */
export function isTransient (error: unknown): boolean {
  return error instanceof ResolutionError && error.failure === 'unavailable'
}

/**
 * `attempt(n)`, and again after a short pause while a transient failure leaves it unanswered, up to `FILE_RETRIES`
 * more times, for as long as `signal` has not fired and the reads so far have not taken the route's patience. The last
 * failure is the one thrown.
 */
export async function readWithRetries<T> (attempt: (n: number) => Promise<T>, route: RoutePace, signal: AbortSignal, retries = FILE_RETRIES, now: () => number = Date.now): Promise<T> {
  const began = now()
  for (let n = 0; ; n++) {
    try {
      return await attempt(n)
    } catch (error) {
      if (n >= retries || !isTransient(error) || signal.aborted || now() - began >= route.wait(PATIENCE_MS)) throw error
      await sleepOrAbort(RETRY_WAIT_MS * (n + 1), signal)
      if (signal.aborted) throw error
    }
  }
}
