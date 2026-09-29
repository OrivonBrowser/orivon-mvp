import { describe, expect, it, vi } from 'vitest'
import { addDeclinedCapability, clearDeclinedCapability, requestGrant } from '../request-grant.js'
import type { PendingGrantRequests } from '../request-grant.js'
import { APP, stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../../broker/transport/tests/ipc.test-helpers.js'
import { createBroker } from '../../../broker/index.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import { baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'

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

  // ADR-0019, spec item 6: 'web.context' is declared-in-the-manifest-only --
  // app.requestGrant must never mint one dynamically, even when the
  // manifest declares exactly the origin being asked for. Checked BEFORE
  // manifest.() is ever read, so this never even reaches the broker.
  it('resolves false without prompting for web.context, even when the manifest declares exactly the requested origin', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => manifestWith({ web: { contexts: ['https://example.com'] } }) })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'web.context', patterns: ['https://example.com'] })

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
    const broker = stubBroker(calls, { manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }), declinedCapabilitiesFor: async () => undefined })
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
      },
      declinedCapabilitiesFor: async () => undefined
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

  // A capability already on the declined-consent record resolves false with
  // NO prompt at all, however often a page calls app.requestGrant for it.
  // The only door off this list is a real accept, through install-
  // consent.ts's own all-or-nothing flow (a DIFFERENT decline record write)
  // or the site-info popover's clearDeclinedCapability -- never another
  // app.requestGrant call for the same, still-declined capability.
  it('a previously declined capability never re-prompts, however often app.requestGrant is called', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }),
      declinedCapabilitiesFor: async () => ['tcp.connect']
    })
    const consent = vi.fn(async () => true) // even a person who WOULD say yes is never asked again

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      expect(await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })).toBe(false)
    }

    expect(consent).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  // A172(3), MEDIUM: install-consent.ts's own all-or-nothing accept clears
  // an origin's WHOLE declined-consent record ("an old no cannot outlive a
  // yes", that file's header) -- but this is a SECOND door to a grant.
  // `fs` was declined through the OTHER door and `tcp.connect` never was,
  // so this reaches consent, grants, and retires only `tcp.connect` here --
  // never touching `fs`, which nobody asked about through this door.
  it('A172(3): an accepted grant retires this capability\'s own decline, leaving any OTHER declined capability alone', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => ['fs'],
      recordDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'tcp.connect' })

    expect(result).toBe(true)
    // clearDeclinedCapability is a no-op here (tcp.connect was never on the
    // declined record to begin with) -- recordDeclinedConsent is never
    // called, and `fs` is never read back or rewritten.
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('fails closed if the origin\'s manifest is gone entirely by the time consent returns', async () => {
    const calls: BrokerCall[] = []
    let manifestReads = 0
    const broker = stubBroker(calls, {
      manifest: async () => {
        manifestReads += 1
        if (manifestReads === 1) return manifestWith({ fs: { quotaBytes: 1024 } })
        throw new Error('no manifest registered for this origin')
      },
      declinedCapabilitiesFor: async () => undefined
    })
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' })

    expect(result).toBe(false)
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })
})

// A page firing a burst of app.requestGrant calls for the same capability,
// faster than the person can answer the first dialog, shares one dialog
// rather than opening one native dialog per call.
describe('requestGrant: a shared PendingGrantRequests map de-dupes concurrent calls', () => {
  it('150 concurrent calls for the same (origin, capability) share ONE consent() call', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    // The dialog stays open until every one of the 150 callers is already
    // waiting on it -- proves they all shared the SAME pending promise
    // rather than each opening (and immediately resolving) its own.
    let resolveDialog: ((accepted: boolean) => void) | undefined
    const consent = vi.fn(async () => await new Promise<boolean>((resolve) => { resolveDialog = resolve }))
    const pending: PendingGrantRequests = new Map()

    const results = Promise.all(Array.from({ length: 150 }, async () =>
      await requestGrant(broker, consent, APP, { capability: 'tcp.connect' }, pending)))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(consent).toHaveBeenCalledTimes(1) // not 150
    resolveDialog?.(true)
    expect(await results).toEqual(Array.from({ length: 150 }, () => true))
    expect(pending.size).toBe(0) // the slot is released once every waiter has its answer
  })

  it('a call for a DIFFERENT capability on the same origin gets its own dialog, never the other one\'s answer', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } }, fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async (_origin: string, capability: string) => capability === 'tcp.connect')
    const pending: PendingGrantRequests = new Map()

    const [connectResult, fsResult] = await Promise.all([
      requestGrant(broker, consent, APP, { capability: 'tcp.connect' }, pending),
      requestGrant(broker, consent, APP, { capability: 'fs' }, pending)
    ])

    expect(consent).toHaveBeenCalledTimes(2)
    expect(connectResult).toBe(true)
    expect(fsResult).toBe(false)
  })

  it('a later, non-concurrent call for the same capability gets its own dialog again', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const pending: PendingGrantRequests = new Map()

    await requestGrant(broker, consent, APP, { capability: 'tcp.connect' }, pending)
    await requestGrant(broker, consent, APP, { capability: 'tcp.connect' }, pending)

    expect(consent).toHaveBeenCalledTimes(2)
  })
})

// Decision 10/Task 1: a dialog answered by, or on behalf of, a page the
// person is no longer looking at must never turn into a grant -- and must
// never be written down as a decline either, since nobody who could see the
// question actually answered "no".
describe('requestGrant: a caller that has left by the time consent() resolves', () => {
  it('never grants, even though consent() resolved true', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const caller = { window: () => undefined, stillOn: () => false }

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, caller)

    expect(result).toBe(false)
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('does not record a decline for a caller that left -- a later, genuine ask still prompts', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined
    })
    const consent = vi.fn(async () => true)
    const caller = { window: () => undefined, stillOn: () => false }

    await requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, caller)

    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('a caller still present is unaffected -- consent()\'s own answer still governs', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const caller = { window: () => undefined, stillOn: () => true }

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, caller)

    expect(result).toBe(true)
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'fs', patterns: [] } })
  })
})

// Task 2: keeps the per-(origin, capability) sharing above, and ALSO
// serialises the dialog itself across DIFFERENT capabilities of one origin,
// so a page cannot stack one dialog per capability it asks for at once.
describe('requestGrant: a shared PendingGrantPrompts map serialises the dialog per origin', () => {
  it('a second capability\'s dialog for the same origin waits for the first to resolve, then shows its own', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } }, fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    let resolveFirst: ((accepted: boolean) => void) | undefined
    const consent = vi.fn((_origin: string, capability: string) => {
      if (capability === 'tcp.connect') return new Promise<boolean>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(true)
    })
    const prompts = new Map<string, Promise<void>>()

    const results = Promise.all([
      requestGrant(broker, consent, APP, { capability: 'tcp.connect' }, undefined, undefined, prompts),
      requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, undefined, prompts)
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The SECOND capability's own consent() call has not been made yet --
    // only the first dialog is open.
    expect(consent).toHaveBeenCalledTimes(1)

    resolveFirst?.(true)
    await results

    expect(consent).toHaveBeenCalledTimes(2)
  })

  it('two DIFFERENT origins never wait on each other', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    let resolveFirst: ((accepted: boolean) => void) | undefined
    const consent = vi.fn((origin: string) => {
      if (origin === APP) return new Promise<boolean>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(true)
    })
    const prompts = new Map<string, Promise<void>>()

    const other = 'https://other.example'
    const results = Promise.all([
      requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, undefined, prompts),
      requestGrant(broker, consent, other, { capability: 'fs' }, undefined, undefined, prompts)
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The other origin's dialog already ran -- it never queued behind APP's.
    expect(consent).toHaveBeenCalledTimes(2)

    resolveFirst?.(true)
    await results
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

  // The full production shape for `id`, end to end through THIS function --
  // not `broker.grant()` called directly the way every id-capability.test.ts
  // case does, and not the dev-only grant hook. `manifest-patterns.ts` maps
  // a declared `id` capability to `patterns: []` (presence alone is the
  // ask), so this is the exact call `decideGrantRequest` produces for a real
  // consent-made grant. Regression coverage for the capabilities/id.ts fix:
  // before it, this exact sequence left every real `orivon.id` call denied.
  it('an accepted id grant carries empty patterns, and the origin can still use every curve its manifest declared', async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i)
    const broker = createBroker(baseDeps({ keychain: { getSeed: async () => seed } }))
    await broker.registerApp(APP, manifestWith({ id: { curves: ['P-256'] } }))
    const consent = vi.fn(async () => true)

    const result = await requestGrant(broker, consent, APP, { capability: 'id' })
    expect(result).toBe(true)

    const grants = await broker.app.grants(APP)
    expect(grants).toMatchObject([{ origin: APP, capability: 'id', patterns: [] }])

    await expect(broker.id.publicKey(APP, { curve: 'P-256' })).resolves.toBeInstanceOf(Uint8Array)
  })
})

// The site-info popover's own turn-on/turn-off primitives
// (../permissions/site-switches.js). `broker.recordDeclinedConsent`
// REPLACES the whole decline set, so both helpers below have to read
// before they write -- proven here against a real ledger, not a stub that
// could hide the overwrite.
describe('addDeclinedCapability / clearDeclinedCapability (real broker)', () => {
  function realBroker (): Broker {
    return createBroker(baseDeps())
  }

  it('addDeclinedCapability adds to an empty record', async () => {
    const broker = realBroker()
    await addDeclinedCapability(broker, APP, 'tcp.connect')
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('addDeclinedCapability unions with an existing record, never overwrites it', async () => {
    const broker = realBroker()
    await broker.recordDeclinedConsent(APP, ['fs'])
    await addDeclinedCapability(broker, APP, 'tcp.connect')
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs', 'tcp.connect'])
  })

  it('addDeclinedCapability is a no-op when the capability is already declined', async () => {
    const broker = realBroker()
    await broker.recordDeclinedConsent(APP, ['fs', 'tcp.connect'])
    await addDeclinedCapability(broker, APP, 'tcp.connect')
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs', 'tcp.connect'])
  })

  it('clearDeclinedCapability drops only the named capability, keeping the rest', async () => {
    const broker = realBroker()
    await broker.recordDeclinedConsent(APP, ['fs', 'tcp.connect'])
    await clearDeclinedCapability(broker, APP, 'tcp.connect')
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs'])
  })

  it('clearDeclinedCapability clears the whole record once nothing remains', async () => {
    const broker = realBroker()
    await broker.recordDeclinedConsent(APP, ['tcp.connect'])
    await clearDeclinedCapability(broker, APP, 'tcp.connect')
    expect(await broker.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('clearDeclinedCapability on an origin never declined is a no-op', async () => {
    const broker = realBroker()
    await expect(clearDeclinedCapability(broker, APP, 'tcp.connect')).resolves.toBeUndefined()
    expect(await broker.declinedCapabilitiesFor(APP)).toBeUndefined()
  })
})

// A caller's own IPC transport times out a call it waited too long for
// (A153) well before withOriginTurn's per-origin queue necessarily reaches
// this call's turn -- the app already has a timeout failure by then, so the
// dialog must never show for it.
describe('requestGrant: an abandoned call never shows its dialog', () => {
  it('resolves false and never calls consent() once abandoned fires before the dialog\'s turn', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined
    })
    const consent = vi.fn(async () => true)
    const controller = new AbortController()
    controller.abort()

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, undefined, undefined, controller.signal)

    expect(result).toBe(false)
    expect(consent).not.toHaveBeenCalled()
  })

  it('does not record a decline for an abandoned call -- a later, genuine ask still prompts', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined
    })
    const consent = vi.fn(async () => true)
    const controller = new AbortController()
    controller.abort()

    await requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, undefined, undefined, controller.signal)

    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('still shows the dialog for a call whose signal has not fired', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const controller = new AbortController()

    const result = await requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, undefined, undefined, controller.signal)

    expect(result).toBe(true)
    expect(consent).toHaveBeenCalledOnce()
  })

  it('an abandoned call queued behind a live one is skipped without blocking the live one\'s own dialog', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } }, fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    let resolveFirst: ((accepted: boolean) => void) | undefined
    const consent = vi.fn((_origin: string, capability: string) => {
      if (capability === 'tcp.connect') return new Promise<boolean>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(true)
    })
    const prompts = new Map<string, Promise<void>>()
    const controller = new AbortController()

    const results = Promise.all([
      requestGrant(broker, consent, APP, { capability: 'tcp.connect' }, undefined, undefined, prompts),
      requestGrant(broker, consent, APP, { capability: 'fs' }, undefined, undefined, prompts, controller.signal)
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort() // fires while the second call is still queued behind the first
    resolveFirst?.(true)

    expect(await results).toEqual([true, false])
    expect(consent).toHaveBeenCalledTimes(1) // the abandoned call's own dialog never opened
  })
})

// Two different tabs asking for the identical (origin, capability, patterns)
// at once must never share one dialog or its eventual answer -- sharing
// would let the second tab's page silently receive the first tab's answer,
// parented to the first tab's window.
describe('requestGrant: PendingGrantRequests never shares across callers or pattern sets', () => {
  it('two different callers requesting the same (origin, capability) each get their own dialog', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const pending: PendingGrantRequests = new Map()
    const callerA = { window: () => undefined, stillOn: () => true, id: { tab: 'a' } }
    const callerB = { window: () => undefined, stillOn: () => true, id: { tab: 'b' } }

    await Promise.all([
      requestGrant(broker, consent, APP, { capability: 'fs' }, pending, callerA),
      requestGrant(broker, consent, APP, { capability: 'fs' }, pending, callerB)
    ])

    expect(consent).toHaveBeenCalledTimes(2)
    expect(pending.size).toBe(0) // both tabs' slots are released once their own answer lands
  })

  it('the same caller requesting two different pattern sets for the same capability gets a dialog for each', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const pending: PendingGrantRequests = new Map()
    const caller = { window: () => undefined, stillOn: () => true, id: { tab: 'a' } }

    await Promise.all([
      requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['api.example.com:443'] }, pending, caller),
      requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['*:*'] }, pending, caller)
    ])

    expect(consent).toHaveBeenCalledTimes(2)
  })

  it('the same caller requesting the identical pattern set twice, concurrently, still shares one dialog', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ net: { tcp: { connect: ['*:*'] } } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    let resolveDialog: ((accepted: boolean) => void) | undefined
    const consent = vi.fn(async () => await new Promise<boolean>((resolve) => { resolveDialog = resolve }))
    const pending: PendingGrantRequests = new Map()
    const caller = { window: () => undefined, stillOn: () => true, id: { tab: 'a' } }

    const results = Promise.all([
      requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['api.example.com:443'] }, pending, caller),
      requestGrant(broker, consent, APP, { capability: 'tcp.connect', patterns: ['api.example.com:443'] }, pending, caller)
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(consent).toHaveBeenCalledTimes(1)
    resolveDialog?.(true)
    expect(await results).toEqual([true, true])
  })

  it('a caller-less call and a second, different caller never collide, even for the same (origin, capability)', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      manifest: async () => manifestWith({ fs: { quotaBytes: 1024 } }),
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const pending: PendingGrantRequests = new Map()
    const caller = { window: () => undefined, stillOn: () => true, id: { tab: 'a' } }

    await Promise.all([
      requestGrant(broker, consent, APP, { capability: 'fs' }, pending),
      requestGrant(broker, consent, APP, { capability: 'fs' }, pending, caller)
    ])

    expect(consent).toHaveBeenCalledTimes(2)
  })
})
