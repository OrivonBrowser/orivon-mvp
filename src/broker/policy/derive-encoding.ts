// The wire format underneath key derivation: length-prefixed field encoding
// and the byte<->scalar conversions, split out of ./derive.ts (Rule 2,
// docs/development/code-guidelines.md). Frozen by the same golden vectors as
// derive.ts -- see that file's header before touching anything below.

import { concat, frame } from './bytes.js'
import { fail } from './errors.js'

/** Shared because they are stateless; allocating one per field was pure waste. */
const UTF8 = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false })

export const SCALAR_BYTES = 32

/**
 * LENGTH PREFIXING IS NOT DECORATION. Concatenating the fields directly makes
 * ("app", "abc") and ("ap", "pabc") produce the SAME info string and therefore
 * the same scalar -- one secret shared by two schemes, which voids the security
 * argument for both (capability-api.md, security-model.md T8b). See
 * ./bytes.ts's frame() for the shared length-prefix construction.
 *
 * That injectivity holds only for WELL-FORMED strings, which is why the check
 * below exists. `TextEncoder` replaces every unpaired surrogate with U+FFFD, so
 * '\uD800', '\uDC00' and '�' otherwise encode to the same three bytes and
 * derive the SAME SCALAR -- three distinct scopes, one key. Verified: they
 * collided before this check. Rejecting is right rather than clever, because
 * there is no sane canonical key for a string that is not valid Unicode.
 *
 * The length is the UTF-8 BYTE count, never `value.length`. Those differ for
 * every non-ASCII string, and the two are not interchangeable: swapping them
 * changes the derived key for any scope outside ASCII. The golden table carries
 * two deliberately multi-byte rows so that substitution cannot pass the suite.
 */
export function encodeField (value: string): Uint8Array<ArrayBuffer> {
  const bytes = UTF8.encode(value)
  // Round-trip rather than String.prototype.isWellFormed(), which is ES2024
  // and outside this project's ES2023 lib. Decoding back and comparing is the
  // injectivity condition stated directly: if two inputs can produce these
  // bytes, this one does not survive the trip.
  if (UTF8_DECODER.decode(bytes) !== value) {
    throw fail('invalid', 'field is not well-formed Unicode (unpaired surrogate)')
  }
  return frame(bytes)
}

/**
 * The HKDF `info` string: LP(label) || LP(scope) || LP(curve).
 *
 * EXPORTED ONLY SO THE INJECTIVITY PROPERTY CAN BE TESTED DIRECTLY. It is not
 * part of any capability surface and nothing outside this file and its test may
 * call it.
 *
 * The property belongs here rather than behind derivePrivateScalar: injectivity
 * is a fact about the ENCODING, and the runtime curve check now makes the
 * interesting adversarial tuples (a curve string that absorbs part of a scope)
 * unreachable through the KDF. Asserting it here tests the property over
 * arbitrary field values instead of only the handful the closed types admit --
 * which is strictly stronger, since the whole reason for length prefixing is
 * that those sets are expected to grow.
 */
export function encodeDeriveInfo (
  label: string,
  scope: string,
  curve: string
): Uint8Array<ArrayBuffer> {
  return concat([encodeField(label), encodeField(scope), encodeField(curve)])
}

export function bytesToBigInt (bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

export function bigIntToScalarBytes (value: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(SCALAR_BYTES)
  let rest = value
  // Fixed width, zero-padded on the left. A minimal-length encoding would make
  // a scalar with leading zero bytes a different byte string from the same
  // number, and every consumer downstream expects exactly 32.
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}
