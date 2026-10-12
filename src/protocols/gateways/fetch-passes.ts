// One verified answer from a pool of gateways: passes over the gateways that
// are not cooling, each a hedged race (race.ts), until one answer verifies,
// a limit makes the answer fatal, or the passes run out.

import { ResolutionError } from '../resolution/records.js'
import { sleepOrAbort } from '../resolution/timing.js'
import { GatewayFailure } from './gateways.js'
import type { GatewayPool } from './gateways.js'
import { racePass } from './race.js'
import type { AttemptOutcome, PassResult } from './race.js'

/** A pass that met a rate limit, an unreachable gateway or a gateway's own 5xx earns another, up to this many passes in all. */
export const MAX_PASSES = 3

export interface PassDeps {
  readonly pool: GatewayPool
  readonly hedgeDelayMs: number
}

/**
 * What a failed `askGateway` means for the race: a cancelled attempt is
 * never retried, a rate limit, an unreachable gateway or a 5xx earns
 * another pass, and a 5xx marks the gateway `unwell`. Rethrows anything
 * that is not a GatewayFailure.
 */
export function failedAttempt (error: unknown, gateway: string, unwell: Set<string>): AttemptOutcome<never> {
  if (!(error instanceof GatewayFailure)) throw error
  if (error.outcome.kind === 'cancelled') return { kind: 'failed', retryable: false, reason: `${gateway}: cancelled` }
  if (error.outcome.kind === 'server-error') unwell.add(gateway)
  else unwell.delete(gateway)
  return { kind: 'failed', retryable: error.outcome.kind === 'rate-limited' || error.outcome.kind === 'unreachable' || error.outcome.kind === 'server-error', reason: error.message }
}

/**
 * Throws a ResolutionError: `unverifiable` once a gateway has lied,
 * `unavailable` when none answered. `attempt` asks one gateway; it adds the
 * gateway to `unwell` when the answer was a 5xx, and removes it otherwise.
 * `what` names the answer in the error ("block bafy...", "chunk 03b8...").
 */
export async function fetchAcrossGateways<T> (
  what: string,
  deps: PassDeps,
  attempt: (gateway: string, signal: AbortSignal, unwell: Set<string>) => Promise<AttemptOutcome<T>>,
  signal: AbortSignal
): Promise<T> {
  let anyLied = false
  const reasons: string[] = []
  // Waiting out a cooldown is not one of the MAX_PASSES real attempts, but
  // it still needs its OWN bound: a signal that aborts mid-wait must end
  // this function, never spin -- sleepOrAbort returns early on abort
  // without throwing, so without this the next loop turn would just call
  // it again, see it return instantly, and spin forever making no progress.
  const MAX_COOLDOWN_WAITS = MAX_PASSES * 2

  // Gateways whose latest answer in THIS fetch was a 5xx: unwell, not
  // lacking the answer. The next pass waits for them (their cooldown is a
  // few seconds) instead of settling for the gateways that said 404.
  const unwell = new Set<string>()

  let pass = 0
  let cooldownWaits = 0
  while (pass < MAX_PASSES) {
    if (signal.aborted) throw new ResolutionError('unavailable', 'aborted')
    const unwellReadyAt = Math.max(0, ...deps.pool.usable().filter((g) => unwell.has(g)).map((g) => deps.pool.readyAt(g)))
    if (unwellReadyAt > deps.pool.now()) {
      await sleepOrAbort(unwellReadyAt - deps.pool.now(), signal)
      if (signal.aborted) throw new ResolutionError('unavailable', 'aborted')
    }
    const candidates = deps.pool.candidates()
    if (candidates.length === 0) {
      if (deps.pool.usable().length === 0) break
      cooldownWaits++
      if (cooldownWaits > MAX_COOLDOWN_WAITS) break
      const waitMs = (deps.pool.nextReadyAt() ?? deps.pool.now()) - deps.pool.now()
      if (waitMs > 0) await sleepOrAbort(waitMs, signal)
      continue
    }

    let result: PassResult<T>
    try {
      result = await racePass(candidates, (gateway, attemptSignal) => attempt(gateway, attemptSignal, unwell), (leader) => deps.pool.hedgeDelay(leader, deps.hedgeDelayMs), signal)
    } catch (error) {
      // racePass only ever rejects for the caller's own signal aborting
      // (its own attempts never reject: a bug there surfaces as `fatal`,
      // returned, not thrown) -- wrapped so this function's contract
      // ("throws a ResolutionError") holds regardless of what the signal's
      // own abort reason happens to be.
      throw error instanceof ResolutionError ? error : new ResolutionError('unavailable', error instanceof Error ? error.message : String(error))
    }
    if (result.kind === 'verified') return result.value
    if (result.kind === 'fatal') throw result.error
    anyLied = anyLied || result.lied
    reasons.push(...result.reasons)
    pass++
    // A lie alone earns no new pass: the liar is dropped, and every other
    // gateway in this pass has already answered.
    if (!result.retryable && unwell.size === 0) break
  }

  if (deps.pool.usable().length === 0) throw new ResolutionError('unverifiable', `${what}: every gateway was dropped this session for sending bytes that failed their hash`, true)
  throw new ResolutionError(anyLied ? 'unverifiable' : 'unavailable', `${what}: ${reasons.join('; ') || 'no gateway answered'}`, anyLied)
}
