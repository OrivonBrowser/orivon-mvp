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
//
// Split across three files (Rule 2, docs/development/code-guidelines.md):
// ./derive-encoding.ts (the wire format), this file (the frozen core --
// CURVE_ORDER and derivePrivateScalar), and ./derive-p256.ts (the P-256 point
// derivation, which is the part allowed to grow). CURVE_ORDER stays here
// deliberately -- scripts/check-vectors.mjs text-greps this file by path for
// it.

import { bigIntToScalarBytes, bytesToBigInt, encodeDeriveInfo } from './derive-encoding.js'
import { fail } from './errors.js'

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

/**
 * Version tag, carried as the HKDF salt so it domain-separates everything
 * derived under it in one place. A v2 changes THIS STRING and adds vectors
 * beside the existing ones (ADR-0010 SSVersioning).
 */
const KDF_SALT = new TextEncoder().encode('orivon-kdf-v1')

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

export function isSupportedCurve (curve: unknown): curve is DeriveCurve {
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
 *
 * Exported for ./derive-p256.ts, which needs the same boundary.
 */
export async function viaWebCrypto <T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw Object.assign(fail('internal', `WebCrypto ${what} failed: ${detail}`), { cause })
  }
}

/** Reads `crypto.subtle` with a legible failure if the host has no WebCrypto. Exported for ./derive-p256.ts. */
export function subtleCrypto (): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    // Reachable in a browser on plain http, where `crypto.subtle` is gated on a
    // secure context. Not reachable in Electron's main process, but this layer
    // is written to outlive it (ADR-0002).
    throw fail('internal', 'WebCrypto is unavailable (crypto.subtle is undefined)')
  }
  return subtle
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
function isDegenerateSeed (seed: Uint8Array): boolean {
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
export async function derivePrivateScalar (request: DeriveRequest): Promise<Uint8Array> {
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
