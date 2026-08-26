// Key derivation: one seed -> a distinct secret per (label, scope, curve).
//
// THIS FILE IS FROZEN BY GOLDEN VECTORS in ./derive.test.ts. Every app key and
// every named identity a user owns is a pure function of these bytes, and
// ADR-0003 excludes key export -- so a change here does not break a build, it
// silently issues every user a new identity they cannot recover. Read the
// header of the vector table before touching anything below.
//
// WebCrypto, not node:crypto, and no dependency. `globalThis.crypto.subtle` is
// a global that exists in browsers, Node and WASI alike, so this layer outlives
// the engine underneath it (ADR-0002). node:crypto would tie the durable asset
// to the disposable one, which is precisely backwards.

import type { OrivonError, OrivonErrorCode } from '../../contracts/index.js'

/**
 * The two labels are different IN KIND, and conflating them is a recorded past
 * error (capability-api.md SSTwo kinds of identity):
 *
 *   'app'      + origin     -> per-origin, silent. No consent is needed
 *                              precisely because these keys CANNOT link a user
 *                              across apps.
 *   'identity' + identityId -> cross-origin BY DESIGN, behind an explicit
 *                              connect prompt. Nostr requires it: an npub must
 *                              be the SAME on snort.social and noStrudel, or
 *                              follows, posts and identity fragment per client.
 *
 * Deliberately NOT validated at runtime, unlike `curve`. A label is only a
 * domain separator -- any string derives a well-separated key -- so a runtime
 * check would buy nothing the type does not already buy, and the test needs to
 * reach past the type to exercise the byte-level collision that length
 * prefixing exists to prevent.
 */
export type DeriveLabel = 'app' | 'identity'

/**
 * Curves this layer can reduce a scalar for. Adding one is a compatibility
 * event, not a tweak: a new curve string is a new domain separator, so it can
 * only ADD keys, never move an existing one. Removing or renaming one orphans
 * every key already derived under it.
 */
export type DeriveCurve = 'secp256k1' | 'P-256'

export interface DeriveRequest {
  /**
   * The user's root secret. Never leaves the broker, and is never exposed to
   * an app at any tier (capability-api.md SSRules that apply to every app).
   */
  readonly seed: Uint8Array
  readonly label: DeriveLabel
  /** The origin for 'app', the identityId for 'identity'. Free-form by design. */
  readonly scope: string
  readonly curve: DeriveCurve
}

/**
 * Version tag, carried as the HKDF salt so it domain-separates everything
 * derived under it in one place. A v2 construction changes THIS STRING and
 * adds vectors beside the existing ones -- it never edits them, because every
 * key already in the world was derived under v1.
 */
const KDF_SALT = new TextEncoder().encode('orivon-kdf-v1')

/**
 * 384 bits, then reduced into [1, n-1]. The 128 bits of headroom over the
 * 256-bit scalar are what make the reduction's bias negligible (FIPS 186-5
 * A.2.1, "extra random bits", which requires at least 64).
 *
 * The alternative -- take 256 bits and retry when out of range -- is exactly
 * uniform but adds a branch that fires with probability ~2^-32 on P-256, so it
 * would ship untested and unreachable for the life of the product. An
 * untestable branch in key derivation is worse than a 2^-64 bias.
 */
const OKM_BITS = 384

/**
 * Group orders. Verified 2026-08-26 against the (n-1)G = -G identity: for both
 * curves, the public point for d = n-1 shares its X with the generator and has
 * the negated Y. A wrong order constant silently skews the scalar
 * distribution, so it is checked rather than trusted.
 */
const CURVE_ORDER: Readonly<Record<DeriveCurve, bigint>> = {
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  'P-256': 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
}

/**
 * A seed shorter than this cannot carry 256 bits of entropy no matter what the
 * KDF does. Checked here rather than trusted from the caller, because the one
 * place a weak seed would be noticed is the one place nobody looks.
 */
const MIN_SEED_BYTES = 32

const SCALAR_BYTES = 32

function fail(code: OrivonErrorCode, message: string): OrivonError {
  // OrivonError is an interface, not a class, because src/contracts/ emits no
  // runtime code (see contracts/errors.ts). The broker builds the concrete
  // object; `code` is what consumers switch on.
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
 */
function encodeField(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value)
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}

// Returns Uint8Array<ArrayBuffer> rather than plain Uint8Array because
// WebCrypto's BufferSource excludes SharedArrayBuffer-backed views. Everything
// here is freshly allocated, so saying so costs nothing and saves a cast.
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
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

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function bigIntToScalarBytes(value: bigint): Uint8Array<ArrayBuffer> {
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

/**
 * The frozen core. seed + (label, scope, curve) -> a private scalar in
 * [1, n-1].
 *
 * RETURNS SECRET KEY MATERIAL. It is broker-internal and must never cross the
 * contextBridge: raw key export is not a capability at any tier, signed apps
 * included. JavaScript cannot reliably zero this buffer afterwards, so hold it
 * for as short a time as possible and never log it.
 */
export async function derivePrivateScalar(request: DeriveRequest): Promise<Uint8Array> {
  const { seed, label, scope, curve } = request

  if (seed.length < MIN_SEED_BYTES) {
    throw fail('invalid', `seed must be at least ${MIN_SEED_BYTES} bytes, got ${seed.length}`)
  }
  const order = CURVE_ORDER[curve]
  if (order === undefined) {
    throw fail('invalid', `unsupported curve: ${String(curve)}`)
  }

  const info = concat([encodeField(label), encodeField(scope), encodeField(curve)])

  const subtle = globalThis.crypto.subtle
  // The cast is about buffer provenance, not about crypto: TypeScript's
  // BufferSource excludes SharedArrayBuffer-backed views, and the seed reaches
  // us as a plain Uint8Array from the contracts surface. Copying it to satisfy
  // the type would leave a second copy of the ROOT SECRET in memory that
  // JavaScript cannot zero, which is strictly worse. A shared-backed view would
  // still be rejected by WebCrypto at runtime, so the cast fails safe.
  const ikm = await subtle.importKey('raw', seed as Uint8Array<ArrayBuffer>, 'HKDF', false, [
    'deriveBits'
  ])
  const okm = new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: KDF_SALT, info }, ikm, OKM_BITS)
  )

  // Map into [1, n-1]: 0 is not a valid private key on either curve, and a
  // value >= n is not a distinct one.
  return bigIntToScalarBytes((bytesToBigInt(okm) % (order - 1n)) + 1n)
}

/**
 * The public key for a derived scalar, as an uncompressed SEC1 point
 * (0x04 || X || Y, 65 bytes).
 *
 * secp256k1 IS NOT SERVED HERE, and that is the loud limitation of this file.
 * WebCrypto has no secp256k1 at all, and the constraint is "add no dependency",
 * so the only ways to produce an npub from this layer would be to hand-roll
 * scalar multiplication -- variable-time, over a secret scalar, in the file
 * that holds every user's identity -- or to pull in a curve library. Neither is
 * acceptable here, so point derivation for secp256k1 belongs ONE LAYER UP, in
 * src/nostr/, which already needs a secp256k1 implementation for BIP-340
 * Schnorr signing: WebCrypto cannot sign a Nostr event either, so nothing is
 * saved by doing the multiplication here.
 *
 * What this file owns for secp256k1 -- the scalar, frozen by golden vectors --
 * is the part that must never change. The point is a deterministic function of
 * it, so the identity is pinned either way.
 */
export async function derivePublicKey(request: DeriveRequest): Promise<Uint8Array> {
  if (request.curve !== 'P-256') {
    // 'internal', not 'invalid': an app never chooses this path. If it fires,
    // the broker routed a secp256k1 request to the wrong layer.
    throw fail(
      'internal',
      `no public-key derivation for ${request.curve} in the policy layer; ` +
        'derive the point from derivePrivateScalar() one layer up (src/nostr/)'
    )
  }

  const scalar = await derivePrivateScalar(request)
  const subtle = globalThis.crypto.subtle

  // The engine computes the point for us. RFC 5915's ECPrivateKey carries the
  // public key as an OPTIONAL field; omit it and OpenSSL, BoringSSL and NSS all
  // multiply the generator on import. That is the whole trick, and it is why no
  // curve arithmetic appears in this file.
  //
  // extractable: true looks alarming and is not: the scalar is already a plain
  // Uint8Array two lines above, so extractability exposes nothing new. It is
  // required to read the computed point back out.
  const privateKey = await subtle.importKey(
    'pkcs8',
    pkcs8P256(scalar),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  )
  const jwk = await subtle.exportKey('jwk', privateKey)
  if (jwk.x === undefined || jwk.y === undefined) {
    throw fail('internal', 'WebCrypto did not compute the public point on import')
  }

  const publicKey = await subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  )
  return new Uint8Array(await subtle.exportKey('raw', publicKey))
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
 * Every length is fixed because the scalar is fixed-width, so this is a
 * constant prefix rather than a DER encoder.
 */
function pkcs8P256(scalar: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = Uint8Array.from([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
    0x01, 0x04, 0x20
  ])
  return concat([prefix, scalar])
}
