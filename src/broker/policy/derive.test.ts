import { describe, expect, it } from 'vitest'
import { derivePrivateScalar, derivePublicKey, type DeriveCurve, type DeriveLabel } from './derive.js'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function bytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Fixed, non-secret, and never used for anything real. */
const SEED = bytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')

// ===========================================================================
// FROZEN GOLDEN VECTORS -- DO NOT REGENERATE.
//
// If a change to derive.ts makes a row below fail, THE CHANGE IS WRONG. Do not
// "fix" the vector by re-running the code and pasting the new bytes. That
// converts a caught bug into a shipped one.
//
// These rows are a tripwire, not a determinism check. "Same input gives the
// same output" is near-tautological for a KDF and proves nothing. The real risk
// is the derivation changing BETWEEN RELEASES: every app key and every named
// identity a user owns is a pure function of (seed, label, scope, curve), so a
// one-byte change to the salt, the info encoding, the hash, the OKM length or
// the scalar reduction silently issues everyone brand-new keys. Their npub
// changes, their follows and posts are orphaned on the old one, and ADR-0003
// excludes key export -- there is no backup to restore and no way to migrate.
// The damage is invisible when it is introduced and permanent by the time a
// user notices.
//
// A failing row means the KDF changed. Either revert it, or treat it as a
// deliberate v2: bump KDF_SALT, ADD rows beside these, and write the migration
// for users already holding v1 keys. Never edit these bytes.
//
// Provenance: computed 2026-08-26 by an INDEPENDENT reference implementation
// (node:crypto `hkdfSync` plus OpenSSL point multiplication) rather than by the
// code under test, so the table cannot be a recording of this implementation's
// own bugs. Both curve orders were separately checked against the identity
// (n-1)G = -G.
// ===========================================================================

interface Vector {
  readonly label: DeriveLabel
  readonly scope: string
  readonly curve: DeriveCurve
  readonly scalar: string
  /**
   * Absent for secp256k1 by design: WebCrypto has no secp256k1 and no
   * dependency may be added, so point derivation lives one layer up
   * (src/nostr/, which needs secp256k1 for BIP-340 anyway). The scalar below is
   * what pins the identity -- the point is a deterministic function of it.
   */
  readonly publicKey?: string
}

const VECTORS: readonly Vector[] = [
  {
    label: 'app',
    scope: 'https://app.example.com',
    curve: 'P-256',
    scalar: 'fb5b3a0adc63ab80be8fc22362bd0c800cd62aef87100e6a2514dde86235f6bd',
    publicKey:
      '04db0ffbd54e9fa575301ac46a3b7d254691eb51ea243ac780902722a69217738e' +
      'de938c452d700548c7c70310ef070ff5b02403763e6b4207d79c62cc488d7089'
  },
  {
    label: 'identity',
    scope: 'primary',
    curve: 'P-256',
    scalar: '36b2f27ebe1c02459fc966851814ac21aee1ec5aebaedff46e095c75ff231171',
    publicKey:
      '04da64e91baea08ec17ffcbbbbade2355cb8d95b9f65ae4cc7644475b733bf0db7' +
      '120d160c9d53edb24ce510312cdc799d58ff62f4db8f527163e489fcd2060c0e'
  },
  {
    label: 'app',
    scope: 'https://app.example.com',
    curve: 'secp256k1',
    scalar: 'ddcad497c4b6f02955eb41c411b8ec4885db9c7c577b0894668107d67d50b818'
  },
  {
    label: 'identity',
    scope: 'primary',
    curve: 'secp256k1',
    scalar: '562426285bfca61957cd6bb88e2ea1b442b67bed4a11eadc4d051b422e775d33'
  },
  {
    label: 'app',
    scope: 'https://other.example.com',
    curve: 'secp256k1',
    scalar: '0c39056bfd335bc0a607a966e94542de76aab2b6a82ae07e8ef352e497eda932'
  }
]

describe('frozen golden vectors', () => {
  for (const vector of VECTORS) {
    it(`${vector.curve} ${vector.label}/${vector.scope} derives the frozen scalar`, async () => {
      const scalar = await derivePrivateScalar({
        seed: SEED,
        label: vector.label,
        scope: vector.scope,
        curve: vector.curve
      })
      expect(hex(scalar)).toBe(vector.scalar)
    })

    const expectedPublicKey = vector.publicKey
    if (expectedPublicKey !== undefined) {
      it(`${vector.curve} ${vector.label}/${vector.scope} derives the frozen public key`, async () => {
        const publicKey = await derivePublicKey({
          seed: SEED,
          label: vector.label,
          scope: vector.scope,
          curve: vector.curve
        })
        expect(hex(publicKey)).toBe(expectedPublicKey)
      })
    }
  }
})

describe('separation', () => {
  // The whole point of the two labels. If these ever collided, an app key and a
  // named identity would be the same secret -- the app's silent, unprompted key
  // would BE the user's cross-origin Nostr identity, and any app could sign as
  // the user without ever showing a connect prompt.
  it('the two labels produce different keys for the same scope and curve', async () => {
    const base = { seed: SEED, scope: 'primary', curve: 'secp256k1' } as const
    const app = await derivePrivateScalar({ ...base, label: 'app' })
    const identity = await derivePrivateScalar({ ...base, label: 'identity' })
    expect(hex(app)).not.toBe(hex(identity))
  })

  it('two origins get different app keys', async () => {
    const base = { seed: SEED, label: 'app', curve: 'secp256k1' } as const
    const one = await derivePrivateScalar({ ...base, scope: 'https://app.example.com' })
    const two = await derivePrivateScalar({ ...base, scope: 'https://other.example.com' })
    expect(hex(one)).not.toBe(hex(two))
  })

  it('the same scope on two curves gets different scalars', async () => {
    const base = { seed: SEED, label: 'identity', scope: 'primary' } as const
    const k1 = await derivePrivateScalar({ ...base, curve: 'secp256k1' })
    const p256 = await derivePrivateScalar({ ...base, curve: 'P-256' })
    expect(hex(k1)).not.toBe(hex(p256))
  })

  it('two seeds produce different keys for identical inputs', async () => {
    const other = bytes('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100')
    const base = { label: 'identity', scope: 'primary', curve: 'secp256k1' } as const
    expect(hex(await derivePrivateScalar({ ...base, seed: SEED }))).not.toBe(
      hex(await derivePrivateScalar({ ...base, seed: other }))
    )
  })

  // The concrete attack length prefixing exists to stop. Without a length in
  // front of each field the info string for ("app", "abc") and ("ap", "pabc")
  // is the same bytes, so both derive the SAME scalar -- one secret reused
  // across two schemes, which voids the security argument for both
  // (capability-api.md, security-model.md T8b).
  //
  // The cast is deliberate. DeriveLabel closes the label set today, so this
  // collision is unreachable through the type -- but the property must hold at
  // the byte level, because the label set is the kind of thing that grows and
  // `scope` is already free-form.
  it('adjacent fields cannot be re-split into a colliding key', async () => {
    const shifted = await derivePrivateScalar({
      seed: SEED,
      label: 'ap' as DeriveLabel,
      scope: 'pabc',
      curve: 'secp256k1'
    })
    const straight = await derivePrivateScalar({
      seed: SEED,
      label: 'app',
      scope: 'abc',
      curve: 'secp256k1'
    })
    expect(hex(shifted)).not.toBe(hex(straight))
  })

  it('a scope boundary cannot be shifted into the curve field', async () => {
    const base = { seed: SEED, label: 'app' } as const
    const a = await derivePrivateScalar({ ...base, scope: 'xP', curve: 'secp256k1' })
    const b = await derivePrivateScalar({ ...base, scope: 'x', curve: 'secp256k1' })
    expect(hex(a)).not.toBe(hex(b))
  })
})

describe('rejected input', () => {
  it('a seed under 32 bytes is refused', async () => {
    await expect(
      derivePrivateScalar({
        seed: new Uint8Array(31),
        label: 'app',
        scope: 'https://app.example.com',
        curve: 'secp256k1'
      })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an unknown curve is refused rather than silently defaulted', async () => {
    await expect(
      derivePrivateScalar({
        seed: SEED,
        label: 'app',
        scope: 'https://app.example.com',
        curve: 'Curve25519' as DeriveCurve
      })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // The loud limitation of this layer, asserted so it cannot be forgotten:
  // asking here for an npub is a broker wiring error, not an app error.
  it('secp256k1 public-key derivation is refused and points one layer up', async () => {
    await expect(
      derivePrivateScalar({
        seed: SEED,
        label: 'identity',
        scope: 'primary',
        curve: 'secp256k1'
      })
    ).resolves.toBeInstanceOf(Uint8Array)

    await expect(
      derivePublicKey({ seed: SEED, label: 'identity', scope: 'primary', curve: 'secp256k1' })
    ).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('output shape', () => {
  it('a scalar is 32 bytes and never zero', async () => {
    for (const vector of VECTORS) {
      const scalar = await derivePrivateScalar({
        seed: SEED,
        label: vector.label,
        scope: vector.scope,
        curve: vector.curve
      })
      expect(scalar).toHaveLength(32)
      expect(scalar.some((b) => b !== 0)).toBe(true)
    }
  })

  it('a public key is an uncompressed SEC1 point', async () => {
    const publicKey = await derivePublicKey({
      seed: SEED,
      label: 'app',
      scope: 'https://app.example.com',
      curve: 'P-256'
    })
    expect(publicKey).toHaveLength(65)
    expect(publicKey[0]).toBe(0x04)
  })
})
