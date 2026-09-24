// orivon.secrets's three entry points (../secrets-capability.ts, ADR-0031),
// exercised through createBroker exactly the way ./id-capability.test.ts
// exercises orivon.id -- same fixtures, same "grant, then call" shape.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'
import { openSecret, sealSecret } from '../policy/secret-seal.js'
import { originFromUrl } from '../policy/origin.js'
import { LIMITS } from '../../contracts/index.js'

/** 32 varying, non-secret bytes -- an all-repeated seed trips derive.ts's own degenerate-seed guard. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i)

/** A keychain whose seed is persistent -- most tests here want this;
 * `baseDeps`'s own default keychain has no `isPersistent` at all, which
 * fails closed to "not persistent" (secrets-contracts.ts's own doc). */
function persistentKeychain (): { getSeed: () => Promise<Uint8Array>, isPersistent: () => Promise<boolean> } {
  return { getSeed: async () => SEED, isPersistent: async () => true }
}

describe('orivon.secrets.available', () => {
  it('is false when the origin holds no secrets grant at all', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    expect(await broker.secrets.available(APP)).toBe(false)
  })

  it('is false, even WITH a grant, when the keychain reports no isPersistent method at all (fails closed)', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED } }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    expect(await broker.secrets.available(APP)).toBe(false)
  })

  it('is false, even WITH a grant, when the keychain reports the seed is session-only', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED, isPersistent: async () => false } }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    expect(await broker.secrets.available(APP)).toBe(false)
  })

  it('is true with a grant and a persistent seed', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    expect(await broker.secrets.available(APP)).toBe(true)
  })
})

describe('orivon.secrets.encrypt', () => {
  it('is denied when the origin holds no secrets grant at all', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await expect(broker.secrets.encrypt(APP, new Uint8Array([1]))).rejects.toMatchObject({ code: 'denied' })
  })

  it('is unavailable, even WITH a grant, when the seed is session-only', async () => {
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => SEED, isPersistent: async () => false } }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    await expect(broker.secrets.encrypt(APP, new Uint8Array([1]))).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects plaintext past LIMITS.secretBytes with limit', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    await expect(broker.secrets.encrypt(APP, new Uint8Array(LIMITS.secretBytes + 1)))
      .rejects.toMatchObject({ code: 'limit' })
  })

  it('produces ciphertext openSecret can open directly, under this origin\'s own canonical key', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    const plaintext = new TextEncoder().encode('a small secret')
    const wire = await broker.secrets.encrypt(APP, plaintext)
    const opened = await openSecret(SEED, originFromUrl(APP)!, wire)
    expect(opened).toEqual(plaintext)
  })
})

describe('orivon.secrets.decrypt', () => {
  it('is denied when the origin holds no secrets grant at all', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await expect(broker.secrets.decrypt(APP, new Uint8Array(32))).rejects.toMatchObject({ code: 'denied' })
  })

  it('round-trips exactly what encrypt sealed, granted once', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    const plaintext = new TextEncoder().encode('round trip me')
    const wire = await broker.secrets.encrypt(APP, plaintext)
    expect(await broker.secrets.decrypt(APP, wire)).toEqual(plaintext)
  })

  it('is invalid for ciphertext a DIFFERENT origin produced', async () => {
    const broker = createBroker(baseDeps({ keychain: persistentKeychain() }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    const OTHER = 'https://other.example'
    broker.registerApp(OTHER, manifestWith({ secrets: {} }))
    await broker.grant(OTHER, 'secrets', [])
    const wireFromOther = await broker.secrets.encrypt(OTHER, new Uint8Array([9]))

    await expect(broker.secrets.decrypt(APP, wireFromOther)).rejects.toMatchObject({ code: 'invalid' })
  })

  // decrypt does NOT require a persistent seed: it can still succeed against
  // ciphertext sealed earlier in the SAME session (the seed is memoized per
  // process, so a session-only seed is still internally consistent for its
  // own lifetime) -- only encrypt refuses up front, so an app cannot commit
  // data it would silently lose.
  it('still succeeds decrypting session-sealed ciphertext even though isPersistent is false', async () => {
    const keychain = { getSeed: async () => SEED, isPersistent: async () => false }
    const broker = createBroker(baseDeps({ keychain }))
    broker.registerApp(APP, manifestWith({ secrets: {} }))
    await broker.grant(APP, 'secrets', [])
    const wire = await sealSecret(SEED, originFromUrl(APP)!, new Uint8Array([1, 2, 3]))
    expect(await broker.secrets.decrypt(APP, wire)).toEqual(new Uint8Array([1, 2, 3]))
  })
})
