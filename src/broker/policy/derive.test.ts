import { describe, expect, it } from 'vitest'
import { derivePrivateScalar, type DeriveCurve, type DeriveLabel } from './derive.js'
import { derivePublicKey } from './derive-p256.js'
import { encodeDeriveInfo } from './derive-encoding.js'
import table from './derive-vectors.json'

function hex (bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function bytes (value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Fixed, non-secret, and never used for anything real. */
const SEED = bytes(table.seed)

/**
 * Published group orders, used only by the range property test below. Hardcoded
 * here rather than imported so the test does not inherit a wrong constant from
 * the code it is checking; scripts/check-vectors.mjs verifies both against the
 * published decimal values.
 */
const CURVE_ORDER: Record<DeriveCurve, bigint> = {
  secp256k1: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  'P-256': 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
}

// ===========================================================================
// FROZEN GOLDEN VECTORS -- DO NOT REGENERATE.
//
// The table itself is ./derive-vectors.json. If a row makes a test below fail,
// THE CHANGE TO derive.ts IS WRONG. Do not "fix" the vector by re-running the
// code and pasting the new bytes. That converts a caught bug into a shipped
// one.
//
// These rows are a tripwire, not a determinism check. "Same input gives the
// same output" is near-tautological for a KDF and proves nothing. The real risk
// is the derivation changing BETWEEN RELEASES: every app key and every named
// identity a user owns is a pure function of (seed, label, scope, curve), so a
// one-byte change to the salt, the info encoding, the hash, the OKM length or
// the scalar reduction silently issues everyone brand-new keys. Their npub
// changes and their follows and posts are orphaned on the old one. Identity
// export and backup are out of scope for the MVP -- deliberately, and they are
// named as the first thing to add afterwards (ADR-0003, mvp-scope.md) -- so for
// as long as that holds there is no backup to restore from. The damage is
// invisible when it is introduced and permanent by the time a user notices.
//
// A failing row means the KDF changed. Either revert it, or treat it as a
// deliberate v2: bump KDF_SALT, ADD rows beside these, and write the migration
// for users already holding v1 keys (ADR-0010 SSVersioning). Never edit these
// bytes.
//
// PROVENANCE IS CHECKABLE, not asserted. scripts/check-vectors.mjs recomputes
// every row from an independent node:crypto implementation transcribed from
// ADR-0010, and CI runs it. So the table is cross-validated by two crypto
// stacks: this file proves derive.ts (WebCrypto) matches it, and that script
// proves node:crypto matches it too. The script is a VERIFIER with no write
// mode, so it cannot be pointed at a failing row and re-run.
// ===========================================================================

interface Vector {
  readonly label: DeriveLabel
  readonly scope: string
  readonly curve: DeriveCurve
  readonly scalar: string
  /**
   * Absent for secp256k1 by design: WebCrypto has no secp256k1, so point
   * derivation lives one layer up (src/nostr/, which needs secp256k1 for
   * BIP-340 anyway). The scalar is what pins the identity -- the point is a
   * deterministic function of it.
   */
  readonly publicKey?: string
}

const VECTORS = table.vectors as readonly Vector[]

describe('frozen golden vectors', () => {
  it('the table is the one this suite thinks it is', () => {
    // Guards against coverage being DELETED rather than changed, which no
    // per-row assertion can notice: every `for (const vector of VECTORS)` below
    // is vacuously true of an empty table.
    expect(VECTORS).toHaveLength(7)
    expect(hex(SEED)).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    // The public key is the part an app actually receives, and dropping the
    // field silently removes three assertions while leaving the suite green.
    expect(VECTORS.filter((v) => v.publicKey !== undefined)).toHaveLength(3)
    // Distinct TUPLES, not rows: replacing five frozen rows with duplicates of
    // the other two leaves a row count of 7 and deletes most of the coverage.
    const tuples = new Set(VECTORS.map((v) => JSON.stringify([v.label, v.scope, v.curve])))
    expect(tuples.size).toBe(VECTORS.length)
    expect(new Set(VECTORS.map((v) => v.label)).size).toBe(2)
    expect(new Set(VECTORS.map((v) => v.curve)).size).toBe(2)
  })

  // At least two rows must have a UTF-8 byte length different from their JS
  // code-unit length. Without them the whole table is ASCII, where the two
  // coincide -- and substituting `value.length` for the UTF-8 byte length in
  // encodeField then passes every other test in this file while silently
  // changing the key for every non-ASCII scope. That mutation was confirmed to
  // survive the original 18-test suite. This assertion is what stops the
  // coverage from being quietly removed later.
  it('the table covers the multi-byte encoding path', () => {
    const multiByte = VECTORS.filter(
      (v) => new TextEncoder().encode(v.scope).length !== v.scope.length
    )
    expect(multiByte.length).toBeGreaterThanOrEqual(2)
  })

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
          curve: 'P-256'
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
  // The casts below are deliberate. The types close the label and curve sets
  // today, so these collisions are unreachable through the type -- but the
  // property must hold at the byte level, because the label and curve sets are
  // the kind of thing that grows and `scope` is already free-form.
  it('a label boundary cannot be shifted into the scope field', async () => {
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

  // This test previously used the SAME curve on both sides, which meant the
  // field it is named after never varied -- it passed against an implementation
  // with no length prefixing anywhere, and so asserted nothing. Both sides must
  // straddle the scope/curve boundary for it to be a tripwire: without length
  // prefixes, "app"+"x"+"P-256" and "app"+"xP"+"-256" are the same bytes.
  //
  // Asserted on the encoding rather than through derivePrivateScalar, because
  // the runtime curve check correctly refuses '-256' and so puts this tuple out
  // of the KDF's reach. That is the guard working; the property still has to
  // hold underneath it.
  it('a scope boundary cannot be shifted into the curve field', () => {
    expect(hex(encodeDeriveInfo('app', 'x', 'P-256'))).not.toBe(
      hex(encodeDeriveInfo('app', 'xP', '-256'))
    )
  })

  // The boundary tests above each pin one seam by hand. This pins every seam at
  // once, over field values the closed types do not currently admit -- which is
  // the case that matters, since length prefixing exists precisely because the
  // label and curve sets are expected to grow.
  it('no two distinct field tuples share an info encoding', () => {
    // Short fields only, and deliberately so. A wider alphabet does NOT extend
    // this test to catch a truncating length prefix: 300 % 256 = 44 is still
    // distinct from every other length here, so no collision appears. The
    // prefix WIDTH is pinned separately, by the test below.
    const alphabet = ['', 'a', 'ab', 'P', 'P-256', '-256', 'é', '🔑']
    const seen = new Map<string, string>()
    for (const label of alphabet) {
      for (const scope of alphabet) {
        for (const curve of alphabet) {
          const encoded = hex(encodeDeriveInfo(label, scope, curve))
          const key = JSON.stringify([label, scope, curve])
          expect(seen.has(encoded), `${key} collides with ${seen.get(encoded)}`).toBe(false)
          seen.set(encoded, key)
        }
      }
    }
    expect(seen.size).toBe(alphabet.length ** 3)
  })

  // The length prefix is FOUR BYTES, big-endian. Enumerating tuples cannot
  // establish this: a prefix truncated to one byte stays injective over any
  // small alphabet, because two lengths only collide when they differ by
  // exactly 256. So assert the width head-on, with a field long enough that a
  // uint8 or uint16 prefix produces visibly different bytes.
  // Both widths are needed. 300 bytes catches truncation to uint8 but NOT to
  // uint16, because 300 < 65536 passes through unchanged -- verified by running
  // that mutation. The 70000-byte field closes it.
  it.each([
    ['uint8 truncation', 300, '0000012c'],
    ['uint16 truncation', 70000, '00011170']
  ])('a field length prefix is a full big-endian uint32 (%s)', (_case, length, expected) => {
    const encoded = hex(encodeDeriveInfo('a', 'x'.repeat(length), 'c'))
    expect(encoded.slice(0, 8)).toBe('00000001')
    expect(encoded.slice(10, 18)).toBe(expected)
    // Big-endian, not little: the low byte must be last.
    expect(encoded.slice(10, 12)).toBe('00')
  })

  // Pins the UTF-8 byte length directly, so the `value.length` substitution is
  // caught at the encoding level too and not only through the frozen table.
  it('a field length is its UTF-8 byte count, not its code-unit count', () => {
    // '🔑' is 2 code units and 4 UTF-8 bytes, so a code-unit length would
    // write 00000002 here and shift every byte after it.
    expect(hex(encodeDeriveInfo('a', '🔑', 'c'))).toBe(
      '00000001' + '61' + '00000004' + 'f09f9491' + '00000001' + '63'
    )
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

  // A long-enough but all-zero seed is what a soft-failing safeStorage read
  // looks like (ADR-0003 puts the seed behind the OS keychain). Accepting it
  // would give every affected user the same identity, unrecoverably.
  it.each([
    ['all zero', new Uint8Array(32)],
    ['all 0xff', new Uint8Array(32).fill(0xff)]
  ])('a degenerate %s seed is refused', async (_name, seed) => {
    await expect(
      derivePrivateScalar({ seed, label: 'app', scope: 'https://app.example.com', curve: 'P-256' })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an empty scope is refused rather than deriving a shared key', async () => {
    await expect(
      derivePrivateScalar({ seed: SEED, label: 'app', scope: '', curve: 'P-256' })
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

  // `curve` is the only app-controlled input on this surface -- the contract
  // types it as a free-form string -- so the guard must reject INHERITED keys
  // too. With an ordinary object literal, CURVE_ORDER['__proto__'] returns
  // Object.prototype rather than undefined, walks past an `=== undefined`
  // check, and dies on a raw TypeError carrying no `code` at all. That escapes
  // the closed OrivonErrorCode enum that errors.ts tells apps they may switch
  // on exhaustively.
  it.each(Object.getOwnPropertyNames(Object.prototype))(
    'the inherited key %s is refused like any unknown curve',
    async (inherited) => {
      await expect(
        derivePrivateScalar({
          seed: SEED,
          label: 'app',
          scope: 'https://app.example.com',
          curve: inherited as DeriveCurve
        })
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  )

  // `curve` is structured-cloneable, so a non-string can genuinely arrive from
  // an app. `Object.hasOwn` runs ToPropertyKey, so ['P-256'] and
  // new String('P-256') coerce to a valid key and pass a naive guard -- and
  // then fail the `!== 'P-256'` reference check, landing in the 'internal'
  // branch that is reserved for broker faults. A BigInt is worse still:
  // JSON.stringify throws on it, so the rejection itself became a raw TypeError
  // with no code at all. Both entry points must say 'invalid'.
  it.each([
    ['BigInt', 1n],
    ['boxed String', new String('P-256')],
    ['array', ['P-256']],
    ['nested array', [['P-256']]],
    ['number', 256],
    ['null', null],
    ['undefined', undefined],
    ['object', { toString: () => 'P-256' }]
  ])('a %s curve is refused as invalid by both entry points', async (_name, curve) => {
    await expect(
      derivePrivateScalar({
        seed: SEED,
        label: 'app',
        scope: 'https://app.example.com',
        curve: curve as unknown as DeriveCurve
      })
    ).rejects.toMatchObject({ code: 'invalid' })

    await expect(
      derivePublicKey({
        seed: SEED,
        label: 'app',
        scope: 'https://app.example.com',
        curve: curve as unknown as 'P-256'
      })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // TextEncoder maps every unpaired surrogate to U+FFFD, so without a
  // well-formedness check these three distinct scopes derive ONE scalar --
  // verified before the check existed. That is a direct break of the
  // injectivity the whole encoding rests on.
  it.each([
    ['lone high surrogate', '\uD800'],
    ['lone low surrogate', '\uDC00'],
    ['high surrogate in context', 'https://app.example.com/\uD800']
  ])('a scope containing a %s is refused', async (_name, scope) => {
    await expect(
      derivePrivateScalar({ seed: SEED, label: 'app', scope, curve: 'P-256' })
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('the three strings that used to collide now all reject', async () => {
    const attempts = await Promise.allSettled(
      ['\uD800', '\uDC00', '�'].map((scope) =>
        derivePrivateScalar({ seed: SEED, label: 'app', scope, curve: 'P-256' })
      )
    )
    // U+FFFD is well-formed and still derives; the two lone surrogates do not.
    expect(attempts.map((a) => a.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
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
      derivePublicKey({
        seed: SEED,
        label: 'identity',
        scope: 'primary',
        curve: 'secp256k1' as 'P-256'
      })
    ).rejects.toMatchObject({ code: 'internal' })
  })

  // An unknown curve is the app's mistake, not the broker's, so it must not be
  // reported as 'internal' -- errors.ts says 'internal' should never be
  // observed by an app and is always logged, which would both mislabel the
  // fault and let an app fill the log by looping on a misspelled curve.
  it('an unknown curve at the public-key entry point is invalid, not internal', async () => {
    await expect(
      derivePublicKey({
        seed: SEED,
        label: 'app',
        scope: 'https://app.example.com',
        curve: 'Curve25519' as 'P-256'
      })
    ).rejects.toMatchObject({ code: 'invalid' })
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

  // The frozen rows pin seven specific scalars; this pins the RANGE INVARIANT
  // over inputs that are not in the table, so a reduction that can emit a
  // scalar outside [1, n-1] is caught even for scopes nobody froze.
  //
  // Be precise about what it does NOT catch, because an earlier version of this
  // comment overstated it: substituting `% n` for `% (n-1) + 1` re-admits the
  // invalid scalar 0, but only with probability ~2^-256, so this test passes
  // against that mutation and the GOLDEN VECTORS are what catch it (verified by
  // running exactly that mutation). The two checks are complementary; neither
  // subsumes the other.
  it('every derived scalar lands in [1, n-1] for its curve', async () => {
    for (const curve of ['secp256k1', 'P-256'] as const) {
      for (let i = 0; i < 64; i++) {
        const scalar = await derivePrivateScalar({
          seed: SEED,
          label: 'app',
          scope: `https://app-${i}.example.com`,
          curve
        })
        const d = BigInt(`0x${hex(scalar)}`)
        expect(d).toBeGreaterThanOrEqual(1n)
        expect(d).toBeLessThan(CURVE_ORDER[curve])
      }
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
