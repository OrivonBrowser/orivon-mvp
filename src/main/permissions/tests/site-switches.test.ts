import { describe, expect, it } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { APP, baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import { turnOffCapability, turnOnCapability } from '../site-switches.js'

// The site-info popover's switches. Proven against a REAL broker
// throughout (matching request-grant.test.ts's own "a real, persisted
// grant" describe block) -- the exact defect these primitives exist to
// avoid, a `recordDeclinedConsent` call that erases an unrelated decline,
// is invisible against a stub that merely records the call was made.

function realBroker (): Broker {
  return createBroker(baseDeps())
}

describe('turnOffCapability', () => {
  it('revokes the live grant', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    await turnOffCapability(broker, APP, 'tcp.connect')

    expect(await broker.app.grants(APP)).toEqual([])
  })

  it('records the decline, so the next visit does not re-prompt for it (loader/index.ts\'s withoutSwitchedOffCapabilities)', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    await turnOffCapability(broker, APP, 'tcp.connect')

    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('unions with an existing decline for a DIFFERENT capability -- never erases it (recordDeclinedConsent replaces the whole set)', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])
    await broker.recordDeclinedConsent(APP, ['fs'])

    await turnOffCapability(broker, APP, 'tcp.connect')

    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs', 'tcp.connect'])
  })

  it('turning off an app\'s only grant leaves it registered but holding nothing -- the all-sites list still finds it via registeredOriginsSync', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])

    await turnOffCapability(broker, APP, 'fs')

    expect(broker.app.isRegisteredSync(APP)).toBe(true)
    expect(await broker.app.grants(APP)).toEqual([])
  })

  it('is a no-op, not a throw, for a capability that was never held', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))

    await expect(turnOffCapability(broker, APP, 'fs')).resolves.toBeUndefined()
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs'])
  })
})

describe('turnOnCapability', () => {
  it('grants exactly the shown patterns when the manifest still agrees, and clears the decline', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.recordDeclinedConsent(APP, ['fs'])

    const result = await turnOnCapability(broker, APP, 'fs', [])

    expect(result).toBe('ok')
    expect(await broker.app.grants(APP)).toEqual([{ id: expect.any(String), origin: APP, capability: 'fs', patterns: [], grantedAt: expect.any(Number) }])
    expect(await broker.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('leaves an unrelated decline alone when turning a different capability on (A172(3))', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } }))
    await broker.recordDeclinedConsent(APP, ['tcp.connect', 'fs'])

    await turnOnCapability(broker, APP, 'tcp.connect', ['api.example.com:443'])

    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs'])
  })

  it('resolves not-registered, and grants nothing, for an origin with no manifest registered this session', async () => {
    const broker = realBroker()

    const result = await turnOnCapability(broker, APP, 'fs', [])

    expect(result).toBe('not-registered')
    expect(await broker.app.grants(APP)).toEqual([])
  })

  it('resolves not-declared, and grants nothing, when the current manifest no longer declares the capability', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({}))

    const result = await turnOnCapability(broker, APP, 'fs', [])

    expect(result).toBe('not-declared')
    expect(await broker.app.grants(APP)).toEqual([])
  })

  // A153's own hazard, one layer up: the popover can stay open while a
  // reload re-registers a narrower manifest underneath it. Confirming
  // then must not silently grant something narrower than what was shown --
  // it must fail closed and let the popover redraw.
  it('resolves stale, and grants nothing, when the manifest narrowed after the row was shown', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))

    // The manifest has since been re-registered narrower -- registerApp
    // only ever RAISES the floor and leaves the live manifest as the
    // latest one registered, so this simulates a reload in between.
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    const result = await turnOnCapability(broker, APP, 'tcp.connect', ['*:*'])

    expect(result).toBe('stale')
    expect(await broker.app.grants(APP)).toEqual([])
  })

  it('never grants something wider than what was shown, even if the manifest widened in the meantime', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))

    const result = await turnOnCapability(broker, APP, 'tcp.connect', ['api.example.com:443'])

    expect(result).toBe('stale')
    expect(await broker.app.grants(APP)).toEqual([])
  })

  it('turning fs back on after it was turned off is a no-op regrant when it was never actually removed (grantChangedCapabilities\' own skip)', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])
    const before = await broker.app.grants(APP)

    const result = await turnOnCapability(broker, APP, 'fs', [])

    expect(result).toBe('ok')
    expect(await broker.app.grants(APP)).toEqual(before) // same GrantId: no live handle was torn down for nothing
  })
})
