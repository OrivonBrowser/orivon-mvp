/**
 * Swarm sequence-feed updates, built without Bee: the topic of a site, the identifier and address of each update, the
 * BMT hash of a chunk, and the signed single-owner chunk that carries "this site is now that reference". The reader in
 * `src/protocols/swarm/chunk.ts` accepts exactly what this builds; the unit test checks it against that code.
 */
import { bytesToHex, concat, hexToBytes, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const PAYLOAD_BYTES = 4096
const BLOCK_BYTES = 64
/** A legacy update's payload: an eight-byte timestamp and a 32-byte reference. Every Bee version resolves it. */
const LEGACY_SPAN = 40

/** @param {Uint8Array} bytes @returns {Uint8Array} */
const keccak = (bytes) => keccak256(bytes, 'bytes')
/** @param {Uint8Array} bytes @returns {string} lowercase hex, no prefix */
const hex = (bytes) => bytesToHex(bytes).slice(2)
/** @param {string} text @returns {Uint8Array} */
const fromHex = (text) => hexToBytes(`0x${text}`)

/** @param {number} n @returns {Uint8Array} eight big-endian bytes */
function uint64be (n) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)
  return out
}

/**
 * The root of the binary Merkle tree over a payload zero-padded to 4096 bytes: 64-byte blocks hashed, then pairs of
 * hashes, seven levels in all.
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function bmtRoot (payload) {
  if (payload.length > PAYLOAD_BYTES) throw new RangeError('a chunk holds at most 4096 bytes')
  const padded = new Uint8Array(PAYLOAD_BYTES)
  padded.set(payload)
  /** @type {Uint8Array[]} */
  let level = []
  for (let at = 0; at < PAYLOAD_BYTES; at += BLOCK_BYTES) level.push(keccak(padded.subarray(at, at + BLOCK_BYTES)))
  while (level.length > 1) {
    /** @type {Uint8Array[]} */
    const next = []
    for (let i = 0; i < level.length; i += 2) next.push(keccak(concat([/** @type {Uint8Array} */ (level[i]), /** @type {Uint8Array} */ (level[i + 1])])))
    level = next
  }
  return /** @type {Uint8Array} */ (level[0])
}

/**
 * The address of a content-addressed chunk.
 * @param {Uint8Array} span
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export const cacAddress = (span, payload) => keccak(concat([span, bmtRoot(payload)]))

/** @param {string} key an IPNS key name @returns {string} the 64-hex topic of that site's feed */
export const topicOf = (key) => hex(keccak(toBytes(`orivon-site/${key}`)))

/** @param {string} topic @param {number} index @returns {Uint8Array} */
export const identifierOf = (topic, index) => keccak(concat([fromHex(topic), uint64be(index)]))

/** @param {string} topic @param {number} index @returns {string} lowercase hex */
export const identifierHex = (topic, index) => hex(identifierOf(topic, index))

/**
 * @param {string} privateKey 64 hex characters
 * @returns {{ owner: string, address: string }} the owner as lowercase hex for URLs, and as the checksummed 0x address
 */
export function ownerOf (privateKey) {
  const account = privateKeyToAccount(`0x${privateKey}`)
  return { owner: account.address.slice(2).toLowerCase(), address: account.address }
}

/**
 * Update `index` of a site's feed: a single-owner chunk wrapping a legacy payload, signed as an Ethereum message over
 * keccak256(identifier, address of the wrapped chunk).
 * @param {{ privateKey: string, topic: string, index: number, reference: string, timestamp: number }} input reference is 64 hex, timestamp in seconds
 * @returns {Promise<{ owner: string, identifier: string, signature: string, data: string, address: string }>} `data` is span and payload, `address` the chunk's address, all lowercase hex without a prefix
 */
export async function buildUpdate ({ privateKey, topic, index, reference, timestamp }) {
  if (!/^[0-9a-f]{64}$/.test(reference)) throw new RangeError('a reference is 64 lowercase hex characters')
  const account = privateKeyToAccount(`0x${privateKey}`)
  const owner = account.address.slice(2).toLowerCase()
  const identifier = identifierOf(topic, index)
  const span = new Uint8Array(8)
  span[0] = LEGACY_SPAN
  const payload = concat([uint64be(timestamp), fromHex(reference)])
  const digest = keccak(concat([identifier, cacAddress(span, payload)]))
  const signature = await account.signMessage({ message: { raw: digest } })
  return {
    owner,
    identifier: hex(identifier),
    signature: signature.slice(2),
    data: hex(concat([span, payload])),
    address: hex(keccak(concat([identifier, fromHex(owner)])))
  }
}
