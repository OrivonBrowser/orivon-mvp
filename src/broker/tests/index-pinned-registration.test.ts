// A restored app is a registered app from startup. The app loader's
// restore pass (src/loader/electron-serve.ts) hands the broker each pinned,
// hash-verified manifest through `hydrateFromPinnedManifest`; without that
// manifest also counting as registered, a restored app's tab is built
// without the app-tab flag (no routed fetch, no process shim) and
// `orivon.app.manifest()` rejects until a page reports its hint.
//
// Registration from a pinned manifest must not raise the version floor, and
// must leave the fresh manifest's own `registerApp` authoritative: that call
// still re-validates the restored grants (index-hydration-grant-identity
// .test.ts) and replaces what `app.manifest()` answers.

import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../contracts/index.js'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage } from './index.test-helpers.js'

describe('createBroker -- a pinned manifest registers the app from startup', () => {
  it('isRegisteredSync, app.manifest() and registeredOriginsSync all answer from the pinned manifest before any registerApp call', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
    const pinned = manifestWith({})

    expect(broker.app.isRegisteredSync(APP)).toBe(false)
    await broker.app.hydrateFromPinnedManifest(APP, pinned)

    expect(broker.app.isRegisteredSync(APP)).toBe(true)
    expect(await broker.app.manifest(APP)).toEqual(pinned)
    expect(broker.app.registeredOriginsSync()).toEqual([APP])
  })

  it('does not raise the version floor', async () => {
    const storage = memoryLedgerStorage()
    const broker = createBroker(baseDeps({ ledgerStorage: storage }))

    await broker.app.hydrateFromPinnedManifest(APP, { ...manifestWith({}), version: '9.0.0' })

    expect(await broker.versionFloorFor(APP)).toBe('0.0.0')
    expect(storage.floors.has(APP)).toBe(false)
  })

  it('a later registerApp is authoritative: its manifest replaces the pinned one, it raises the floor as usual, and the origin is listed once', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
    await broker.app.hydrateFromPinnedManifest(APP, manifestWith({}))

    const fresh = { ...manifestWith({ fs: {} }), version: '1.1.0' }
    await broker.registerApp(APP, fresh)

    expect(await broker.app.manifest(APP)).toEqual(fresh)
    expect(await broker.versionFloorFor(APP)).toBe('1.1.0')
    expect(broker.app.registeredOriginsSync()).toEqual([APP])
  })

  it('the socket allowance follows the pinned manifest\'s declared concurrentSockets before registerApp runs', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
    const declared = Math.min(LIMITS.defaultConcurrentSockets + 4, LIMITS.concurrentSockets)
    expect(declared).not.toBe(LIMITS.defaultConcurrentSockets)

    await broker.app.hydrateFromPinnedManifest(APP, manifestWith({ net: { concurrentSockets: declared } }))

    expect(broker.app.socketAllowanceSync(APP)).toBe(declared)
  })

  it('a restored app\'s sockets are counted against its pinned declaration, not the platform default', async () => {
    const storage = memoryLedgerStorage()
    const pattern = '93.184.216.34:443'
    const declared = manifestWith({ net: { tcp: { connect: [pattern] }, concurrentSockets: 1 } })
    const before = createBroker(baseDeps({ ledgerStorage: storage }))
    await before.registerApp(APP, declared)
    await before.grant(APP, 'tcp.connect', [pattern])

    const restored = createBroker(baseDeps({ ledgerStorage: storage }))
    await restored.app.hydrateFromPinnedManifest(APP, declared)
    const first = await restored.net.connect(APP, { host: '93.184.216.34', port: 443 })

    await expect(restored.net.connect(APP, { host: '93.184.216.34', port: 443 })).rejects.toMatchObject({ code: 'limit' })
    await first.close()
  })
})
