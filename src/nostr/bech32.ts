// bech32 (BIP-173, the ORIGINAL variant -- not bech32m) encode-only. NIP-19
// specifies npub as "bech32-(not-m)" over a raw 32-byte public key, with no
// TLV metadata -- that is the only encoding this file needs to produce, so
// decoding and the TLV-bearing formats (nprofile/nevent/naddr/nrelay) are not
// implemented; nothing in this lane's scope calls for them, and nsec
// (private key) handling is explicitly excluded by the brief (private key
// material never leaves the broker, capability-api.ts's rules).
//
// CLAUDE.md Rule 6 (prefer mature components) does not apply here the way it
// would for Schnorr signing: this repo ships zero runtime dependencies today
// (Rule 8), bech32 is small and precisely specified, and it is routinely
// hand-rolled elsewhere for exactly that reason -- unlike BIP-340 Schnorr,
// which has real, well-documented footguns this lane is explicitly told not
// to risk.
//
// Transcribed from BIP-173's own reference pseudocode (the polymod generator
// constants, the checksum constant 1 for bech32-not-m, and convertbits) --
// not from any Nostr library. Independently re-verified against NIP-19's
// published examples using a SEPARATE, hand-transcribed Python
// implementation before this file was written; see bech32.test.ts's header.

import { fail } from './errors.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** bech32 (not bech32m) generator polynomial, BIP-173. */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod (values: readonly number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) {
      if (((top >>> i) & 1) !== 0) chk ^= GENERATOR[i]!
    }
  }
  return chk
}

function hrpExpand (hrp: string): number[] {
  const bytes = Array.from(hrp, (char) => char.codePointAt(0)!)
  return [...bytes.map((b) => b >>> 5), 0, ...bytes.map((b) => b & 31)]
}

/** The constant XORed into the checksum polymod: 1 for bech32, 0x2bc830a3 for bech32m. NIP-19 specifies bech32 (not-m). */
const BECH32_CONST = 1

function createChecksum (hrp: string, data: readonly number[]): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ BECH32_CONST
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31)
  return checksum
}

/**
 * Encodes 5-bit words (each 0-31) under the given human-readable prefix.
 * `data` is already split into 5-bit groups -- see npubEncode for the
 * 8-bit-to-5-bit conversion a raw byte string needs first.
 */
export function bech32Encode (hrp: string, data: readonly number[]): string {
  for (const word of data) {
    if (!Number.isInteger(word) || word < 0 || word > 31) {
      throw fail('invalid', `bech32 data word out of range 0-31: ${word}`)
    }
  }
  const combined = [...data, ...createChecksum(hrp, data)]
  return hrp + '1' + combined.map((word) => CHARSET[word]).join('')
}

/**
 * 8-bit bytes -> 5-bit words, BIP-173's convertbits(..., 8, 5, true). The
 * `true` (pad) means a trailing partial group is zero-padded rather than
 * dropped -- required so the conversion is total over any byte length, which
 * is what bech32Encode above assumes of its input.
 */
function eightBitsToFiveBits (bytes: Uint8Array): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffffffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >>> bits) & 31)
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

const NOSTR_PUBKEY_BYTES = 32

/** npub1... from a raw 32-byte public key, for display only (NIP-19). Never accepts or produces a private key. */
export function npubEncode (pubkey: Uint8Array): string {
  if (pubkey.length !== NOSTR_PUBKEY_BYTES) {
    throw fail('invalid', `a Nostr public key is ${NOSTR_PUBKEY_BYTES} bytes, got ${pubkey.length}`)
  }
  return bech32Encode('npub', eightBitsToFiveBits(pubkey))
}
