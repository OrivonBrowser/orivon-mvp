// Split out of ./derive.ts (Rule 2) -- frozen by the same golden vectors;
// read that file's header before changing anything below. Why secp256k1
// isn't served here: README.md, Design notes.

import { concat } from './bytes.js'
import { SCALAR_BYTES } from './derive-encoding.js'
import { derivePrivateScalar, isSupportedCurve, subtleCrypto, viaWebCrypto } from './derive.js'
import type { DeriveRequest } from './derive.js'
import { fail } from './errors.js'

/**
 * The curve gate every P-256-only entry point in this file shares. Two
 * different failures, two different codes, and this is the one place that
 * distinction is made: an unknown curve is the app's doing -- the contract
 * types `curve` as a free-form string -- so it is 'invalid'. A well-formed
 * OTHER curve (secp256k1) is the broker's doing: the app never chooses which
 * layer serves it, so routing it here is a wiring bug, and errors.ts reserves
 * 'internal' for exactly that. Conflating them would both mislabel an app's
 * mistake as a broker fault and, since errors.ts says 'internal' is always
 * logged, let an app fill the log by looping on a misspelled curve.
 *
 * `what` names the specific operation for the 'internal' message only --
 * `derivePublicKey` and `signWithP256` share this reasoning, not merely this
 * shape (code-guidelines.md Rule 3).
 */
function requireP256 (curve: unknown, what: string): asserts curve is 'P-256' {
  if (!isSupportedCurve(curve)) {
    // String() before JSON.stringify: JSON.stringify throws on a BigInt, and a
    // BigInt survives structured clone, so an app could turn this rejection
    // into a raw TypeError carrying no OrivonErrorCode at all.
    throw fail('invalid', `unsupported curve: ${JSON.stringify(String(curve))}`)
  }
  if (curve !== 'P-256') {
    throw fail(
      'internal',
      `no ${what} for ${curve} in the policy layer -- P-256 only; ` +
        'src/nostr/ is where secp256k1 support for NAMED identities would land (ADR-0010)'
    )
  }
}

/**
 * The public key for a derived scalar, as an uncompressed SEC1 point
 * (0x04 || X || Y, 65 bytes). **P-256 only** -- secp256k1 is deliberately
 * not served here; see this directory's README.md, Design notes, for why.
 */
export async function derivePublicKey (
  request: DeriveRequest & { readonly curve: 'P-256' }
): Promise<Uint8Array> {
  requireP256(request.curve, 'public-key derivation')

  const scalar = await derivePrivateScalar(request)
  const subtle = subtleCrypto()

  // The engine computes the point for us. RFC 5915's ECPrivateKey carries the
  // public key as an OPTIONAL field; omit it and WebCrypto must compute it,
  // because the JWK export of an EC private key is specified to include `x`
  // and `y`. That is the whole trick, and it is why no curve arithmetic
  // appears in this file.
  //
  // extractable: true looks alarming and is not: the scalar is already a plain
  // Uint8Array two lines above, so extractability exposes nothing new. It is
  // required to read the computed point back out.
  const privateKey = await viaWebCrypto('P-256 private key import', () =>
    subtle.importKey('pkcs8', pkcs8P256(scalar), { name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign'
    ])
  )
  const jwk = await viaWebCrypto<JsonWebKey>('JWK export', () =>
    subtle.exportKey('jwk', privateKey)
  )
  // Hoisted out of the closure below on purpose. Narrowing a PROPERTY does not
  // survive into a callback -- TypeScript cannot prove `jwk` was not reassigned
  // -- so `jwk.x` would widen back to `string | undefined` inside the arrow,
  // and `exactOptionalPropertyTypes` then rejects passing it to an optional
  // `x?: string`. That rejection silently knocks out the JsonWebKey overload of
  // importKey and reports as the unrelated "'jwk' is not assignable to
  // 'pkcs8' | 'raw' | 'spki'".
  const x = jwk.x
  const y = jwk.y
  if (x === undefined || y === undefined) {
    throw fail('internal', 'WebCrypto did not compute the public point on import')
  }

  const publicKey = await viaWebCrypto<CryptoKey>('public point import', () =>
    subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    )
  )
  return new Uint8Array(
    await viaWebCrypto('public point export', () => subtle.exportKey('raw', publicKey))
  )
}

/**
 * ECDSA/SHA-256 over `payload`, using the P-256 scalar derived for `request`.
 * **P-256 only**, same reason and same gate as `derivePublicKey` above.
 *
 * Raw (r || s), 64 bytes -- WebCrypto's own `sign()` output format for
 * `{ name: 'ECDSA' }`, not DER. No curve arithmetic here either: WebCrypto
 * supplies the nonce and does the signing math, exactly as it computes the
 * public point above.
 *
 * `extractable: false`, unlike `derivePublicKey`'s `importKey` call -- this
 * path only ever calls `sign()` with the key, never reads it back out, so
 * there is nothing here that needs the key extractable.
 */
export async function signWithP256 (
  request: DeriveRequest & { readonly curve: 'P-256' },
  payload: Uint8Array
): Promise<Uint8Array> {
  requireP256(request.curve, 'signing')

  const scalar = await derivePrivateScalar(request)
  const subtle = subtleCrypto()
  const privateKey = await viaWebCrypto('P-256 private key import for signing', () =>
    subtle.importKey('pkcs8', pkcs8P256(scalar), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign'
    ])
  )
  const signature = await viaWebCrypto('ECDSA sign', () =>
    // The cast is the same buffer-provenance point as derivePrivateScalar's
    // own seed cast: BufferSource excludes SharedArrayBuffer-backed views,
    // and `payload` reaches this function as a plain Uint8Array off the
    // contracts surface.
    subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, payload as Uint8Array<ArrayBuffer>)
  )
  return new Uint8Array(signature)
}

/**
 * PKCS#8 for a P-256 private key, with the optional public key omitted.
 *
 *   30 41                                SEQUENCE, 65 bytes
 *     02 01 00                           version 0
 *     30 13                              AlgorithmIdentifier
 *       06 07 2a8648ce3d0201             1.2.840.10045.2.1  id-ecPublicKey
 *       06 08 2a8648ce3d030107           1.2.840.10045.3.1.7  prime256v1
 *     04 27                              OCTET STRING, 39 bytes
 *       30 25                            ECPrivateKey (RFC 5915)
 *         02 01 01                       version 1
 *         04 20 <32-byte scalar>         privateKey
 *
 * Every length above is fixed BECAUSE the scalar is fixed-width, which is what
 * lets this be a constant prefix rather than a DER encoder. The assertion
 * enforces the premise: a scalar of any other length would produce a blob whose
 * declared lengths disagree with its contents, and the failure would surface as
 * an opaque WebCrypto DOMException rather than as the broker bug it is.
 */
function pkcs8P256 (scalar: Uint8Array): Uint8Array<ArrayBuffer> {
  if (scalar.length !== SCALAR_BYTES) {
    throw fail('internal', `PKCS#8 prefix assumes a ${SCALAR_BYTES}-byte scalar`)
  }
  const prefix = Uint8Array.from([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
    0x01, 0x04, 0x20
  ])
  return concat([prefix, scalar])
}
