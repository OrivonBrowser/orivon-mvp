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

export async function resolveIpnsKey (key: string, fetch: Fetch, pool: GatewayPool, sequences: SequenceStore, timeoutMs: number, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<VerifiedIpnsRecord> {
  const multihash = CID.parse(key, base36).multihash
  // A key is an inlined public key (identity) or a hash of one (sha2-256); nothing else names an IPNS key.
  if (multihash.code !== 0x00 && multihash.code !== 0x12) throw new ResolutionError('unsupported', `IPNS name ${key} is not a key this build can check`)
  const routingKey = multihashToIPNSRoutingKey(multihash as typeof multihash & { code: 0x00 | 0x12 })
  const floor = sequences.highest(key)
  const reasons: string[] = []
  let lied = false
  for (const gateway of pool.usable()) {
    let bytes: Uint8Array
    try {
      const response = await pool.withSlot(async () => await fetch(`${gateway}/ipns/${key}?format=ipns-record`, {
        headers: { accept: 'application/vnd.ipfs.ipns-record' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      }))
      if (!response.ok) {
        await response.body?.cancel()
        reasons.push(`${gateway} answered ${String(response.status)}`)
        continue
      }
      bytes = await readCapped(response, MAX_RECORD_BYTES)
    } catch (error) {
      reasons.push(error instanceof TooLarge ? `${gateway} sent more than a record may be` : `${gateway}: ${(error as Error).message}`)
      continue
    }
    try {
      await ipnsValidator(routingKey, bytes)
    } catch (error) {
      const name = (error as { name?: unknown }).name
      if (typeof name === 'string' && FORGED.has(name)) {
        lied = true
        onRefusal({ source: gateway, resource: `/ipns/${key}` })
        pool.drop(gateway)
      }
      reasons.push(`${gateway}: ${(error as Error).message}`)
      continue
    }
    const record = unmarshalIPNSRecord(bytes)
    if (floor !== undefined && record.sequence < floor) {
      reasons.push(`${gateway} offered sequence ${String(record.sequence)}, older than ${String(floor)} seen before`)
      continue
    }
    sequences.record(key, record.sequence)
    return { key, sequence: record.sequence, value: record.value }
  }
  const rolledBack = floor !== undefined && reasons.some((r) => r.includes('older than'))
  throw new ResolutionError(lied || rolledBack ? 'unverifiable' : 'unavailable', `IPNS name ${key}: ${reasons.join('; ') || 'no gateway left to ask'}`)
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
