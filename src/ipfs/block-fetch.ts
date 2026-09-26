// One verified block, fetched from whichever gateway answers first --
// hedged against a slow one, retried across a cooling one, never against a
// gateway that has lied. Split out of blockstore.ts (Rule 2) once this
// stopped being a single sequential loop.

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { GatewayFailure, askGateway, readCapped } from './gateways.js'
import type { Fetch, GatewayPool } from './gateways.js'
import type { IpfsLimits } from './limits.js'
import { BlockRefused, checkCidAccepted, inlineBlock, verifyBlock } from './verify-block.js'

/** Concurrent gateway attempts for one block: the first, plus at most one hedge. */
export const MAX_ATTEMPTS_IN_FLIGHT = 2
/** A rate-limited or unreachable pass earns one retry, up to this many total. */
export const MAX_PASSES = 3

export interface FetchDeps {
  readonly fetch: Fetch
  readonly pool: GatewayPool
  readonly limits: IpfsLimits
}

/** A block that hashed correctly but breaks a limit or a format: no other
 * source can do better, so this is fatal to the whole fetch, not one
 * gateway's failure. */
function limitFailure (error: unknown): ResolutionError {
  const message = error instanceof Error ? error.message : String(error)
  const unsupported = error instanceof BlockRefused && (error.reason === 'codec' || error.reason === 'hash-function')
  return new ResolutionError(unsupported ? 'unsupported' : 'unverifiable', message)
}

type AttemptOutcome =
  | { readonly kind: 'verified', readonly bytes: Uint8Array }
  | { readonly kind: 'lied' }
  | { readonly kind: 'failed', readonly retryable: boolean, readonly reason: string }
  | { readonly kind: 'fatal', readonly error: ResolutionError }

async function attemptGateway (gateway: string, cid: CID, key: string, deps: FetchDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<AttemptOutcome> {
  let bytes: Uint8Array
  try {
    bytes = await askGateway(
      deps.pool, deps.fetch, gateway,
      { url: `${gateway}/ipfs/${key}?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: deps.limits.blockTimeoutMs },
      async (response) => await readCapped(response, deps.limits.maxBlockBytes),
      signal
    )
  } catch (error) {
    if (!(error instanceof GatewayFailure)) throw error
    if (error.outcome.kind === 'cancelled') return { kind: 'failed', retryable: false, reason: 'superseded by a faster attempt' }
    return { kind: 'failed', retryable: error.outcome.kind === 'rate-limited' || error.outcome.kind === 'unreachable', reason: error.message }
  }
  try {
    await verifyBlock(cid, bytes, deps.limits)
  } catch (error) {
    if (error instanceof BlockRefused && error.reason === 'mismatch') {
      onRefusal({ source: gateway, resource: key })
      deps.pool.drop(gateway)
      return { kind: 'lied' }
    }
    return { kind: 'fatal', error: limitFailure(error) }
  }
  return { kind: 'verified', bytes }
}

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
type PassResult =
  | { readonly kind: 'verified', readonly bytes: Uint8Array }
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
 * once, hedging a slow leader with the next gateway after `hedgeDelayMs` --
 * first verified answer wins and every other attempt is abandoned. Returns
 * once nothing is left to try: verified, fatal, or every attempt in the
 * pass has failed or lied.
 */
async function racePass (
  candidates: readonly string[],
  run: (gateway: string, signal: AbortSignal) => Promise<AttemptOutcome>,
  hedgeDelayMs: number,
  callerSignal: AbortSignal
): Promise<PassResult> {
  const abandon = new AbortController()
  const combined = AbortSignal.any([callerSignal, abandon.signal])
  try {
    const queue = new AttemptQueue<AttemptOutcome>()
    let inFlight = 0
    let nextIndex = 0
    let lied = false
    let retryable = false
    const reasons: string[] = []

    const start = (): void => {
      if (nextIndex >= candidates.length || inFlight >= MAX_ATTEMPTS_IN_FLIGHT) return
      const gateway = candidates[nextIndex++]!
      inFlight++
      // `combined`, not `callerSignal`: a loser abandoned by `abandon.abort()`
      // below must have its REAL network request cancelled too, not just
      // stop being waited on here -- passing the caller's own signal alone
      // would leave an abandoned attempt's fetch (and the gateway slot it
      // holds) running until its own timeout regardless of who won the race.
      run(gateway, combined).then(
        (outcome) => { queue.push(outcome) },
        // run() only throws for a bug (askGateway's own contract is "never
        // throws but GatewayFailure"); surfaced as fatal rather than swallowed.
        (error: unknown) => { queue.push({ kind: 'fatal', error: error instanceof ResolutionError ? error : new ResolutionError('unavailable', String(error)) }) }
      ).finally(() => { inFlight-- })
    }

    start()
    for (;;) {
      const canHedge = inFlight < MAX_ATTEMPTS_IN_FLIGHT && nextIndex < candidates.length
      if (canHedge) {
        const hedge = abortAfter(hedgeDelayMs)
        try {
          const outcome = await queue.next(AbortSignal.any([combined, hedge.signal]))
          const result = handle(outcome)
          if (result !== undefined) return result
        } catch {
          if (combined.aborted) throw callerSignal.reason
          start() // the hedge delay elapsed with nothing yet -- start the next gateway too
          continue
        } finally {
          hedge.cancel()
        }
      } else {
        const outcome = await queue.next(combined)
        const result = handle(outcome)
        if (result !== undefined) return result
      }
      if (inFlight === 0 && nextIndex >= candidates.length) return { kind: 'exhausted', lied, retryable, reasons }
      if (inFlight < MAX_ATTEMPTS_IN_FLIGHT) start()
    }

    // Applies one outcome, returning the pass's final result if this one
    // ends it (verified or fatal), or undefined to keep racing.
    function handle (outcome: AttemptOutcome): PassResult | undefined {
      if (outcome.kind === 'verified' || outcome.kind === 'fatal') return outcome
      if (outcome.kind === 'lied') lied = true
      else { retryable = retryable || outcome.retryable; reasons.push(outcome.reason) }
      return undefined
    }
  } finally {
    // Every attempt still running lost the race (or the pass ended without
    // one): freeing its slot and its gateway's health record from further
    // waiting matters more than its answer, which nothing needs any more.
    abandon.abort()
  }
}

/** Throws a ResolutionError: `unsupported` before any gateway is asked, for
 * a CID this build cannot verify at all; otherwise `unverifiable` once a
 * gateway has lied, or `unavailable` when none answered.
 */
export async function fetchVerifiedBlock (cid: CID, deps: FetchDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Uint8Array> {
  try {
    checkCidAccepted(cid)
  } catch (error) {
    throw new ResolutionError('unsupported', (error as Error).message)
  }
  const inline = inlineBlock(cid)
  if (inline !== undefined) {
    try {
      await verifyBlock(cid, inline, deps.limits)
    } catch (error) {
      throw limitFailure(error)
    }
    return inline
  }

  const key = cid.toString()
  let anyLied = false
  const reasons: string[] = []
  // Waiting out a cooldown is not one of the MAX_PASSES real attempts, but
  // it still needs its OWN bound: a signal that aborts mid-wait must end
  // this function, never spin -- sleepOrAbort returns early on abort
  // without throwing, so without this the next loop turn would just call
  // it again, see it return instantly, and spin forever making no progress.
  const MAX_COOLDOWN_WAITS = MAX_PASSES * 2

  let pass = 0
  let cooldownWaits = 0
  while (pass < MAX_PASSES) {
    if (signal.aborted) throw new ResolutionError('unavailable', 'aborted')
    const candidates = deps.pool.candidates()
    if (candidates.length === 0) {
      if (deps.pool.usable().length === 0) break
      cooldownWaits++
      if (cooldownWaits > MAX_COOLDOWN_WAITS) break
      const waitMs = (deps.pool.nextReadyAt() ?? deps.pool.now()) - deps.pool.now()
      if (waitMs > 0) await sleepOrAbort(waitMs, signal)
      continue
    }

    let result: PassResult
    try {
      result = await racePass(candidates, (gateway, attemptSignal) => attemptGateway(gateway, cid, key, deps, attemptSignal, onRefusal), deps.limits.hedgeDelayMs, signal)
    } catch (error) {
      // racePass only ever rejects for the caller's own signal aborting
      // (its own attempts never reject: a bug there surfaces as `fatal`,
      // returned, not thrown) -- wrapped so this function's contract
      // ("throws a ResolutionError") holds regardless of what the signal's
      // own abort reason happens to be.
      throw error instanceof ResolutionError ? error : new ResolutionError('unavailable', error instanceof Error ? error.message : String(error))
    }
    if (result.kind === 'verified') return result.bytes
    if (result.kind === 'fatal') throw result.error
    anyLied = anyLied || result.lied
    reasons.push(...result.reasons)
    pass++
    if (!result.retryable && !result.lied) break
  }

  if (deps.pool.usable().length === 0) throw new ResolutionError('unverifiable', `block ${key}: every gateway was dropped this session for sending bytes that failed their hash`)
  throw new ResolutionError(anyLied ? 'unverifiable' : 'unavailable', `block ${key}: ${reasons.join('; ') || 'no gateway answered'}`)
}

/** Waits `ms`, or returns early if `signal` aborts first -- never rejects,
 * since giving up on a cooldown wait ends the pass loop on its own (the
 * next `candidates()` call finds nothing and the CALLER's own deadline,
 * not this wait, is what should end things). */
async function sleepOrAbort (ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
