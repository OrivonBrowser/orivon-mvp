// One race across sources for one answer, shared by block fetches and IPNS
// lookups: the first source is asked, a second hedges it after a delay, the
// first verified answer wins and the rest are cancelled.

import { ResolutionError } from '../resolution/records.js'

/** Concurrent attempts for one answer: the first, plus at most one hedge. */
export const MAX_ATTEMPTS_IN_FLIGHT = 2

/** Why an attempt that started before the winner was cancelled: it had the
 * head start and still had not answered. askGateway (gateways.ts) counts
 * one that had not even sent its headers as a timeout. */
export class Outrun extends Error {
  override readonly name = 'Outrun'
}

export type AttemptOutcome<T> =
  | { readonly kind: 'verified', readonly value: T }
  | { readonly kind: 'lied', readonly reason: string }
  | { readonly kind: 'failed', readonly retryable: boolean, readonly reason: string }
  | { readonly kind: 'fatal', readonly error: ResolutionError }

/** A FIFO of attempt outcomes, with a `next()` that genuinely waits -- no
 * polling. `push` is called from inside a `.then()` (a real completion),
 * and resolves whichever `next()` call is currently pending directly, the
 * same hand-off `resolution/slots.ts`'s `Slots` uses for the same reason:
 * a poll that never yields to a macrotask would starve every timer and
 * network callback in the process, including the hedge delay's own and
 * the gateway fetch's, and never resolve at all. */
class AttemptQueue<T> {
  private readonly results: T[] = []
  private notify: (() => void) | undefined

  push (value: T): void {
    this.results.push(value)
    this.notify?.()
  }

  /** Waits for at least one result, or rejects with `signal.reason` once it
   * aborts first with nothing queued. Only one call may be pending at a
   * time -- this module never calls `next` again before the previous one
   * has settled. */
  async next (signal: AbortSignal): Promise<T> {
    if (this.results.length === 0) {
      // An 'abort' listener added to a signal that already fired is never called.
      if (signal.aborted) throw signal.reason
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { reject(signal.reason) }
        this.notify = () => {
          signal.removeEventListener('abort', onAbort)
          this.notify = undefined
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    return this.results.shift()!
  }
}

/** What one pass across `candidates` (racePass, below) ended with. */
export type PassResult<T> =
  | { readonly kind: 'verified', readonly value: T }
  | { readonly kind: 'fatal', readonly error: ResolutionError }
  | { readonly kind: 'exhausted', readonly lied: boolean, readonly retryable: boolean, readonly reasons: readonly string[] }

/** `AbortSignal.timeout(ms)` fires on its own; this fires only if told to,
 * so a hedge that already got its answer never leaves a live timer behind
 * waiting to fire into an abandoned pass. */
function abortAfter (ms: number): { readonly signal: AbortSignal, readonly cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  return { signal: controller.signal, cancel: () => { clearTimeout(timer) } }
}

/** Runs every candidate in `candidates`, up to `MAX_ATTEMPTS_IN_FLIGHT` at
 * once, hedging a slow leader with the next candidate after `hedgeDelayMs` --
 * first verified answer wins and every other attempt is abandoned. Returns
 * once nothing is left to try: verified, fatal, or every attempt in the
 * pass has failed or lied.
 */
export async function racePass<T> (
  candidates: readonly string[],
  run: (candidate: string, signal: AbortSignal) => Promise<AttemptOutcome<T>>,
  hedgeDelayMs: number,
  callerSignal: AbortSignal
): Promise<PassResult<T>> {
  // With nothing to start, nothing would ever answer the wait below.
  if (candidates.length === 0) return { kind: 'exhausted', lied: false, retryable: false, reasons: [] }
  // One controller per attempt, in start order, so each loser can be told whether it was outrun.
  const attempts: AbortController[] = []
  let winner: number | undefined
  try {
    const queue = new AttemptQueue<{ readonly index: number, readonly outcome: AttemptOutcome<T> }>()
    let inFlight = 0
    let nextIndex = 0
    let lied = false
    let retryable = false
    const reasons: string[] = []

    // Applies one outcome, returning the pass's final result if this one
    // ends it (verified or fatal), or undefined to keep racing.
    const handle = ({ index, outcome }: { readonly index: number, readonly outcome: AttemptOutcome<T> }): PassResult<T> | undefined => {
      if (outcome.kind === 'verified') winner = index
      if (outcome.kind === 'verified' || outcome.kind === 'fatal') return outcome
      if (outcome.kind === 'lied') lied = true
      else retryable = retryable || outcome.retryable
      reasons.push(outcome.reason)
      return undefined
    }

    const start = (): void => {
      if (nextIndex >= candidates.length || inFlight >= MAX_ATTEMPTS_IN_FLIGHT) return
      const index = nextIndex++
      const candidate = candidates[index]!
      const own = new AbortController()
      attempts.push(own)
      inFlight++
      // Its own signal, not just the caller's: a loser abandoned in the
      // `finally` below must have its REAL network request cancelled too,
      // not just stop being waited on here -- the caller's signal alone
      // would leave an abandoned attempt's fetch (and the gateway slot it
      // holds) running until its own timeout regardless of who won the race.
      run(candidate, AbortSignal.any([callerSignal, own.signal])).then(
        (outcome) => { queue.push({ index, outcome }) },
        // run() only throws for a bug (askGateway's own contract is "never
        // throws but GatewayFailure"); surfaced as fatal rather than swallowed.
        (error: unknown) => { queue.push({ index, outcome: { kind: 'fatal', error: error instanceof ResolutionError ? error : new ResolutionError('unavailable', String(error)) } }) }
      ).finally(() => { inFlight-- })
    }

    start()
    for (;;) {
      // A caller that left is answered with its own reason, never with the
      // reasons its cancelled attempts reported on the way out.
      if (callerSignal.aborted) throw callerSignal.reason
      const canHedge = inFlight < MAX_ATTEMPTS_IN_FLIGHT && nextIndex < candidates.length
      if (canHedge) {
        const hedge = abortAfter(hedgeDelayMs)
        try {
          const result = handle(await queue.next(AbortSignal.any([callerSignal, hedge.signal])))
          if (result !== undefined) return result
        } catch {
          if (callerSignal.aborted) throw callerSignal.reason
          start() // the hedge delay elapsed with nothing yet -- start the next candidate too
          continue
        } finally {
          hedge.cancel()
        }
      } else {
        const result = handle(await queue.next(callerSignal))
        if (result !== undefined) return result
      }
      if (inFlight === 0 && nextIndex >= candidates.length) return { kind: 'exhausted', lied, retryable, reasons }
      if (inFlight < MAX_ATTEMPTS_IN_FLIGHT) start()
    }
  } finally {
    // Every attempt still running lost the race (or the pass ended without
    // one): freeing its slot and its gateway's health record from further
    // waiting matters more than its answer, which nothing needs any more.
    for (const [index, own] of attempts.entries()) own.abort(winner !== undefined && index < winner ? new Outrun('another source answered first') : undefined)
  }
}
