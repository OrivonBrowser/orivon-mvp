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
      declinedCapabilitiesFor: async () => undefined,
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

  // Finding 1 (A153, docs/open-questions.md): the dialog `consent()` awaits
  // can run for up to 120 seconds, and installFromHint can re-register a
  // narrower manifest for this same origin at any point while it is open
  // (a page re-triggering its own <link rel="orivon-manifest"> hint by
  // reloading itself). Nothing re-checked the manifest between computing
  // `decision` and calling `broker.grant()`, so a decision computed against
  // a manifest that no longer holds could still be committed.
  it('re-reads the manifest after consent and fails closed if it no longer allows what was approved', async () => {
    const calls: BrokerCall[] = []
    let manifestReads = 0
    const broker = stubBroker(calls, {
      manifest: async () => {
        manifestReads += 1
        // The dialog is shown against THIS manifest (wide) -- by the time
        // the person answers, a fresh install has narrowed it.
        return manifestReads === 1
          ? manifestWith({ net: { tcp: { connect: ['*:*'] } } })
          : manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
      }
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['evil.example.com:443'] })

    expect(result).toBe(false)
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
    // Proves the re-check actually happened, not merely that grant was skipped
    // for some unrelated reason.
    expect(manifestReads).toBeGreaterThanOrEqual(2)
  })

  it('still commits when the re-read manifest agrees with the one the dialog was shown', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })

    expect(result).toBe(true)
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
  })

  // A172(3), MEDIUM: install-consent.ts's own all-or-nothing accept clears
  // an origin's WHOLE declined-consent record ("an old no cannot outlive a
  // yes", that file's header) -- but this is a SECOND door to a grant, and
  // an accepted requestGrant call used to leave a stale decline in place
  // for the exact capability it just granted. Only THIS capability is
  // retired: a yes for tcp.connect must not silently un-decline fs, which
  // nobody asked about through this door.
  it('A172(3): an accepted grant retires this capability\'s own decline, leaving any OTHER declined capability alone', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => ['tcp.connect', 'fs'],
      recordDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })

    expect(result).toBe(true)
    expect(calls).toContainEqual({ method: 'recordDeclinedConsent', origin: APP, args: ['fs'] })
  })

  it('fails closed if the origin\'s manifest is gone entirely by the time consent returns', async () => {
    const calls: BrokerCall[] = []
    let manifestReads = 0
    const broker = stubBroker(calls, {
      manifest: async () => {
        manifestReads += 1
        if (manifestReads === 1) return manifestWith({ fs: { quotaBytes: 1024 } })
        throw new Error('no manifest registered for this origin')
      }
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' })

    expect(result).toBe(false)
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
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
