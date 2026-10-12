// One deadline over opening a routed connection, as a direct dial has: a far
// end that accepts and then never answers must not hold a socket slot for ever.

import { DIAL_TIMEOUT_MS } from '../adapters/node-adapters.js'
import { fail } from '../errors.js'

/**
 * Runs `open` under a signal that fires when `signal` does or after
 * `deadlineMs`. A deadline that fires first is `timeout`; the caller's own
 * abort stays whatever `open` made of it.
 */
export async function withDeadline<T> (
  signal: AbortSignal,
  open: (attempt: AbortSignal) => Promise<T>,
  deadlineMs: number = DIAL_TIMEOUT_MS
): Promise<T> {
  const attempt = new AbortController()
  let expired = false
  const onAbort = (): void => { attempt.abort() }
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { expired = true; attempt.abort() }, deadlineMs)
  try {
    return await open(attempt.signal)
  } catch (error) {
    throw expired && !signal.aborted ? fail('timeout', `connecting through the route exceeded ${String(deadlineMs)}ms`) : error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
