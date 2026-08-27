// Key derivation: one seed -> a distinct secret per (label, scope, curve).
//
// THIS FILE IS FROZEN BY GOLDEN VECTORS in ./derive-vectors.json. A change here
// does not break a build -- it silently issues every user a different identity.
// The construction, the reasoning behind each parameter, and the migration path
// for a v2 are recorded once in ADR-0010; read that before touching anything
// below, and do not restate it here.
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

  /**
   * WHERE THIS VALUE COMES FROM IS PART OF THE CONTRACT, because it is frozen
   * into a key that cannot be exported, backed up or migrated in the MVP
   * (ADR-0003). Two spellings of the same thing are two different identities.
   *
   *   label 'app'      -> the canonical origin, as produced by
   *                       `originFromSenderFrame()` in ./origin.ts. NOT
   *                       `URL.origin`: open-questions.md A14 deliberately
   *                       deviates from it (a trailing DNS dot is stripped), so
   *                       the two disagree on real inputs and the wrong one
   *                       silently issues the user a different key.
   *
   *                       `originFromSenderFrame()`, not the `originFromUrl()`
   *                       underneath it. The frame variant cross-checks the
   *                       committed URL against the frame's own origin and
   *                       denies when they disagree; going straight to the URL
   *                       hands a CSP-sandboxed (opaque-origin) document the
   *                       embedding app's grants, this key included (T3/T13b).
   *
   *   label 'identity' -> an opaque, broker-generated identityId. Owner
   *                       decision, 2026-08-27, recorded in ADR-0010: NEVER a
   *                       user-typed name and never derived from one. The
   *                       display name is stored beside the identity, not used
   *                       to derive it -- otherwise renaming an identity, or
   *                       merely changing its case, destroys the npub with no
   *                       way to recover it.
   *
   * Compared byte for byte, so it is case-sensitive and not normalised here.
   * Normalising would be worse: it would silently merge two scopes the caller
   * believes are distinct.
   */
  readonly scope: string
  readonly curve: DeriveCurve
}

/** Shared because they are stateless; allocating one per field was pure waste. */
const UTF8 = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false })

/**
 * Version tag, carried as the HKDF salt so it domain-separates everything
 * derived under it in one place. A v2 changes THIS STRING and adds vectors
 * beside the existing ones (ADR-0010 SSVersioning).
 */
const KDF_SALT = UTF8.encode('orivon-kdf-v1')

/**
 * 384 bits, then reduced into [1, n-1]: FIPS 186-5 A.2.1 "extra random bits",
 * which requires at least 64 bits of headroom over the 256-bit scalar and gets
 * 128. Rejected alternative and full reasoning in ADR-0010.
 */
const OKM_BITS = 384

/**
 * Group orders, on a null prototype. The null prototype is load-bearing, not
 * hygiene: `curve` is the ONLY app-controlled input on this surface -- the
 * public contract types it as a free-form `string`
 * (capability-api.ts `publicKey(opts: { curve: string })`) -- and with an
 * ordinary object literal every inherited key ('__proto__', 'constructor',
 * 'toString', ...) returns something non-undefined and walks straight past an
 * `=== undefined` guard. `noUncheckedIndexedAccess` does not help: TypeScript
 * models missing own-properties, not the prototype chain, so the guard type
 * checks as complete while failing open at runtime.
 *
 * These exact constants are read out of this file and compared against the
 * published decimal orders (SEC 2 v2, FIPS 186-4 D.1.2.3) by
 * scripts/check-vectors.mjs. That is deliberately a check on THIS text rather
 * than on a copy: a wrong order constant silently skews the scalar
 * distribution, and an earlier version of this comment claimed a verification
 * that only ever examined the checker's own duplicate of the values.
 */
const CURVE_ORDER: Readonly<Record<DeriveCurve, bigint>> = Object.freeze(
  Object.assign(Object.create(null) as Record<DeriveCurve, bigint>, {
    secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    'P-256': 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
  })
)

function isSupportedCurve(curve: unknown): curve is DeriveCurve {
  // The `typeof` is not redundant. `Object.hasOwn` runs ToPropertyKey on its
  // argument, so ['P-256'], new String('P-256') and [['P-256']] all coerce to
  // the key 'P-256' and pass -- while still failing a `!== 'P-256'` reference
  // comparison downstream, which sent them into the 'internal' branch that this
  // file explicitly does not want app input to reach. `curve` is
  // structured-cloneable and app-controlled, so a non-string really can arrive.
  return typeof curve === 'string' && Object.hasOwn(CURVE_ORDER, curve)
}

/**
 * A seed shorter than this cannot carry 256 bits of entropy no matter what the
 * KDF does. Checked here rather than trusted from the caller, because the one
 * place a weak seed would be noticed is the one place nobody looks.
 */
const MIN_SEED_BYTES = 32

const SCALAR_BYTES = 32

/**
 * Every WebCrypto call goes through here so that no raw `DOMException` or
 * `TypeError` escapes as the result of a derivation. These functions are the
 * OrivonError boundary: errors.ts tells an app the code is a closed enum it may
 * switch on exhaustively, and a foreign `err.code` (Node hands back
 * 'ERR_INVALID_ARG_TYPE' for a SharedArrayBuffer-backed seed) is worse for that
 * consumer than no code at all.
 *
 * 'internal' is right for all of them: by the time we call WebCrypto the input
 * is validated, so a failure here is a broker fault, not the app's doing.
 */
async function viaWebCrypto<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw Object.assign(fail('internal', `WebCrypto ${what} failed: ${detail}`), { cause })
  }
}

/** Reads `crypto.subtle` with a legible failure if the host has no WebCrypto. */
function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    // Reachable in a browser on plain http, where `crypto.subtle` is gated on a
    // secure context. Not reachable in Electron's main process, but this layer
    // is written to outlive it (ADR-0002).
    throw fail('internal', 'WebCrypto is unavailable (crypto.subtle is undefined)')
  }
  return subtle
}

function fail(code: OrivonErrorCode, message: string): OrivonError {
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
function encodeField(value: string): Uint8Array<ArrayBuffer> {
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
export function encodeDeriveInfo(
  label: string,
  scope: string,
  curve: string
): Uint8Array<ArrayBuffer> {
  return concat([encodeField(label), encodeField(scope), encodeField(curve)])
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
 * Rejects a seed that is long enough but obviously not random: every byte
 * identical. This is not an entropy estimator and cannot be one.
 *
 * The realistic trigger is not a hostile caller -- the seed is broker-internal
 * and never app-reachable -- but a `safeStorage` read that fails soft. ADR-0003
 * puts the seed behind exactly that mechanism, and a locked keychain, an OS
 * migration or a first-run race can hand back a zero-filled buffer instead of
 * an error. Accepting it would give every user it happened to THE SAME
 * identity, derived from an all-zero seed, permanently and with no export path
 * to recover from. Three lines to make that a loud failure instead.
 */
function isDegenerateSeed(seed: Uint8Array): boolean {
  // Scans the whole buffer rather than returning on the first differing byte.
  // The early exit would be a data-dependent branch over the ROOT SECRET, and
  // although what it leaks is worthless (the length of a leading run of equal
  // bytes, which is 1 for any real seed), a secret-dependent branch here is not
  // worth defending in review every time someone reads it.
  let differs = 0
  const first = seed[0]
  for (let i = 1; i < seed.length; i++) differs |= seed[i]! ^ first!
  return differs === 0
}

/**
 * The frozen core. seed + (label, scope, curve) -> a private scalar in
 * [1, n-1].
 *
 * RETURNS SECRET KEY MATERIAL. It is broker-internal and must never cross the
 * contextBridge: raw key export is not a capability at any tier, signed apps
 * included. JavaScript cannot reliably zero this buffer afterwards, so hold it
 * for as short a time as possible and never log it.
 *
 * NOT CONSTANT TIME. The reduction below uses BigInt arithmetic, whose timing
 * varies with the values involved, and the scalar is secret. Accepted risk,
 * recorded in ADR-0010 SSAccepted risks rather than left implicit: the fix is
 * an audited constant-time curve library, and hand-rolling one here would be
 * the same hazard this file refuses in derivePublicKey. Do not attempt a
 * hand-written constant-time reduction to close it.
 */
export async function derivePrivateScalar(request: DeriveRequest): Promise<Uint8Array> {
  const { seed, label, scope, curve } = request

  if (seed.length < MIN_SEED_BYTES) {
    throw fail('invalid', `seed must be at least ${MIN_SEED_BYTES} bytes, got ${seed.length}`)
  }
  if (isDegenerateSeed(seed)) {
    throw fail('invalid', 'seed is a single repeated byte, which is not a usable root secret')
  }
  // An empty scope is a caller bug in every case: `originFromUrl()` returns
  // null rather than '' when it cannot derive an origin, and an identityId is
  // broker-generated. Deriving a key for it anyway would hand every such bug
  // the same shared identity.
  if (scope.length === 0) {
    throw fail('invalid', `scope must not be empty for label '${label}'`)
  }
  if (!isSupportedCurve(curve)) {
    throw fail('invalid', `unsupported curve: ${JSON.stringify(String(curve))}`)
  }
  const order = CURVE_ORDER[curve]

  const info = encodeDeriveInfo(label, scope, curve)

  const subtle = subtleCrypto()
  // The cast is about buffer provenance, not about crypto: TypeScript's
  // BufferSource excludes SharedArrayBuffer-backed views, and the seed reaches
  // us as a plain Uint8Array from the contracts surface. Copying it to satisfy
  // the type would leave a second copy of the ROOT SECRET in memory that
  // JavaScript cannot zero, which is strictly worse. A shared-backed view would
  // still be rejected by WebCrypto at runtime, so the cast fails safe.
  const ikm = await viaWebCrypto('seed import', () =>
    subtle.importKey('raw', seed as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'])
  )
  const okm = new Uint8Array(
    await viaWebCrypto('HKDF', () =>
      subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: KDF_SALT, info }, ikm, OKM_BITS)
    )
  )

  // Map into [1, n-1]: 0 is not a valid private key on either curve, and a
  // value >= n is not a distinct one.
  return bigIntToScalarBytes((bytesToBigInt(okm) % (order - 1n)) + 1n)
}

/**
 * The public key for a derived scalar, as an uncompressed SEC1 point
 * (0x04 || X || Y, 65 bytes). **P-256 only.**
 *
 * secp256k1 IS NOT SERVED HERE, and that is the loud limitation of this file.
 * WebCrypto has no secp256k1 at all, so serving it would mean either
 * hand-rolling scalar multiplication -- variable-time, over a secret scalar, in
 * the file that holds every user's identity -- or reaching for a curve library
 * from the layer that ADR-0002 says must outlive the engine beneath it. The
 * first is unacceptable outright. The second is a real option, just not one to
 * take here: `src/nostr/` needs a secp256k1 implementation regardless, because
 * WebCrypto cannot produce a BIP-340 Schnorr signature either, so the point
 * multiplication costs nothing extra there and buys nothing extra here.
 *
 * To be precise about the constraint, because an earlier draft of this comment
 * overstated it: the project rule is CLAUDE.md Rule 8, "pure-JS dependencies
 * only" (no compiler at install time), and Rule 6, "do not reinvent without a
 * written reason". There is no blanket "add no dependency" rule, and a pure-JS
 * audited curve library would satisfy both. The argument for staying on
 * WebCrypto here is engine-independence, not dependency count. Owner decision,
 * 2026-08-27; revisit it in the `nostr` stream (ADR-0010 SSRejected).
 *
 * What this file owns for secp256k1 -- the scalar, frozen by golden vectors --
 * is the part that must never change. The point is a deterministic function of
 * it, so the identity is pinned either way.
 */
export async function derivePublicKey(
  request: DeriveRequest & { readonly curve: 'P-256' }
): Promise<Uint8Array> {
  // Two different failures, two different codes. An unknown curve is the app's
  // doing -- the contract types `curve` as a free-form string -- so it is
  // 'invalid'. A well-formed secp256k1 request is the broker's doing: the app
  // never chooses which layer serves it, so routing it here is a wiring bug,
  // and errors.ts reserves 'internal' for exactly that. Conflating them would
  // both mislabel an app's mistake as a broker fault and, since errors.ts says
  // 'internal' is always logged, let an app fill the log by looping on a
  // misspelled curve.
  const curve: unknown = request.curve
  if (!isSupportedCurve(curve)) {
    // String() before JSON.stringify: JSON.stringify throws on a BigInt, and a
    // BigInt survives structured clone, so an app could turn this rejection
    // into a raw TypeError carrying no OrivonErrorCode at all.
    throw fail('invalid', `unsupported curve: ${JSON.stringify(String(curve))}`)
  }
  if (curve !== 'P-256') {
    throw fail(
      'internal',
      `no public-key derivation for ${curve} in the policy layer; ` +
        'derive the point from derivePrivateScalar() one layer up (src/nostr/)'
    )
  }

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
function pkcs8P256(scalar: Uint8Array): Uint8Array<ArrayBuffer> {
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
