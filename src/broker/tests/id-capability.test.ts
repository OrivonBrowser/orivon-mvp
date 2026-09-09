// orivon.id's two entry points (../id-capability.ts), exercised through
// createBroker exactly the way net-capability.ts's own tests exercise
// connect/udpBind/listen -- same fixtures (index.test-helpers.ts), same
// "grant, then call" shape.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'
import { derivePublicKey } from '../policy/derive-p256.js'

/** 32 varying, non-secret bytes -- an all-repeated seed trips derive.ts's own degenerate-seed guard. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i)

describe('orivon.id', () => {
  it('publicKey is denied when the origin holds no id grant at all', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))

    await expect(broker.id.publicKey(APP, { curve: 'P-256' }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('sign is denied when the origin holds no id grant at all', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))

    await expect(broker.id.sign(APP, { curve: 'P-256', payload: new Uint8Array(1) }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('publicKey is denied for a curve the grant does not name, even though a DIFFERENT curve is granted', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256', 'secp256k1'] } }))
    await broker.grant(APP, 'id', ['secp256k1'])

    await expect(broker.id.publicKey(APP, { curve: 'P-256' }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('a granted curve produces the same public key derivePublicKey computes directly for this origin', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))
    await broker.grant(APP, 'id', ['P-256'])

    const publicKey = await broker.id.publicKey(APP, { curve: 'P-256' })
    const expected = await derivePublicKey({ seed: SEED, label: 'app', scope: APP, curve: 'P-256' })
    expect(publicKey).toEqual(expected)
    // Uncompressed SEC1 point: 0x04 || X || Y.
    expect(publicKey[0]).toBe(0x04)
    expect(publicKey).toHaveLength(65)
  })

  it('a granted curve signs a payload with a signature that verifies against that same public key', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))
    await broker.grant(APP, 'id', ['P-256'])

    const publicKey = await broker.id.publicKey(APP, { curve: 'P-256' })
    const payload = new TextEncoder().encode('sign under a grant')
    const signature = await broker.id.sign(APP, { curve: 'P-256', payload })

    const verifyKey = await crypto.subtle.importKey(
      'raw', publicKey as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, verifyKey,
      signature as Uint8Array<ArrayBuffer>, payload as Uint8Array<ArrayBuffer>
    )
    expect(ok).toBe(true)
  })

  it('revoking the id grant denies a subsequent sign call', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))
    const record = await broker.grant(APP, 'id', ['P-256'])
    await broker.id.publicKey(APP, { curve: 'P-256' }) // works before revoke

    await broker.revoke(APP, record.id)

    await expect(broker.id.sign(APP, { curve: 'P-256', payload: new Uint8Array(1) }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('replacing the id grant with a narrower curve set denies the curve that was dropped', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256', 'secp256k1'] } }))
    await broker.grant(APP, 'id', ['P-256', 'secp256k1'])
    await broker.grant(APP, 'id', ['P-256']) // replaces the earlier grant under a fresh GrantId

    await expect(broker.id.publicKey(APP, { curve: 'secp256k1' }))
      .rejects.toMatchObject({ code: 'denied' })
  })

  it('a granted but unimplemented curve (secp256k1) fails internal, not denied -- the grant answered, the policy layer cannot serve it yet', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['secp256k1'] } }))
    await broker.grant(APP, 'id', ['secp256k1'])

    await expect(broker.id.publicKey(APP, { curve: 'secp256k1' }))
      .rejects.toMatchObject({ code: 'internal' })
    await expect(broker.id.sign(APP, { curve: 'secp256k1', payload: new Uint8Array(1) }))
      .rejects.toMatchObject({ code: 'internal' })
  })

  it('a granted but nonsense curve string fails invalid -- an app mistake, not a broker fault', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['not-a-curve'] } }))
    await broker.grant(APP, 'id', ['not-a-curve'])

    await expect(broker.id.publicKey(APP, { curve: 'not-a-curve' }))
      .rejects.toMatchObject({ code: 'invalid' })
  })

  it('a denial never carries a platformCode, granted or not -- an app must not be able to tell "never granted" from "wrong curve" by probing', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))

    await broker.id.publicKey(APP, { curve: 'P-256' }).catch((error: unknown) => {
      expect((error as { platformCode?: unknown }).platformCode).toBeUndefined()
    })
  })
})
