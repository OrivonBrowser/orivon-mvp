// One verified block, fetched from whichever gateway answers first --
// hedged against a slow one, retried across a cooling one, never against a
// gateway that has lied.

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import { sleepOrAbort } from '../resolution/timing.js'
import type { Refusal } from '../resolution/providers.js'
import { GatewayFailure, askGateway, readCapped } from './gateways.js'
import type { Fetch, GatewayPool } from './gateways.js'
import type { IpfsLimits } from './limits.js'
import { BlockRefused, checkCidAccepted, inlineBlock, verifyBlock } from './verify-block.js'
import { racePass } from './race.js'
import type { AttemptOutcome, PassResult } from './race.js'

/** A pass that met a rate limit, an unreachable gateway or a gateway's own 5xx earns another, up to this many passes in all. */
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

async function attemptGateway (gateway: string, cid: CID, key: string, deps: FetchDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void, unwell: Set<string>): Promise<AttemptOutcome<Uint8Array>> {
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
    if (error.outcome.kind === 'cancelled') return { kind: 'failed', retryable: false, reason: `${gateway}: cancelled` }
    if (error.outcome.kind === 'server-error') unwell.add(gateway)
    else unwell.delete(gateway)
    return { kind: 'failed', retryable: error.outcome.kind === 'rate-limited' || error.outcome.kind === 'unreachable' || error.outcome.kind === 'server-error', reason: error.message }
  }
  unwell.delete(gateway)
  try {
    await verifyBlock(cid, bytes, deps.limits)
  } catch (error) {
    if (error instanceof BlockRefused && error.reason === 'mismatch') {
      onRefusal({ source: gateway, resource: key })
      deps.pool.drop(gateway)
      return { kind: 'lied', reason: `${gateway} sent bytes that failed their hash` }
    }
    return { kind: 'fatal', error: limitFailure(error) }
  }
  return { kind: 'verified', value: bytes }
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

  // Gateways whose latest answer in THIS fetch was a 5xx: unwell, not
  // lacking the block. The next pass waits for them (their cooldown is a
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

    let result: PassResult<Uint8Array>
    try {
      result = await racePass(candidates, (gateway, attemptSignal) => attemptGateway(gateway, cid, key, deps, attemptSignal, onRefusal, unwell), deps.limits.hedgeDelayMs, signal)
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

  if (deps.pool.usable().length === 0) throw new ResolutionError('unverifiable', `block ${key}: every gateway was dropped this session for sending bytes that failed their hash`)
  throw new ResolutionError(anyLied ? 'unverifiable' : 'unavailable', `block ${key}: ${reasons.join('; ') || 'no gateway answered'}`)
}
