// Lowercase-hex encode/decode. The same idea as bundle-hash.ts's
// toLowercaseHex, on the other side of the src/broker/ <-> src/nostr/ import
// boundary this README forbids crossing -- see errors.ts's header for why
// that makes a small local duplicate the correct outcome here, not an
// oversight.

import { fail } from './errors.js'

export function toLowercaseHex (bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const HEX_PAIR = /^[0-9a-fA-F]{2}$/

/** Rejects (code 'invalid') anything that is not an even-length string of hex digits. */
export function hexToBytes (hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw fail('invalid', `hex string has an odd length: ${hex.length}`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2)
    if (!HEX_PAIR.test(pair)) {
      throw fail('invalid', `not a valid hex byte at offset ${i * 2}: ${JSON.stringify(pair)}`)
    }
    out[i] = Number.parseInt(pair, 16)
  }
  return out
}
