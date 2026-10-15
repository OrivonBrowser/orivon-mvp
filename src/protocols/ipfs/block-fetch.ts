// One verified block, fetched from whichever gateway answers first --
// hedged against a slow one, retried across a cooling one, never against a
// gateway that has lied (the passes are ../gateways/fetch-passes.ts).

import type { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { askGateway, readCapped } from '../gateways/gateways.js'
import type { Fetch, GatewayPool } from '../gateways/gateways.js'
import type { IpfsLimits } from './limits.js'
import { BlockRefused, checkCidAccepted, inlineBlock, verifyBlock } from './verify-block.js'
import { failedAttempt, fetchAcrossGateways, retryWhileWanted } from '../gateways/fetch-passes.js'
import type { AttemptOutcome } from '../gateways/race.js'
import type { PatientRetry } from '../gateways/fetch-passes.js'
import type { RoutePace } from '../route-pace.js'

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
      { url: `${gateway}/ipfs/${key}?format=raw`, accept: 'application/vnd.ipld.raw', timeoutMs: deps.limits.blockTimeoutMs, maxBytes: deps.limits.maxBlockBytes },
      async (response, progress) => await readCapped(response, deps.limits.maxBlockBytes, progress),
      signal
    )
  } catch (error) {
    return failedAttempt(error, gateway, unwell, !deps.pool.serverErrorsAreAnswers)
  }
  unwell.delete(gateway)
  try {
    await verifyBlock(cid, bytes, deps.limits)
  } catch (error) {
    if (error instanceof BlockRefused && error.reason === 'mismatch') {
      onRefusal({ source: gateway, resource: key })
      deps.pool.refuse(gateway)
      return { kind: 'lied', reason: `${gateway} sent bytes that failed their hash` }
    }
    return { kind: 'fatal', error: limitFailure(error) }
  }
  return { kind: 'verified', value: bytes }
}

/** `retry` as written for a direct connection, for the route: a slow one gets more tries (up to three times as many) and keeps starting them for longer, since a lookup that missed there may well find on the next. */
export function retryOn (retry: PatientRetry, route: RoutePace): PatientRetry {
  return { ...retry, maxRetries: Math.round(retry.maxRetries * Math.min(3, route.scale())), startByMs: route.wait(retry.startByMs) }
}

/** Throws a ResolutionError: `unsupported` before any gateway is asked, for
 * a CID this build cannot verify at all; otherwise `unverifiable` once a
 * gateway has lied, or `unavailable` when none answered, after the patient
 * retries `limits.blockRetry` allows (a local node's) are spent.
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
  const once = async (): Promise<Uint8Array> => await fetchAcrossGateways(`block ${key}`, { pool: deps.pool, hedgeDelayMs: deps.limits.hedgeDelayMs }, (gateway, attemptSignal, unwell) => attemptGateway(gateway, cid, key, deps, attemptSignal, onRefusal, unwell), signal)
  const { blockRetry } = deps.limits
  return blockRetry === undefined ? await once() : await retryWhileWanted(once, retryOn(blockRetry, deps.pool.route), () => deps.pool.now(), signal)
}
