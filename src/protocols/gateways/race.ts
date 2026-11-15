// One race across sources for one answer, shared by block fetches, IPNS
// lookups and the light client's execution-server requests: the first source
// is asked, a second hedges it after a delay, the first verified answer wins
// and the rest are cancelled. An answer that has a version (an IPNS record)
// asks for `Settle`, which keeps the race open a little after the first one.

import { ResolutionError } from '../resolution/records.js'

/** Concurrent attempts for one answer: the first, plus at most one hedge. */
export const MAX_ATTEMPTS_IN_FLIGHT = 2

/** Why an attempt that started before the answer that ended the race came in
 * was cancelled: it had the head start and still had not answered. askGateway (gateways.ts) counts
 * one that had not even sent its headers as a timeout. */
export class Outrun extends Error {
  override readonly name = 'Outrun'
}

export type AttemptOutcome<T> =
  | { readonly kind: 'verified', readonly value: T }
  | { readonly kind: 'lied', readonly reason: string }
  /** `timedOut`: the source sent nothing in time. A pass in which every failure timed out earns another pass, though one timeout beside a plain miss does not. */
  | { readonly kind: 'failed', readonly retryable: boolean, readonly reason: string, readonly timedOut?: boolean }
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

  /** Outcomes pushed and not yet taken. */
  get size (): number {
    return this.results.length
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

/** For an answer that has versions, where the first verified one may be an old one: the pass stays open `graceMs`
 * after the first verified answer (or until nothing is left to ask) and returns the one `prefers` ranks highest. */
export interface Settle<T> {
  readonly graceMs: number
  /** Whether `candidate` should replace `current`; false for a tie, so the earlier answer stays. */
  readonly prefers: (candidate: T, current: T) => boolean
}

/** `AbortSignal.timeout(ms)` fires on its own; this fires only if told to,
 * so a hedge that already got its answer never leaves a live timer behind
 * waiting to fire into an abandoned pass. */
function abortAfter (ms: number): { readonly signal: AbortSignal, readonly cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  return { signal: controller.signal, cancel: () => { clearTimeout(timer) } }
}

/** Runs every candidate in `candidates`, up to `MAX_ATTEMPTS_IN_FLIGHT` at
 * once, hedging a slow leader with the next candidate after `hedgeDelayMs`
 * (fixed, or asked of the candidate started last) --
 * first verified answer wins and every other attempt is abandoned. Returns
 * once nothing is left to try: verified, fatal, or every attempt in the
 * pass has failed or lied. With `settle`, the first verified answer starts a
 * grace instead of ending the pass: both attempts are kept busy until it
 * passes, and the preferred of the verified answers received is returned.
 */
export async function racePass<T> (
  candidates: readonly string[],
  run: (candidate: string, signal: AbortSignal) => Promise<AttemptOutcome<T>>,
  hedgeDelayMs: number | ((leader: string) => number),
  callerSignal: AbortSignal,
  settle?: Settle<T>
): Promise<PassResult<T>> {
  // With nothing to start, nothing would ever answer the wait below.
  if (candidates.length === 0) return { kind: 'exhausted', lied: false, retryable: false, reasons: [] }
  // One controller per attempt, in start order, so each loser can be told whether it was outrun.
  const attempts: AbortController[] = []
  // Attempts below this index were running before the answer that ended the race came in: outrun, if still silent.
  let outrunBelow: number | undefined
  let grace: ReturnType<typeof abortAfter> | undefined
  try {
    const queue = new AttemptQueue<{ readonly index: number, readonly outcome: AttemptOutcome<T> }>()
    let inFlight = 0
    let nextIndex = 0
    let lied = false
    let retryable = false
    let failures = 0
    let timeouts = 0
    let best: { readonly index: number, readonly value: T } | undefined
    const reasons: string[] = []

    // Applies one outcome, returning the pass's final result if this one
    // ends it (verified or fatal), or undefined to keep racing.
    const handle = ({ index, outcome }: { readonly index: number, readonly outcome: AttemptOutcome<T> }): PassResult<T> | undefined => {
      if (outcome.kind === 'verified' && settle !== undefined) {
        if (best === undefined || settle.prefers(outcome.value, best.value)) best = { index, value: outcome.value }
        // A source asked only once an answer was in hand is cut off by the grace, not outrun: it had no head start.
        outrunBelow ??= nextIndex
        grace ??= abortAfter(settle.graceMs)
        return undefined
      }
      if (outcome.kind === 'verified') outrunBelow = index
      if (outcome.kind === 'verified' || outcome.kind === 'fatal') return outcome
      if (outcome.kind === 'lied') lied = true
      else {
        retryable = retryable || outcome.retryable
        failures++
        if (outcome.timedOut === true) timeouts++
      }
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

    // Closures, so that TypeScript does not narrow what `handle` assigns to its value at declaration.
    const graceOver = (): boolean => grace?.signal.aborted === true
    const waiting = (): AbortSignal => grace === undefined ? callerSignal : AbortSignal.any([callerSignal, grace.signal])
    /** The settled answer, once the grace is over or no source is left that could add to it. */
    const settled = (): PassResult<T> | undefined => {
      if (best === undefined || (!graceOver() && (inFlight > 0 || nextIndex < candidates.length))) return undefined
      return { kind: 'verified', value: best.value }
    }

    start()
    for (;;) {
      // A caller that left is answered with its own reason, never with the
      // reasons its cancelled attempts reported on the way out.
      if (callerSignal.aborted) throw callerSignal.reason
      if (graceOver()) return settled()!
      const waitSignal = waiting()
      const canHedge = inFlight < MAX_ATTEMPTS_IN_FLIGHT && nextIndex < candidates.length
      if (canHedge) {
        const hedge = abortAfter(typeof hedgeDelayMs === 'number' ? hedgeDelayMs : hedgeDelayMs(candidates[nextIndex - 1]!))
        try {
          const result = handle(await queue.next(AbortSignal.any([waitSignal, hedge.signal])))
          if (result !== undefined) return result
        } catch {
          if (callerSignal.aborted) throw callerSignal.reason
          if (graceOver()) return settled()!
          start() // the hedge delay elapsed with nothing yet -- start the next candidate too
          continue
        } finally {
          hedge.cancel()
        }
      } else {
        let outcome: Awaited<ReturnType<typeof queue.next>>
        try {
          outcome = await queue.next(waitSignal)
        } catch (error) {
          if (!callerSignal.aborted && graceOver()) return settled()!
          throw error
        }
        const result = handle(outcome)
        if (result !== undefined) return result
      }
      // With a settle, an outcome pushed in the same turn as the one just handled may still be queued, and may be the higher.
      if (inFlight === 0 && nextIndex >= candidates.length && (settle === undefined || queue.size === 0)) return settled() ?? { kind: 'exhausted', lied, retryable: retryable || (failures > 0 && timeouts === failures), reasons }
      // Once an answer is in hand, every source that may hold a newer one is asked as soon as a slot is free.
      if (best === undefined) start()
      else while (inFlight < MAX_ATTEMPTS_IN_FLIGHT && nextIndex < candidates.length) start()
    }
  } finally {
    grace?.cancel()
    // Every attempt still running lost the race (or the pass ended without
    // one): freeing its slot and its gateway's health record from further
    // waiting matters more than its answer, which nothing needs any more.
    for (const [index, own] of attempts.entries()) own.abort(outrunBelow !== undefined && index < outrunBelow ? new Outrun('another source answered first') : undefined)
  }
}
