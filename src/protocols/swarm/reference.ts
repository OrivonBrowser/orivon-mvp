// A Swarm reference is the 32-byte address of a root chunk. Written as 64 hex
// characters it cannot be one host label (63 at most), so its canonical
// spelling is a CIDv1 of codec swarm-manifest (0xfa) over keccak-256, which is
// also what an ENS contenthash holds.

import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { bytesToHex, hexToBytes } from 'viem'

const SWARM_MANIFEST = 0xfa
const KECCAK_256 = 0x1b
const HEX_64 = /^[0-9a-fA-F]{64}$/
const HEX_128 = /^[0-9a-fA-F]{128}$/

/** An encrypted reference (reference and decryption key), which this build does not read. */
export function isEncryptedReference (text: string): boolean {
  return HEX_128.test(text)
}

/** The CID of a reference given as lowercase hex: 61 characters in base32. */
export function referenceCid (reference: string): string {
  return CID.createV1(SWARM_MANIFEST, Digest.create(KECCAK_256, hexToBytes(`0x${reference}`))).toString()
}

/** The reference a CID names, as lowercase hex, when it is a keccak-256 CID of any codec. */
export function referenceOfCid (cid: CID): string | undefined {
  if (cid.multihash.code !== KECCAK_256 || cid.multihash.digest.length !== 32) return undefined
  return bytesToHex(cid.multihash.digest).slice(2)
}

/** A reference written as 64 hex characters in any case, or as a CID: lowercase hex, or undefined. */
export function parseReference (text: string): string | undefined {
  if (HEX_64.test(text)) return text.toLowerCase()
  try {
    return referenceOfCid(CID.parse(text))
  } catch {
    return undefined
  }
}
