// A fault that may pass on its own (budget.ts marks it `transient`) earns
// another attempt after a pause. The attempts and the pauses are finite,
// the bundle's own deadline cuts a pause short, and a definitive answer
// (404, a script served as HTML, a byte cap) is never retried.

import type { FetchBundleRejected } from './budget.js'

/** Pauses before the second and third attempt, so one asset is tried three times at most. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000]

async function pause (ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Runs `attempt` until it succeeds, fails definitively, or has failed transiently once per entry of `backoffMs` plus one. */
export async function retryTransient<T> (
  attempt: () => Promise<T | FetchBundleRejected>,
  backoffMs: readonly number[],
  signal: AbortSignal
): Promise<T | FetchBundleRejected> {
  for (let tried = 0; ; tried++) {
    const outcome = await attempt()
    const again = typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok === false && outcome.transient === true
    if (!again || tried >= backoffMs.length) return outcome
    await pause(backoffMs[tried]!, signal)
    if (signal.aborted) return outcome
  }
}
