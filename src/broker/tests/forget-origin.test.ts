import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage } from './index.test-helpers.js'

// A first visit whose files turned out not to be the declared ones takes the app away entirely: its registration
// (so its tab is no app tab), its grants and the handles they authorised, and the version floor registering
// raised, so that the next visit is a first visit again.

describe('Broker.forgetOrigin', () => {
  it('leaves nothing of a registered, granted origin: not the registration, the grants, nor the version floor', async () => {
    const storage = memoryLedgerStorage()
    const broker = createBroker(baseDeps({ ledgerStorage: storage }))
    await broker.registerApp(APP, { ...manifestWith({ net: { tcp: { connect: ['*:*'] } } }), version: '2.0.0' })
    await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    expect(broker.app.isRegisteredSync(APP)).toBe(true)
    expect(await broker.versionFloorFor(APP)).toBe('2.0.0')
    expect(storage.floors.size).toBe(1)

    await broker.forgetOrigin(APP)

    expect(broker.app.isRegisteredSync(APP)).toBe(false)
    expect(broker.app.hasGrantsSync(APP)).toBe(false)
    expect(await broker.app.grants(APP)).toEqual([])
    expect(await broker.versionFloorFor(APP)).toBe('0.0.0')
    expect(storage.floors.size).toBe(0)
    expect(storage.grants.size).toBe(0)
  })

  it('says so to a view of the grants, once', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const seen: string[] = []
    broker.onGrantsChanged((origin) => { seen.push(origin) })
    await broker.forgetOrigin(APP)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(new Set(seen)).toEqual(new Set([APP]))
  })

  it('is a no-op for an origin the broker holds nothing for', async () => {
    const broker = createBroker(baseDeps())
    await expect(broker.forgetOrigin('https://nothing.example')).resolves.toBeUndefined()
  })
})
