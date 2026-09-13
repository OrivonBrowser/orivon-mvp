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
// the real hydration mechanism (GrantLedger.registerApp's grantsHydrated),
// not just a mocked grants() call.

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
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
    expect(consent).toHaveBeenCalledWith(APP, manifest, expect.arrayContaining(['tcp.connect', 'fs']))
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'fs', patterns: [] } })
  })

  it('does not prompt again when the origin already holds a live grant for a declared capability', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [grant()] })
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    expect(consent).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('prompts, and grants nothing, when the person declines -- the app stays installed either way', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const consent = vi.fn(async () => false)

    await requestInstallConsent(broker, consent, APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    expect(consent).toHaveBeenCalledOnce()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('fails closed -- grants nothing and never throws -- when no consent prompt is wired', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })

    await expect(requestInstallConsent(broker, undefined, APP, manifestWith({ fs: {} }))).resolves.toBeUndefined()

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('treats a throwing consent prompt as a decline rather than propagating', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const consent = vi.fn(async () => { throw new Error('dialog failed to open') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(requestInstallConsent(broker, consent, APP, manifestWith({ fs: {} }))).resolves.toBeUndefined()

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
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

  // A145 (docs/open-questions.md): known limitation. Nothing on disk
  // distinguishes "asked, and declined" from "never asked" -- a declined
  // origin is asked again on its next visit, unlike an accepted one.
  it('A145: a declined visit is NOT remembered across a fresh broker -- the next visit asks again', async () => {
    const storage = memoryLedgerStorage()
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, manifest)
    const consent = vi.fn(async () => false)
    await requestInstallConsent(firstRun, consent, APP, manifest)

    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, manifest)
    await requestInstallConsent(secondRun, consent, APP, manifest)

    expect(consent).toHaveBeenCalledTimes(2)
  })
})
