// The wire format underneath key derivation: length-prefixed field encoding
// and the byte<->scalar conversions, split out of ./derive.ts (Rule 2,
// docs/development/code-guidelines.md). Frozen by the same golden vectors as
// derive.ts -- see that file's header before touching anything below.

import type { OrivonError, OrivonErrorCode } from '../../contracts/index.js'

/** Shared because they are stateless; allocating one per field was pure waste. */
const UTF8 = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false })

export const SCALAR_BYTES = 32

function fail (code: OrivonErrorCode, message: string): OrivonError {
  // OrivonError is an interface, not a class, because src/contracts/ emits no
  // runtime code (see contracts/errors.ts). The broker builds the concrete
  // object; `code` is what consumers switch on.
  //
  // No `platformCode`: errors.ts describes it as the underlying engine's own
  // detail (a Node errno, later a WASI code). Nothing underneath failed here --
  // these are policy-layer rejections with no engine error to report -- and
  // inventing one would make an app's fallback logic branch on fiction.
  return Object.assign(new Error(message), { code })
}

/**
 * LENGTH PREFIXING IS NOT DECORATION. Concatenating the fields directly makes
 * ("app", "abc") and ("ap", "pabc") produce the SAME info string and therefore
 * the same scalar -- one secret shared by two schemes, which voids the security
 * argument for both (capability-api.md, security-model.md T8b).
 *
 * Each field is a big-endian uint32 byte length followed by its UTF-8 bytes,
 * which makes the encoding injective: no two distinct field tuples share an
 * encoding.
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
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
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

// Returns Uint8Array<ArrayBuffer> rather than plain Uint8Array because
// WebCrypto's BufferSource excludes SharedArrayBuffer-backed views. Everything
// here is freshly allocated, so saying so costs nothing and saves a cast.
export function concat (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
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
