// An IPNS record from a gateway, used only once its signature, its key and
// its validity have been checked, and never when older than a record this
// install has already seen for the same key.

import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from 'ipns'
import { ipnsValidator } from 'ipns/validator'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { sleepOrAbort } from '../resolution/timing.js'
import { GatewayFailure, TooLarge, askGateway, readCapped } from './gateways.js'
import type { Fetch, GatewayPool } from './gateways.js'
import type { IpfsLimits } from './limits.js'
import { racePass } from './race.js'
import type { AttemptOutcome, PassResult } from './race.js'

/** The IPNS spec's own ceiling. */
const MAX_RECORD_BYTES = 10 * 1024
/** Longest a lookup waits for a cooling gateway, well inside a mount's own deadline. */
const MAX_COOLDOWN_WAIT_MS = 5_000

/** A record whose signature failed was forged or corrupted on the way; one that merely expired was not. */
const FORGED = new Set(['SignatureVerificationError', 'InvalidEmbeddedPublicKeyError'])

export interface SequenceStore {
  highest: (key: string) => bigint | undefined
  record: (key: string, sequence: bigint) => void
}

export interface VerifiedIpnsRecord {
  readonly key: string
  readonly sequence: bigint
  readonly value: string
}

/** A w3name-style service's answer: `/name/<key>` returns JSON whose
 * `record` is the signed record in base64. Read with a plain fetch, no
 * pool slot and no health tracking -- there is at most one per mount, and
 * a name service is not one of the gateways cooldowns are scheduled over. */
async function readNameServiceRecord (origin: string, key: string, fetch: Fetch, timeoutMs: number, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(`${origin}/name/${key}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${origin} answered ${String(response.status)}`)
  }
  const body = JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_RECORD_BYTES * 2))) as { record?: unknown }
  if (typeof body.record !== 'string') throw new Error(`${origin}: no record in the answer`)
  return Uint8Array.from(atob(body.record), (c) => c.charCodeAt(0))
}

export interface IpnsSources {
  readonly pool: GatewayPool
  /** Asked after the gateways: some names publish their record only there. */
  readonly nameServices: readonly string[]
}

/** One source's raw bytes -- gateways go through `askGateway` (noted
 * against the pool's health, so a 429 or an outage cools that gateway the
 * same way a block fetch would), a name service is a plain, unscheduled
 * fetch. Throws with the reason it gives. */
async function readSource (name: string, kind: 'gateway' | 'name-service', sources: IpnsSources, key: string, fetch: Fetch, timeoutMs: number, signal: AbortSignal): Promise<Uint8Array> {
  try {
    if (kind === 'gateway') {
      return await askGateway(
        sources.pool, fetch, name,
        { url: `${name}/ipns/${key}?format=ipns-record`, accept: 'application/vnd.ipfs.ipns-record', timeoutMs },
        async (response) => await readCapped(response, MAX_RECORD_BYTES),
        signal
      )
    }
    return await readNameServiceRecord(name, key, fetch, timeoutMs, signal)
  } catch (error) {
    if (error instanceof GatewayFailure) throw error
    throw new Error(error instanceof TooLarge ? `${name} sent more than a record may be` : `${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Gateways that are not cooling. When every usable one is, waits once for
 * the soonest (bounded), then asks the cooling ones anyway: there is one
 * lookup per mount, so skipping them all would fail the mount untried. */
async function gatewaysToAsk (pool: GatewayPool, timeoutMs: number, signal: AbortSignal): Promise<string[]> {
  const ready = pool.candidates()
  if (ready.length > 0 || pool.usable().length === 0) return ready
  const waitMs = Math.min((pool.nextReadyAt() ?? pool.now()) - pool.now(), timeoutMs, MAX_COOLDOWN_WAIT_MS)
  if (waitMs > 0) await sleepOrAbort(waitMs, signal)
  const after = pool.candidates()
  return after.length > 0 ? after : pool.usable()
}

/** Throws a ResolutionError: `unverifiable` once a source has lied or every
 * record offered is older than one seen before, otherwise `unavailable`. */
export async function resolveIpnsKey (
  key: string, fetch: Fetch, sources: IpnsSources, sequences: SequenceStore,
  limits: Pick<IpfsLimits, 'blockTimeoutMs' | 'hedgeDelayMs'>, signal: AbortSignal, onRefusal: (refusal: Refusal) => void
): Promise<VerifiedIpnsRecord> {
  const multihash = CID.parse(key, base36).multihash
  // A key is an inlined public key (identity) or a hash of one (sha2-256); nothing else names an IPNS key.
  if (multihash.code !== 0x00 && multihash.code !== 0x12) throw new ResolutionError('unsupported', `IPNS name ${key} is not a key this build can check`)
  const routingKey = multihashToIPNSRoutingKey(multihash as typeof multihash & { code: 0x00 | 0x12 })
  const floor = sequences.highest(key)
  const nameServices = new Set(sources.nameServices)

  const attempt = async (source: string, attemptSignal: AbortSignal): Promise<AttemptOutcome<VerifiedIpnsRecord>> => {
    let bytes: Uint8Array
    try {
      bytes = await readSource(source, nameServices.has(source) ? 'name-service' : 'gateway', sources, key, fetch, limits.blockTimeoutMs, attemptSignal)
    } catch (error) {
      return { kind: 'failed', retryable: false, reason: (error as Error).message }
    }
    try {
      await ipnsValidator(routingKey, bytes)
    } catch (error) {
      const name = (error as { name?: unknown }).name
      if (typeof name === 'string' && FORGED.has(name)) {
        onRefusal({ source, resource: `/ipns/${key}` })
        // A name service is never one of the pool's gateways, so there is nothing to drop.
        if (!nameServices.has(source)) sources.pool.drop(source)
        return { kind: 'lied', reason: `${source}: ${(error as Error).message}` }
      }
      return { kind: 'failed', retryable: false, reason: `${source}: ${(error as Error).message}` }
    }
    const record = unmarshalIPNSRecord(bytes)
    if (floor !== undefined && record.sequence < floor) {
      return { kind: 'failed', retryable: false, reason: `${source} offered sequence ${String(record.sequence)}, older than ${String(floor)} seen before` }
    }
    return { kind: 'verified', value: { key, sequence: record.sequence, value: record.value } }
  }

  // Raced like a block, so a gateway that hangs costs the hedge delay, not its whole timeout.
  const gateways = await gatewaysToAsk(sources.pool, limits.blockTimeoutMs, signal)
  let result: PassResult<VerifiedIpnsRecord>
  try {
    result = await racePass([...gateways, ...sources.nameServices], attempt, limits.hedgeDelayMs, signal)
  } catch (error) {
    // racePass rejects only for the caller's own signal.
    throw new ResolutionError('unavailable', `IPNS name ${key}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.kind === 'fatal') throw result.error
  if (result.kind === 'verified') {
    sequences.record(key, result.value.sequence)
    return result.value
  }
  const rolledBack = floor !== undefined && result.reasons.some((r) => r.includes('older than'))
  throw new ResolutionError(result.lied || rolledBack ? 'unverifiable' : 'unavailable', `IPNS name ${key}: ${result.reasons.join('; ') || 'no source left to ask'}`)
}

/** Highest sequences for this session only; the verifier host supplies a persistent one. */
export function memorySequenceStore (): SequenceStore {
  const highest = new Map<string, bigint>()
  return {
    highest: (key) => highest.get(key),
    record: (key, sequence) => {
      const current = highest.get(key)
      if (current === undefined || sequence > current) highest.set(key, sequence)
    }
  }
}
