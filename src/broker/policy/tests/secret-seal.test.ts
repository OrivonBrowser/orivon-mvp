import { describe, expect, it } from 'vitest'
import { deriveSecretKeyBytes, openSecret, sealSecret } from '../secret-seal.js'
import table from '../secrets-vectors.json'

function hex (bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function bytes (value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Fixed, non-secret, and never used for anything real -- the same seed derive-vectors.json uses. */
const SEED = bytes(table.seed)

// ===========================================================================
// FROZEN GOLDEN VECTORS -- DO NOT REGENERATE.
//
// The table itself is ../secrets-vectors.json. If a row makes a test below
// fail, THE CHANGE TO secret-seal.ts IS WRONG. Do not "fix" the vector by
// re-running the code and pasting the new bytes -- see derive.test.ts's own
// header for the full argument, which applies here unchanged.
// scripts/check-vectors.mjs recomputes the same table with node:crypto's
// hkdfSync, independent of this WebCrypto implementation.
// ===========================================================================
describe('deriveSecretKeyBytes -- frozen golden vectors (ADR-0031)', () => {
  it.each(table.vectors)('$origin', async ({ origin, key }) => {
    const derived = await deriveSecretKeyBytes(SEED, origin)
    expect(hex(derived)).toBe(key)
  })
})

describe('deriveSecretKeyBytes -- guards it shares with ./derive.ts (exported for exactly this reuse)', () => {
  it('rejects a seed shorter than 32 bytes', async () => {
    await expect(deriveSecretKeyBytes(new Uint8Array(31), 'https://app.example'))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('rejects a degenerate (single-repeated-byte) seed', async () => {
    await expect(deriveSecretKeyBytes(new Uint8Array(32).fill(7), 'https://app.example'))
      .rejects.toMatchObject({ code: 'internal' })
  })
})

describe('sealSecret / openSecret -- ordinary round trip, over real randomness (not vector-tested, see file header)', () => {
  it('opens exactly what was sealed', async () => {
    const plaintext = new TextEncoder().encode('a small secret, not the seed itself')
    const wire = await sealSecret(SEED, 'https://app.example', plaintext)
    const opened = await openSecret(SEED, 'https://app.example', wire)
    expect(opened).toEqual(plaintext)
  })

  it('seals the same plaintext to a different ciphertext every call (random nonce)', async () => {
    const plaintext = new Uint8Array([1, 2, 3])
    const a = await sealSecret(SEED, 'https://app.example', plaintext)
    const b = await sealSecret(SEED, 'https://app.example', plaintext)
    expect(a).not.toEqual(b)
  })

  it('rejects opening under a DIFFERENT origin\'s key -- the per-origin binding is real, not decorative', async () => {
    const wire = await sealSecret(SEED, 'https://app.example', new Uint8Array([9, 9, 9]))
    await expect(openSecret(SEED, 'https://other.example', wire)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects a single flipped bit anywhere in the wire bytes', async () => {
    const wire = await sealSecret(SEED, 'https://app.example', new Uint8Array([1, 2, 3, 4, 5]))
    for (const i of [0, 1, wire.length - 1]) {
      const tampered = wire.slice()
      tampered[i] = (tampered[i]! ^ 0xff) & 0xff
      await expect(openSecret(SEED, 'https://app.example', tampered)).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  it('rejects ciphertext too short to be real', async () => {
    await expect(openSecret(SEED, 'https://app.example', new Uint8Array(5))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects an unrecognised format version byte', async () => {
    const wire = await sealSecret(SEED, 'https://app.example', new Uint8Array([1]))
    const tampered = wire.slice()
    tampered[0] = 99
    await expect(openSecret(SEED, 'https://app.example', tampered)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('round-trips an empty plaintext', async () => {
    const wire = await sealSecret(SEED, 'https://app.example', new Uint8Array(0))
    expect(await openSecret(SEED, 'https://app.example', wire)).toEqual(new Uint8Array(0))
  })
})
