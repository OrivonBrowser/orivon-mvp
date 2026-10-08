// Broker.app.heldSync: the synchronous read of one grant that the permission check handler needs, which can never
// wait for an answer. It reads the ledger and never the manifest: a declared kind is not a held one.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'

describe('Broker.app.heldSync', () => {
  it('is false for a kind declared in the manifest but never granted', () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ media: { camera: true } }))
    expect(broker.app.heldSync(APP, 'media.camera')).toBe(false)
  })

  it('is true once granted, only for that kind, and false again once revoked', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ media: { camera: true, microphone: true } }))
    const camera = await broker.grant(APP, 'media.camera', [])
    expect(broker.app.heldSync(APP, 'media.camera')).toBe(true)
    expect(broker.app.heldSync(APP, 'media.microphone')).toBe(false)
    await broker.revoke(APP, camera.id)
    expect(broker.app.heldSync(APP, 'media.camera')).toBe(false)
  })

  it('is false for an origin the broker has never seen and for an unparseable one', () => {
    const broker = createBroker(baseDeps())
    expect(broker.app.heldSync('https://other.example', 'media.camera')).toBe(false)
    expect(broker.app.heldSync('not a url', 'media.camera')).toBe(false)
  })
})

describe('Broker.app.grantedPatternsSync', () => {
  it('names the patterns a kind was granted over, and nothing once it is revoked or never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ devices: { hid: [{ vendorId: 0x2c97 }] } }))
    expect(broker.app.grantedPatternsSync(APP, 'devices.hid')).toBeUndefined()
    const grant = await broker.grant(APP, 'devices.hid', ['vendor=2c97'])
    expect(broker.app.grantedPatternsSync(APP, 'devices.hid')).toEqual(['vendor=2c97'])
    expect(broker.app.grantedPatternsSync(APP, 'media.camera')).toBeUndefined()
    await broker.revoke(APP, grant.id)
    expect(broker.app.grantedPatternsSync(APP, 'devices.hid')).toBeUndefined()
    expect(broker.app.grantedPatternsSync('not a url', 'devices.hid')).toBeUndefined()
  })
})
