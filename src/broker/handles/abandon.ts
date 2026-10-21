// An app withdrawing a call of its own while it waits for a slot or runs (ADR-0071: the AbortSignal on net.connect and
// net.connectSecure), as distinct from the cascade a revoked grant starts. `HandleTable.run` takes the signal.

import { fail } from '../errors.js'

const MESSAGE = 'the app abandoned this operation'

/** Throws 'closed' if the app has already withdrawn the call, so nothing is allocated or started for it. */
export function throwIfAbandoned (signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw fail('closed', MESSAGE)
}

/** Calls `onAbandon` with the error to reject with when `signal` aborts. Returns the function that stops listening. */
export function watchAbandon (signal: AbortSignal | undefined, onAbandon: (error: ReturnType<typeof fail>) => void): () => void {
  if (signal === undefined) return () => {}
  const listener = (): void => { onAbandon(fail('closed', MESSAGE)) }
  signal.addEventListener('abort', listener, { once: true })
  return () => { signal.removeEventListener('abort', listener) }
}
