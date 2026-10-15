// A fault that may pass on its own (budget.ts marks it `transient`) earns
// another attempt after a pause. The attempts and the pauses are finite,
// the bundle's own deadline cuts a pause short, and a definitive answer
// (404, a script served as HTML, a byte cap) is never retried.

import type { FetchBundleRejected } from './budget.js'
import { servedByVerifier } from './verifier-origin.js'

/** Pauses before the second and third attempt, so one asset is tried three times at most. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000]

/**
 * The same for a file the verifier serves. Behind the verifier are gateways, a light client and, with the tunnel on, a mixnet, so a
 * fault there lasts longer than a dropped connection does: the verifier starting again takes seconds, and a mixnet tunnel that
 * is replaced takes ten or more. Four tries over 44 s.
 */
export const VERIFIER_RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000]

/** The pauses for the files of `origin`; `override` is for a test. */
export function retryBackoffFor (origin: string, override?: readonly number[]): readonly number[] {
  if (override !== undefined) return override
  return servedByVerifier(`${origin}/`) ? VERIFIER_RETRY_BACKOFF_MS : RETRY_BACKOFF_MS
}

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
