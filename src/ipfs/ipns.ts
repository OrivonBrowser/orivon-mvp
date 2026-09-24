// An IPNS record from a gateway, used only once its signature, its key and
// its validity have been checked, and never when older than a record this
// install has already seen for the same key.

import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from 'ipns'
import { ipnsValidator } from 'ipns/validator'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { ResolutionError } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { TooLarge, readCapped } from './gateways.js'
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

/** Where a signed record may be asked for. Every source is trusted for availability only. */
interface RecordSource {
  readonly name: string
  readonly url: (key: string) => string
  readonly accept: string
  readonly read: (response: Response) => Promise<Uint8Array>
  readonly drop: () => void
}

function gatewaySource (gateway: string, pool: GatewayPool): RecordSource {
  return {
    name: gateway,
    url: (key) => `${gateway}/ipns/${key}?format=ipns-record`,
    accept: 'application/vnd.ipfs.ipns-record',
    read: async (response) => await readCapped(response, MAX_RECORD_BYTES),
    drop: () => { pool.drop(gateway) }
  }
}

/** A w3name-style service: `/name/<key>` answering JSON whose `record` is the signed record in base64. */
function nameServiceSource (origin: string): RecordSource {
  return {
    name: origin,
    url: (key) => `${origin}/name/${key}`,
    accept: 'application/json',
    read: async (response) => {
      const body = JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_RECORD_BYTES * 2))) as { record?: unknown }
      if (typeof body.record !== 'string') throw new Error('no record in the answer')
      return Uint8Array.from(atob(body.record), (c) => c.charCodeAt(0))
    },
    drop: () => {}
  }
}

export interface IpnsSources {
  readonly pool: GatewayPool
  /** Asked after the gateways: some names publish their record only there. */
  readonly nameServices: readonly string[]
}

export async function resolveIpnsKey (key: string, fetch: Fetch, sources: IpnsSources, sequences: SequenceStore, timeoutMs: number, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<VerifiedIpnsRecord> {
  const multihash = CID.parse(key, base36).multihash
  // A key is an inlined public key (identity) or a hash of one (sha2-256); nothing else names an IPNS key.
  if (multihash.code !== 0x00 && multihash.code !== 0x12) throw new ResolutionError('unsupported', `IPNS name ${key} is not a key this build can check`)
  const routingKey = multihashToIPNSRoutingKey(multihash as typeof multihash & { code: 0x00 | 0x12 })
  const floor = sequences.highest(key)
  const reasons: string[] = []
  let lied = false
  const candidates = [...sources.pool.usable().map((g) => gatewaySource(g, sources.pool)), ...sources.nameServices.map(nameServiceSource)]
  for (const source of candidates) {
    let bytes: Uint8Array
    try {
      const response = await sources.pool.withSlot(async () => await fetch(source.url(key), {
        headers: { accept: source.accept },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      }))
      if (!response.ok) {
        await response.body?.cancel()
        reasons.push(`${source.name} answered ${String(response.status)}`)
        continue
      }
      bytes = await source.read(response)
    } catch (error) {
      reasons.push(error instanceof TooLarge ? `${source.name} sent more than a record may be` : `${source.name}: ${(error as Error).message}`)
      continue
    }
    try {
      await ipnsValidator(routingKey, bytes)
    } catch (error) {
      const name = (error as { name?: unknown }).name
      if (typeof name === 'string' && FORGED.has(name)) {
        lied = true
        onRefusal({ source: source.name, resource: `/ipns/${key}` })
        source.drop()
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
