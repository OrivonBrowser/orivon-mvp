// An IPNS record from a gateway, used only once its signature, its key and
// its validity have been checked, and never when older than a record this
// install has already seen for the same key.

import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from 'ipns'
import { ipnsValidator } from 'ipns/validator'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { GatewayFailure, TooLarge, askGateway, readCapped } from './gateways.js'
import type { Fetch, GatewayPool } from './gateways.js'

/** The IPNS spec's own ceiling. */
const MAX_RECORD_BYTES = 10 * 1024

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

/** One source's raw bytes, or `undefined` with its reason appended to
 * `reasons` -- gateways go through `askGateway` (noted against the pool's
 * health, so a 429 or an outage cools that gateway the same way a block
 * fetch would), a name service is a plain, unscheduled fetch. */
async function readSource (
  name: string, kind: 'gateway' | 'name-service', sources: IpnsSources, key: string, fetch: Fetch, timeoutMs: number, signal: AbortSignal, reasons: string[]
): Promise<Uint8Array | undefined> {
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
    if (error instanceof GatewayFailure) { reasons.push(error.message); return undefined }
    reasons.push(error instanceof TooLarge ? `${name} sent more than a record may be` : `${name}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function resolveIpnsKey (key: string, fetch: Fetch, sources: IpnsSources, sequences: SequenceStore, timeoutMs: number, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<VerifiedIpnsRecord> {
  const multihash = CID.parse(key, base36).multihash
  // A key is an inlined public key (identity) or a hash of one (sha2-256); nothing else names an IPNS key.
  if (multihash.code !== 0x00 && multihash.code !== 0x12) throw new ResolutionError('unsupported', `IPNS name ${key} is not a key this build can check`)
  const routingKey = multihashToIPNSRoutingKey(multihash as typeof multihash & { code: 0x00 | 0x12 })
  const floor = sequences.highest(key)
  const reasons: string[] = []
  let lied = false
  // pool.candidates(), not usable(): a cooling gateway (a recent 429 or
  // outage against a block fetch, say) is skipped here too, the same
  // scheduling a block fetch gets. Sequential, with no hedging -- there is
  // at most one IPNS lookup per mount.
  const candidates: Array<{ name: string, kind: 'gateway' | 'name-service' }> =
    [...sources.pool.candidates().map((g) => ({ name: g, kind: 'gateway' as const })), ...sources.nameServices.map((n) => ({ name: n, kind: 'name-service' as const }))]
  for (const source of candidates) {
    const bytes = await readSource(source.name, source.kind, sources, key, fetch, timeoutMs, signal, reasons)
    if (bytes === undefined) continue
    try {
      await ipnsValidator(routingKey, bytes)
    } catch (error) {
      const name = (error as { name?: unknown }).name
      if (typeof name === 'string' && FORGED.has(name)) {
        lied = true
        onRefusal({ source: source.name, resource: `/ipns/${key}` })
        // A name service is never one of the pool's own gateways, so it has
        // nothing to drop there -- it simply cannot lie twice in the SAME
        // call, since there is only ever one candidate per name service.
        if (source.kind === 'gateway') sources.pool.drop(source.name)
      }
      reasons.push(`${source.name}: ${(error as Error).message}`)
      continue
    }
    const record = unmarshalIPNSRecord(bytes)
    if (floor !== undefined && record.sequence < floor) {
      reasons.push(`${source.name} offered sequence ${String(record.sequence)}, older than ${String(floor)} seen before`)
      continue
    }
    sequences.record(key, record.sequence)
    return { key, sequence: record.sequence, value: record.value }
  }
  const rolledBack = floor !== undefined && reasons.some((r) => r.includes('older than'))
  throw new ResolutionError(lied || rolledBack ? 'unverifiable' : 'unavailable', `IPNS name ${key}: ${reasons.join('; ') || 'no source left to ask'}`)
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
