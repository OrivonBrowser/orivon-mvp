import { describe, expect, it, vi } from 'vitest'
import { requestInstallConsent } from '../install-consent.js'
import { APP, stubBroker } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../broker/transport/tests/ipc.test-helpers.js'
import { manifestWith, baseDeps, memoryLedgerStorage } from '../../broker/tests/index.test-helpers.js'
import { createBroker } from '../../broker/index.js'
import type { Grant } from '../../contracts/index.js'

// d-0025 (ADR-0012's 2026-09-13 amendment): the whole install-time consent
// flow -- ask once, for everything the manifest declares, all-or-nothing.
// Proven against a stub broker (exact call assertions) and then again
// against a real createBroker + a shared LedgerStorage standing in for two
// separate process launches, so "once per origin, ever" is checked against
// the real hydration mechanism (GrantLedger.registerApp's grantsHydrated
// for an accept, GrantLedger's declined-consent record for a decline --
// A145), not just a mocked grants()/declinedCapabilitiesFor() call.

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

describe('requestInstallConsent (stubbed broker)', () => {
  it('never prompts, and never touches grants(), for a manifest declaring no capabilities', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls)
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifestWith({}))

    expect(consent).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('prompts once with the whole declared set, and grants every accepted capability', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      clearDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
    expect(consent).toHaveBeenCalledWith(APP, manifest, expect.arrayContaining(['tcp.connect', 'fs']))
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'fs', patterns: [] } })
    // Accepting clears any earlier decline -- see the "clears a previous
    // decline" suite below for the case where one actually existed.
    expect(calls).toContainEqual({ method: 'clearDeclinedConsent', origin: APP, args: undefined })
  })

  // The clear-before-grant ordering matters, not just that both happen: see
  // install-consent.ts's own comment on why. Proven here even though one of
  // the two grant calls fails, so a real partial-failure run still shows the
  // clear landing first -- a reordering that put it after would leave a
  // capability that failed to grant still covered by the now-stale decline.
  it('clears the declined-consent record BEFORE granting, even when one capability fails to grant', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      clearDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => {
        if (capability === 'fs') throw new Error('disk full')
        return { id: 'g1', origin, capability, patterns, grantedAt: 0 }
      }
    })
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await requestInstallConsent(broker, async () => true, APP, manifest)
    consoleError.mockRestore()

    const clearIndex = calls.findIndex((call) => call.method === 'clearDeclinedConsent')
    const firstGrantIndex = calls.findIndex((call) => call.method === 'grant')
    expect(clearIndex).toBeGreaterThanOrEqual(0)
    expect(firstGrantIndex).toBeGreaterThanOrEqual(0)
    expect(clearIndex).toBeLessThan(firstGrantIndex)
  })

  it('does not prompt again when the origin already holds a live grant for every declared capability', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [grant()] })
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    expect(consent).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
    // The "already held" check short-circuits before the declined-consent
    // check is ever reached -- no call needed to declinedCapabilitiesFor.
    expect(calls.some((call) => call.method === 'declinedCapabilitiesFor')).toBe(false)
  })

  // Finding 3 / A157 (docs/open-questions.md): the old check skipped the
  // WHOLE dialog if the origin held a grant for ANY declared capability --
  // sound only if this function is the sole door to a grant. It is not:
  // app.requestGrant (./request-grant.ts) is a second one, and registerApp
  // runs before this in app-install.ts's own finishInstall, so a page
  // already running (A146) can call requestGrant for exactly ONE of its
  // declared capabilities in that window and, under the old check,
  // permanently suppress the dialog for every OTHER capability it declared
  // -- silently, with nothing distinguishing that state from "never asked".
  it('A157: still prompts when only SOME declared capabilities are already held', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      // tcp.connect only -- as if the page called app.requestGrant for just
      // this one capability before install-consent ever ran.
      grants: async () => [grant({ capability: 'tcp.connect' })],
      declinedCapabilitiesFor: async () => undefined,
      clearDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g2', origin, capability, patterns, grantedAt: 0 })
    })
    const consent = vi.fn(async () => true)
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

    await requestInstallConsent(broker, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
    expect(consent).toHaveBeenCalledWith(APP, manifest, expect.arrayContaining(['tcp.connect', 'fs']))
    // fs is the capability the old check silently withheld forever.
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'fs', patterns: [] } })
    // tcp.connect is already held with the manifest's own exact pattern --
    // re-granting it would tear down whatever live handle it already
    // authorises for no authority change at all (the same hazard as
    // Finding 2 / A156).
    expect(calls.some((call) => call.method === 'grant' && (call.args as { capability: string }).capability === 'tcp.connect')).toBe(false)
  })

  it('prompts, and grants nothing, when the person declines -- the app stays installed either way', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {}
    })
    const consent = vi.fn(async () => false)

    await requestInstallConsent(broker, consent, APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    expect(consent).toHaveBeenCalledOnce()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  // A145: the decline is remembered, not just declined this once.
  it('a decline records exactly the declared capability set, not a boolean', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {}
    })
    const consent = vi.fn(async () => false)
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

    await requestInstallConsent(broker, consent, APP, manifest)

    expect(calls).toContainEqual({
      method: 'recordDeclinedConsent',
      origin: APP,
      args: expect.arrayContaining(['tcp.connect', 'fs'])
    })
  })

  it('fails closed -- grants nothing and never throws -- when no consent prompt is wired', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [], declinedCapabilitiesFor: async () => undefined })

    await expect(requestInstallConsent(broker, undefined, APP, manifestWith({ fs: {} }))).resolves.toBeUndefined()

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('treats a throwing consent prompt as a decline rather than propagating', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [], declinedCapabilitiesFor: async () => undefined })
    const consent = vi.fn(async () => { throw new Error('dialog failed to open') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(requestInstallConsent(broker, consent, APP, manifestWith({ fs: {} }))).resolves.toBeUndefined()

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
    // A dialog that never actually asked anything must not be recorded as a
    // real "no" -- nobody made a choice, so nothing is remembered.
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  // A145: the remembered-no check itself, isolated from the "already held"
  // check above -- nothing is held, but the declared set is fully covered
  // by an earlier decline, so the dialog is suppressed and nothing new is
  // read from `declinedCapabilitiesFor` a second time.
  describe('the remembered-no check (A145)', () => {
    it('suppresses the dialog when the declared set exactly matches what was declined', async () => {
      const calls: BrokerCall[] = []
      const broker = stubBroker(calls, {
        grants: async () => [],
        declinedCapabilitiesFor: async () => ['tcp.connect']
      })
      const consent = vi.fn(async () => true)

      await requestInstallConsent(broker, consent, APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))

      expect(consent).not.toHaveBeenCalled()
      expect(calls.some((call) => call.method === 'grant')).toBe(false)
    })

    it('asks again when the manifest now declares MORE than was declined -- a different question', async () => {
      const calls: BrokerCall[] = []
      const broker = stubBroker(calls, {
        grants: async () => [],
        declinedCapabilitiesFor: async () => ['tcp.connect'],
        clearDeclinedConsent: async () => {},
        grant: async (origin, capability, patterns) => ({ id: 'g3', origin, capability, patterns, grantedAt: 0 })
      })
      const consent = vi.fn(async () => true)
      const widened = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

      await requestInstallConsent(broker, consent, APP, widened)

      expect(consent).toHaveBeenCalledOnce()
      expect(consent).toHaveBeenCalledWith(APP, widened, expect.arrayContaining(['tcp.connect', 'fs']))
    })

    it('stays suppressed when the manifest now declares LESS than was declined -- AI recommendation, retunable (A145)', async () => {
      const calls: BrokerCall[] = []
      const broker = stubBroker(calls, {
        grants: async () => [],
        declinedCapabilitiesFor: async () => ['tcp.connect', 'fs']
      })
      const consent = vi.fn(async () => true)
      const narrowed = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

      await requestInstallConsent(broker, consent, APP, narrowed)

      expect(consent).not.toHaveBeenCalled()
    })
  })
})

describe('requestInstallConsent (real broker) -- proves "once per origin, ever" against real hydration', () => {
  it('a second visit within the same broker instance is silent after acceptance', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    await broker.registerApp(APP, manifest)
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifest)
    expect(consent).toHaveBeenCalledOnce()

    await broker.registerApp(APP, manifest)
    await requestInstallConsent(broker, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
    const grants = await broker.app.grants(APP)
    expect(grants).toHaveLength(1)
  })

  it('a fresh process (a new broker sharing the same persisted ledger storage) is also silent after acceptance', async () => {
    const storage = memoryLedgerStorage()
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, manifest)
    const consent = vi.fn(async () => true)
    await requestInstallConsent(firstRun, consent, APP, manifest)
    expect(consent).toHaveBeenCalledOnce()

    // A brand-new Broker, the same shape a real restart constructs -- only
    // `storage` carries anything across the boundary.
    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, manifest)
    await requestInstallConsent(secondRun, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
    expect(await secondRun.app.grants(APP)).toHaveLength(1)
  })

  it('a declined visit leaves the app installed (registered) with every capability denied', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    await broker.registerApp(APP, manifest)
    const consent = vi.fn(async () => false)

    await requestInstallConsent(broker, consent, APP, manifest)

    expect(broker.app.isRegisteredSync(APP)).toBe(true)
    expect(await broker.app.grants(APP)).toEqual([])
  })

  // A145, now fixed: a declined visit IS remembered across a fresh broker
  // sharing the same persisted storage -- the exact restart this repo's own
  // install-consent tests already use to prove the accepted side (above).
  it('A145: a declined visit is remembered across a fresh broker -- the next visit does not ask again', async () => {
    const storage = memoryLedgerStorage()
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, manifest)
    const consent = vi.fn(async () => false)
    await requestInstallConsent(firstRun, consent, APP, manifest)
    expect(consent).toHaveBeenCalledOnce()

    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, manifest)
    await requestInstallConsent(secondRun, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
    expect(await secondRun.app.grants(APP)).toEqual([])
  })

  it('A145: a declined visit whose manifest later widens is asked again, for the whole new set', async () => {
    const storage = memoryLedgerStorage()
    const narrow = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const wide = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, narrow)
    const decline = vi.fn(async () => false)
    await requestInstallConsent(firstRun, decline, APP, narrow)
    expect(decline).toHaveBeenCalledOnce()

    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, wide)
    const accept = vi.fn(async () => true)
    await requestInstallConsent(secondRun, accept, APP, wide)

    expect(accept).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledWith(APP, wide, expect.arrayContaining(['tcp.connect', 'fs']))
    const grants = await secondRun.app.grants(APP)
    expect(grants.map((g) => g.capability).sort()).toEqual(['fs', 'tcp.connect'])
  })

  it('A145: a declined visit whose manifest later narrows is NOT asked again -- retunable design choice', async () => {
    const storage = memoryLedgerStorage()
    const wide = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    const narrow = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, wide)
    const decline = vi.fn(async () => false)
    await requestInstallConsent(firstRun, decline, APP, wide)
    expect(decline).toHaveBeenCalledOnce()

    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, narrow)
    const wouldAccept = vi.fn(async () => true)
    await requestInstallConsent(secondRun, wouldAccept, APP, narrow)

    expect(wouldAccept).not.toHaveBeenCalled()
    expect(await secondRun.app.grants(APP)).toEqual([])
  })

  it('accepting after an earlier decline clears the remembered no, so a later narrower visit is not affected by stale state', async () => {
    const storage = memoryLedgerStorage()
    const narrow = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })
    const wide = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

    const run1 = createBroker(baseDeps({ ledgerStorage: storage }))
    await run1.registerApp(APP, narrow)
    await requestInstallConsent(run1, async () => false, APP, narrow) // declines tcp.connect only

    const run2 = createBroker(baseDeps({ ledgerStorage: storage }))
    await run2.registerApp(APP, wide)
    await requestInstallConsent(run2, async () => true, APP, wide) // widens, asked again, accepts everything

    expect(await run2.declinedCapabilitiesFor(APP)).toBeUndefined()
    expect((await run2.app.grants(APP)).map((g) => g.capability).sort()).toEqual(['fs', 'tcp.connect'])
  })

  // THE ADVERSARIAL TEST: a remembered "no" must never become, or imply, a
  // grant -- through any path this flow exposes. `consent` here is wired to
  // ALWAYS accept if it is ever called again, which is exactly the trap a
  // broken suppression check would fall into: if the "already answered"
  // check ever mis-fired as "already granted" instead of "still refused",
  // or if it failed to suppress and re-asked, this test would catch either
  // failure by observing a live grant appear. It does not, across three
  // separate simulated restarts, all sharing one persisted store.
  it('a remembered decline never results in a live grant, across repeated restarts, even when the prompt would always say yes if asked', async () => {
    const storage = memoryLedgerStorage()
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    const wouldAlwaysAccept = vi.fn(async () => true)

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, manifest)
    await requestInstallConsent(firstRun, async () => false, APP, manifest) // the one real decline
    expect(await firstRun.app.grants(APP)).toEqual([])

    for (let restart = 0; restart < 3; restart++) {
      const broker = createBroker(baseDeps({ ledgerStorage: storage }))
      await broker.registerApp(APP, manifest)
      await requestInstallConsent(broker, wouldAlwaysAccept, APP, manifest)

      // The trap: never actually invoked, because the same-or-narrower
      // question stays suppressed -- and, structurally, grants() stays
      // empty regardless of what the prompt would have answered.
      expect(wouldAlwaysAccept).not.toHaveBeenCalled()
      expect(await broker.app.grants(APP)).toEqual([])
      expect(broker.app.isRegisteredSync(APP)).toBe(true)
    }

    // And the decline record itself never surfaces as anything a caller
    // could mistake for a grant -- it is a plain capability-name list, not
    // a Grant, and it stays exactly what was declined.
    expect(await firstRun.declinedCapabilitiesFor(APP)).toEqual(expect.arrayContaining(['tcp.connect', 'fs']))
  })
})
