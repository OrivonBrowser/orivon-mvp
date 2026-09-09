// signWithP256 (../derive-p256.ts). derivePublicKey's own coverage lives in
// ./derive.test.ts, pinned by the frozen vector table -- this file is
// signWithP256's, kept separate because a signature is not vector-pinnable
// (ECDSA draws a fresh nonce per call, so two signatures over the same
// message never match byte for byte). Correctness here means "verifies
// against the derived public key", not "matches a frozen byte string".

import { describe, expect, it } from 'vitest'
import { derivePublicKey, signWithP256 } from '../derive-p256.js'
import table from '../derive-vectors.json'

function bytes (value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Same fixed, non-secret table seed derive.test.ts uses -- never used for anything real. */
const SEED = bytes(table.seed)

/** A real, frozen P-256 row (app/https://app.example.com) -- any of the table's P-256 rows would do. */
const REQUEST = { seed: SEED, label: 'app' as const, scope: 'https://app.example.com', curve: 'P-256' as const }

async function importVerifyKey (publicPoint: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    publicPoint as Uint8Array<ArrayBuffer>,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
}

describe('signWithP256', () => {
  it('produces a signature that verifies against the same request\'s derived public key', async () => {
    const publicKey = await derivePublicKey(REQUEST)
    const verifyKey = await importVerifyKey(publicKey)
    const payload = new TextEncoder().encode('orivon.id.sign test payload')

    const signature = await signWithP256(REQUEST, payload)

    // Raw (r || s), 64 bytes -- WebCrypto's own ECDSA sign() output, not DER.
    expect(signature).toHaveLength(64)
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      signature as Uint8Array<ArrayBuffer>,
      payload as Uint8Array<ArrayBuffer>
    )
    expect(ok).toBe(true)
  })

  it('does not verify against a different payload (the signature is over the actual bytes, not merely present)', async () => {
    const publicKey = await derivePublicKey(REQUEST)
    const verifyKey = await importVerifyKey(publicKey)
    const signature = await signWithP256(REQUEST, new TextEncoder().encode('payload A'))

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      signature as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode('payload B') as Uint8Array<ArrayBuffer>
    )
    expect(ok).toBe(false)
  })

  it('does not verify against a DIFFERENT scope\'s key -- two origins never share a signature', async () => {
    const otherRequest = { ...REQUEST, scope: 'https://other.example.com' }
    const otherPublicKey = await derivePublicKey(otherRequest)
    const otherVerifyKey = await importVerifyKey(otherPublicKey)
    const payload = new TextEncoder().encode('same payload, different origin key')

    const signature = await signWithP256(REQUEST, payload)

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      otherVerifyKey,
      signature as Uint8Array<ArrayBuffer>,
      payload as Uint8Array<ArrayBuffer>
    )
    expect(ok).toBe(false)
  })

  it('two signatures over the same payload differ (ECDSA draws a fresh nonce each time)', async () => {
    const payload = new TextEncoder().encode('same payload, signed twice')
    const first = await signWithP256(REQUEST, payload)
    const second = await signWithP256(REQUEST, payload)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it('rejects an unsupported curve string as invalid -- app-controlled input, never internal', async () => {
    await expect(
      signWithP256({ ...REQUEST, curve: 'not-a-curve' as never }, new Uint8Array(1))
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses a well-formed secp256k1 request as internal -- this policy layer serves P-256 only', async () => {
    await expect(
      signWithP256({ ...REQUEST, curve: 'secp256k1' as never }, new Uint8Array(1))
    ).rejects.toMatchObject({ code: 'internal' })
  })
})
