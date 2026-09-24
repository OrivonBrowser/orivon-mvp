// orivon.secrets (ADR-0031): one AES-256-GCM key per origin, derived from
// the SAME seed ./derive.ts's frozen v1 construction uses, under a
// DIFFERENT, DEDICATED salt -- 'orivon-secrets-v1', never 'orivon-kdf-v1'.
// A shared seed is safe to derive two unrelated secrets from; a SHARED
// derivation path would not be (capability-api.md's "one scalar reused
// across two schemes voids the security argument for both" -- the same
// reasoning, applied here to two different consumers of the one seed
// rather than two curves of the one identity).
//
// THE WIRE FORMAT IS A ONE-WAY DOOR the moment an app depends on it,
// exactly ./derive.ts's own frozen status (ADR-0010) -- see
// ./secrets-vectors.json (the deterministic key-derivation half; AES-GCM's
// own randomised nonce makes a byte-for-byte ciphertext vector meaningless,
// the same reason derive-vectors.json freezes derivePrivateScalar's output
// rather than signWithP256's).

import { concat } from './bytes.js'
import { encodeField } from './derive-encoding.js'
import { isDegenerateSeed, MIN_SEED_BYTES, subtleCrypto, viaWebCrypto } from './derive.js'
import { fail } from './errors.js'

/** Version tag, carried as the HKDF salt so it domain-separates this
 * derivation from every other one over the same seed, ./derive.ts's own
 * 'orivon-kdf-v1' included. A v2 changes this string, exactly ADR-0010's
 * own versioning rule for the identity derivation. */
const SECRETS_SALT = new TextEncoder().encode('orivon-secrets-v1')

/** AES-256-GCM. 32 bytes of key material, 12-byte random nonce (NIST
 * SP 800-38D's recommended length), the tag WebCrypto appends to the
 * ciphertext it returns. */
const KEY_BITS = 256
const NONCE_BYTES = 12

/** The one byte this format has ever had. Bound into the AEAD's own
 * associated data, so flipping it in transit is itself detected rather
 * than silently accepted by a future version's decoder. */
const FORMAT_VERSION = 1

/**
 * seed + origin -> a non-extractable AES-256-GCM `CryptoKey`, scoped to
 * this one origin. Exported for ./secrets-vectors.json's own vector test,
 * which checks the RAW key bytes an independent `node:crypto` HKDF
 * produces against this function's HKDF call -- the same "freeze the
 * deterministic half, not the randomised one" split derive-vectors.json
 * already uses for signWithP256.
 */
export async function deriveSecretKeyBytes (seed: Uint8Array, origin: string): Promise<Uint8Array> {
  if (seed.length < MIN_SEED_BYTES) throw fail('internal', `seed must be at least ${MIN_SEED_BYTES} bytes, got ${seed.length}`)
  if (isDegenerateSeed(seed)) throw fail('internal', 'seed is a single repeated byte, which is not a usable root secret')

  const info = concat([encodeField('secrets'), encodeField(origin)])
  const subtle = subtleCrypto()
  const ikm = await viaWebCrypto('secrets seed import', () =>
    subtle.importKey('raw', seed as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'])
  )
  const bits = await viaWebCrypto('secrets HKDF', () =>
    subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SECRETS_SALT, info }, ikm, KEY_BITS)
  )
  return new Uint8Array(bits)
}

async function importAesKey (rawKey: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const subtle = subtleCrypto()
  return await viaWebCrypto('secrets key import', () =>
    subtle.importKey('raw', rawKey as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [usage])
  )
}

/**
 * seed + origin + plaintext -> `[FORMAT_VERSION] || nonce(12) || ciphertext+tag`.
 * A fresh nonce every call (WebCrypto's own `getRandomValues`); the format
 * byte is authenticated as AAD, not merely prepended, so a bit flipped in
 * transit fails to decrypt rather than silently selecting a future format.
 */
export async function sealSecret (seed: Uint8Array, origin: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const rawKey = await deriveSecretKeyBytes(seed, origin)
  const key = await importAesKey(rawKey, 'encrypt')
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const aad = Uint8Array.of(FORMAT_VERSION)
  const ciphertext = new Uint8Array(
    await viaWebCrypto('secrets encrypt', () =>
      subtleCrypto().encrypt({ name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer> }, key, plaintext as Uint8Array<ArrayBuffer>)
    )
  )
  return concat([aad, nonce, ciphertext])
}

/**
 * Reverses `sealSecret`. Rejects 'invalid' -- never 'internal' -- for
 * anything that does not decrypt under this origin's own key: too short to
 * be a real ciphertext, a format byte this reader does not recognise,
 * another origin's ciphertext, or a bit flipped anywhere in transit.
 * AES-GCM's own tag check is what makes "wrong key" and "corrupted bytes"
 * indistinguishable from here, which is the correct failure shape -- an app
 * gets one uniform "this is not a secret of mine" rather than a signal it
 * could use to probe the boundary.
 */
export async function openSecret (seed: Uint8Array, origin: string, wire: Uint8Array): Promise<Uint8Array> {
  const MIN_WIRE_BYTES = 1 + NONCE_BYTES
  if (wire.length <= MIN_WIRE_BYTES) throw fail('invalid', 'ciphertext is too short to be a secret this origin produced')
  const version = wire[0]
  if (version !== FORMAT_VERSION) throw fail('invalid', `unrecognised secret format version: ${String(version)}`)
  const nonce = wire.subarray(1, 1 + NONCE_BYTES)
  const ciphertext = wire.subarray(1 + NONCE_BYTES)

  const rawKey = await deriveSecretKeyBytes(seed, origin)
  const key = await importAesKey(rawKey, 'decrypt')
  const aad = Uint8Array.of(FORMAT_VERSION)
  try {
    const plaintext = await subtleCrypto().decrypt(
      { name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer> },
      key,
      ciphertext as Uint8Array<ArrayBuffer>
    )
    return new Uint8Array(plaintext)
  } catch {
    // AES-GCM's own authentication failure (wrong key, wrong AAD, or
    // corrupted bytes) throws a bare DOMException with no detail worth
    // relaying -- 'invalid' is the whole answer an app needs.
    throw fail('invalid', 'ciphertext does not decrypt under this origin\'s key')
  }
}
