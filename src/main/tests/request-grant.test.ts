import { describe, expect, it, vi } from 'vitest'
import { requestGrant } from '../request-grant.js'
import { APP, stubBroker } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../broker/transport/tests/ipc.test-helpers.js'
import { createBroker } from '../../broker/index.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { baseDeps, manifestWith } from '../../broker/tests/index.test-helpers.js'

// The mechanism behind OrivonApp.requestGrant: item 4.1's own exit
// criterion ("an accepted decision becomes a real, persisted grant") and
// its three security properties --
//   1. a grant can never exceed the manifest's declaration
//   2. the origin is the caller's, never taken from the request payload
//   3. declining, or asking for something undeclared, creates nothing
// This suite proves all three against a stub Broker (fast, exact call
// assertions) and then once more against a REAL createBroker (index.ts) so
// "a real, persisted grant" is not just a mocked promise resolving --
// see the last describe block.

describe('requestGrant (stubbed broker)', () => {
  it('resolves false and never calls grant when the capability is not declared', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => manifestWith({}) })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })

    expect(result).toBe(false)
    expect(consent).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('resolves false without prompting when the request is not a recognised capability kind', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } } }) })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'net.connect.something-else' })

    expect(result).toBe(false)
    expect(consent).not.toHaveBeenCalled()
  })

  it('resolves false and never calls grant when the request widens beyond what the manifest declares', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }) })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['*:*'] })

    expect(result).toBe(false)
    expect(consent).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('prompts, and resolves false without granting, when the user declines', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }) })
    const consent = vi.fn(async () => false)

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' })

    expect(result).toBe(false)
    expect(consent).toHaveBeenCalledWith(APP, 'fs', [])
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('prompts with the NARROWED patterns, never the raw request, and grants exactly those on acceptance', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } } }),
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['api.example.com:443'] })

    expect(result).toBe(true)
    expect(consent).toHaveBeenCalledWith(APP, 'tcp.connect', ['api.example.com:443'])
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
  })

  it('resolves false when no manifest was ever registered for the origin, without throwing', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => { throw new Error('no manifest registered for this origin') } })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' })

    expect(result).toBe(false)
    expect(consent).not.toHaveBeenCalled()
  })
})

describe('requestGrant (real broker) -- proves a real, persisted grant', () => {
  function realBroker (): Broker {
    return createBroker(baseDeps())
  }

  it('an accepted decision is visible afterward via broker.app.grants()', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })
    expect(result).toBe(true)

    const grants = await broker.app.grants(APP)
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'] })
  })

  it('a declined decision leaves the grant ledger exactly as it was', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    const consent = vi.fn(async () => false)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })
    expect(result).toBe(false)

    const grants = await broker.app.grants(APP)
    expect(grants).toHaveLength(0)
  })

  // Point 1 of the security shape, proven against the real subset check
  // AND the real ledger -- not just the pure decideGrantRequest unit tests.
  it('a request wider than declared never reaches the ledger, even if consent would have said yes', async () => {
    const broker = realBroker()
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['*:*'] })
    expect(result).toBe(false)
    expect(consent).not.toHaveBeenCalled()

    const grants = await broker.app.grants(APP)
    expect(grants).toHaveLength(0)
  })
})
