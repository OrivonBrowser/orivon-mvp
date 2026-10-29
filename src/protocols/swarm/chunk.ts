// Swarm's two chunk kinds and the checks that make a gateway's bytes
// trustworthy. A content-addressed chunk (CAC) is an eight-byte span and up to
// 4096 bytes of payload, addressed by the BMT hash of both. A single-owner
// chunk (SOC) wraps a CAC under an owner's signature.

import { keccak_256 as keccak } from '@noble/hashes/sha3.js'
import { bytesToHex, concatBytes, hexToBytes, recoverMessageAddress } from 'viem'
import { ResolutionError } from '../resolution/records.js'

export const CHUNK_PAYLOAD_BYTES = 4096
export const SPAN_BYTES = 8
export const MAX_CHUNK_BYTES = SPAN_BYTES + CHUNK_PAYLOAD_BYTES
export const REFERENCE_BYTES = 32
const SIGNATURE_BYTES = 65
export const MAX_SOC_BYTES = REFERENCE_BYTES + SIGNATURE_BYTES + MAX_CHUNK_BYTES

/** Zero-padded payload blocks are hashed in pairs of 32-byte segments, seven levels deep. */
const BLOCK_BYTES = 64
const SEGMENT_BYTES = 32
const BMT_LEVELS = 7
const MAX_BLOCKS = CHUNK_PAYLOAD_BYTES / BLOCK_BYTES

/** ZERO_SUBTREES[k] is the hash of an all-zero subtree after k hashing levels, so the unused tail of a short payload costs nothing. */
const ZERO_SUBTREES: Uint8Array[] = [new Uint8Array(0)]
ZERO_SUBTREES.push(keccak(new Uint8Array(BLOCK_BYTES)))
for (let level = 2; level <= BMT_LEVELS; level++) {
  const below = ZERO_SUBTREES[level - 1]!
  ZERO_SUBTREES.push(keccak(concatBytes([below, below])))
}

/**
 * The root of the binary Merkle tree over a payload zero-padded to 4096 bytes.
 * Every chunk read is hashed here, so the tree lives in one buffer, level by
 * level: a pair's hash is written at half the pair's offset, over bytes of
 * pairs already hashed.
 */
export function bmtRoot (payload: Uint8Array): Uint8Array {
  if (payload.length > CHUNK_PAYLOAD_BYTES) throw new RangeError(`a chunk holds at most ${String(CHUNK_PAYLOAD_BYTES)} bytes`)
  if (payload.length === 0) return ZERO_SUBTREES[BMT_LEVELS]!
  const nodes = new Uint8Array(MAX_BLOCKS * SEGMENT_BYTES)
  let count = Math.ceil(payload.length / BLOCK_BYTES)
  const whole = Math.floor(payload.length / BLOCK_BYTES)
  for (let i = 0; i < whole; i++) nodes.set(keccak(payload.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES)), i * SEGMENT_BYTES)
  if (whole < count) {
    const padded = new Uint8Array(BLOCK_BYTES)
    padded.set(payload.subarray(whole * BLOCK_BYTES))
    nodes.set(keccak(padded), whole * SEGMENT_BYTES)
  }
  for (let level = 2; level <= BMT_LEVELS; level++) {
    if (count % 2 === 1) nodes.set(ZERO_SUBTREES[level - 1]!, count * SEGMENT_BYTES)
    count = Math.ceil(count / 2)
    for (let i = 0; i < count; i++) nodes.set(keccak(nodes.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES)), i * SEGMENT_BYTES)
  }
  return nodes.slice(0, SEGMENT_BYTES)
}

/** Whether `bytes` are all zero: the only thing that may follow a payload without changing its chunk's address. */
export function isZeroPadding (bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0)
}

/** The address a CAC (span, then payload) must be served under, as 32 bytes. */
export function cacAddress (chunk: Uint8Array): Uint8Array {
  return keccak(concatBytes([chunk.subarray(0, SPAN_BYTES), bmtRoot(chunk.subarray(SPAN_BYTES))]))
}

/** Whether `chunk` is the CAC whose address is `address` (lowercase hex). */
export function verifyCac (address: string, chunk: Uint8Array): boolean {
  if (chunk.length < SPAN_BYTES || chunk.length > MAX_CHUNK_BYTES) return false
  return bytesToHex(cacAddress(chunk)).slice(2) === address
}

export interface Span {
  /** The bytes of content under this chunk. */
  readonly size: number
  /** The erasure-coding level an intermediate chunk declares, 0 when none. */
  readonly level: number
}

const MAX_REDUNDANCY_LEVEL = 4

/**
 * A chunk's span. The top byte is a redundancy level (128 + level) when it
 * is over 128; the size is then the low seven bytes. Throws a ResolutionError
 * for a size no file can have.
 */
export function readSpan (chunk: Uint8Array): Span {
  const top = chunk[SPAN_BYTES - 1]!
  const level = top > 128 ? top - 128 : 0
  if (level > MAX_REDUNDANCY_LEVEL) throw new ResolutionError('unverifiable', `a chunk declares redundancy level ${String(level)}`)
  let size = 0n
  for (let i = SPAN_BYTES - 1; i >= 0; i--) size = (size << 8n) | BigInt(i === SPAN_BYTES - 1 && level > 0 ? 0 : chunk[i]!)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ResolutionError('unverifiable', 'a chunk declares a size no file can have')
  return { size: Number(size), level }
}

export interface VerifiedSoc {
  /** Lowercase hex, 40 characters. */
  readonly owner: string
  /** The wrapped content-addressed chunk, span and payload. */
  readonly wrapped: Uint8Array
  /** The whole single-owner chunk as it was checked, which is what is kept to check again. */
  readonly chunk: Uint8Array
}

/**
 * A single-owner chunk is its 32-byte id, a 65-byte signature, and a CAC. The
 * signature is over keccak256(id, address of the CAC) as an Ethereum signed
 * message; the chunk's address is keccak256(id, the signer). Undefined unless
 * `address` is exactly that.
 */
export async function verifySoc (address: string, chunk: Uint8Array): Promise<VerifiedSoc | undefined> {
  if (chunk.length < REFERENCE_BYTES + SIGNATURE_BYTES + SPAN_BYTES || chunk.length > MAX_SOC_BYTES) return undefined
  const id = chunk.subarray(0, REFERENCE_BYTES)
  const signature = chunk.subarray(REFERENCE_BYTES, REFERENCE_BYTES + SIGNATURE_BYTES)
  const wrapped = chunk.subarray(REFERENCE_BYTES + SIGNATURE_BYTES)
  let owner: string
  try {
    const digest = keccak(concatBytes([id, cacAddress(wrapped)]))
    owner = await recoverMessageAddress({ message: { raw: digest }, signature: bytesToHex(signature) })
  } catch {
    return undefined
  }
  const signer = owner.slice(2).toLowerCase()
  if (bytesToHex(keccak(concatBytes([id, hexToBytes(`0x${signer}`)]))).slice(2) !== address) return undefined
  return { owner: signer, wrapped, chunk }
}

/** The address of update `index` of a feed, as lowercase hex: keccak256(id, owner) for id = keccak256(topic, index as eight big-endian bytes). */
export function feedUpdateAddress (owner: string, topic: string, index: bigint): string {
  const at = new Uint8Array(8)
  new DataView(at.buffer).setBigUint64(0, index, false)
  const id = keccak(concatBytes([hexToBytes(`0x${topic}`), at]))
  return bytesToHex(keccak(concatBytes([id, hexToBytes(`0x${owner}`)]))).slice(2)
}
