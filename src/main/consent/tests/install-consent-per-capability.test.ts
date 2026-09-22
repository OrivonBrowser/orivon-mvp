import { describe, expect, it, vi } from 'vitest'
import { requestInstallConsent } from '../install-consent.js'
import type { PerCapabilityConsentPrompt } from '../install-consent.js'
import { APP, stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../../broker/transport/tests/ipc.test-helpers.js'
import { manifestWith, baseDeps, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
import { createBroker } from '../../../broker/index.js'
import type { CapabilityKind, Grant, Manifest } from '../../../contracts/index.js'

// A138's 'per-capability' path (docs/open-questions.md): a manifest may
// declare `consentGranularity: 'per-capability'`, letting a person accept
// some of what it asks for and refuse the rest -- unlike 'all-or-nothing'
// (install-consent.test.ts's whole suite), where the answer is a single
// boolean covering everything at once. Constraints that are NOT this file's
// to relax, each proven below rather than assumed: every grant still goes
// through decideGrantRequest (via grantChangedCapabilities), a refusal of
// one capability never refuses the app, and the app is never handed more
// than its manifest declared even if the prompt itself misbehaves.

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

function perCapabilityManifest (): Manifest {
  return {
    ...manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 }, id: {} }),
    consentGranularity: 'per-capability'
  }
}

function grantsOf (calls: BrokerCall[]): CapabilityKind[] {
  return calls
    .filter((call) => call.method === 'grant')
    .map((call) => (call.args as { capability: CapabilityKind }).capability)
}

describe('requestInstallConsent -- per-capability path (stubbed broker)', () => {
  it('asks the per-capability prompt, not the all-or-nothing one, when the manifest declares per-capability and both are wired', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = perCapabilityManifest()
    const consent = vi.fn(async () => true)
    const perCapabilityConsent: PerCapabilityConsentPrompt = vi.fn(async (_o, _m, capabilities) => capabilities)

    await requestInstallConsent(broker, consent, APP, manifest, perCapabilityConsent)

    expect(perCapabilityConsent).toHaveBeenCalledOnce()
    expect(consent).not.toHaveBeenCalled()
  })

  it('grants exactly the accepted subset and records exactly the refused subset -- a refusal of one capability is never a refusal of the app', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = perCapabilityManifest()
    // Accepts tcp.connect and id, refuses fs.
    const perCapabilityConsent: PerCapabilityConsentPrompt = async (_o, _m, capabilities) =>
      capabilities.filter((c) => c !== 'fs')

    await requestInstallConsent(broker, async () => true, APP, manifest, perCapabilityConsent)

    expect(grantsOf(calls).sort()).toEqual(['id', 'tcp.connect'])
    expect(calls).toContainEqual({ method: 'recordDeclinedConsent', origin: APP, args: ['fs'] })
  })

  it('accepting nothing still leaves the app installed -- app-install.ts is never told about this decision at all', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {}
    })
    const manifest = perCapabilityManifest()
    const perCapabilityConsent: PerCapabilityConsentPrompt = async () => []

    await expect(requestInstallConsent(broker, async () => true, APP, manifest, perCapabilityConsent)).resolves.toBeUndefined()

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
    expect(calls).toContainEqual({ method: 'recordDeclinedConsent', origin: APP, args: expect.arrayContaining(['tcp.connect', 'fs', 'id']) })
  })

  it('accepting everything records nothing as declined', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = perCapabilityManifest()
    const perCapabilityConsent: PerCapabilityConsentPrompt = async (_o, _m, capabilities) => capabilities

    await requestInstallConsent(broker, async () => true, APP, manifest, perCapabilityConsent)

    expect(grantsOf(calls).sort()).toEqual(['fs', 'id', 'tcp.connect'])
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('is only ever asked about what is still OUTSTANDING -- a capability already held is not re-asked, even though the whole-set prompt would have named it', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [grant({ capability: 'tcp.connect' })],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g2', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = perCapabilityManifest()
    const perCapabilityConsent = vi.fn(async (_o: string, _m: Manifest, capabilities: readonly CapabilityKind[]) => capabilities)

    await requestInstallConsent(broker, async () => true, APP, manifest, perCapabilityConsent)

    expect(perCapabilityConsent).toHaveBeenCalledWith(APP, manifest, expect.arrayContaining(['fs', 'id']))
    const [, , askedCapabilities] = perCapabilityConsent.mock.calls[0] as [string, Manifest, readonly CapabilityKind[]]
    expect(askedCapabilities).not.toContain('tcp.connect')
    // Already held with the manifest's own exact pattern -- must not be
    // re-granted (same hazard grant-changed-capabilities.ts documents).
    expect(calls.some((call) => call.method === 'grant' && (call.args as { capability: string }).capability === 'tcp.connect')).toBe(false)
  })

  it('never grants a capability the prompt returned but was never asked about -- a misbehaving prompt cannot widen the grant', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      recordDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    // Declares only fs as per-capability, but the (misbehaving) prompt
    // claims tcp.connect was accepted too -- something it was never handed.
    const manifest: Manifest = { ...manifestWith({ fs: { quotaBytes: 1024 } }), consentGranularity: 'per-capability' }
    const perCapabilityConsent: PerCapabilityConsentPrompt = async () => ['fs', 'tcp.connect']

    await requestInstallConsent(broker, async () => true, APP, manifest, perCapabilityConsent)

    expect(grantsOf(calls)).toEqual(['fs'])
  })

  it('treats a throwing per-capability prompt as "nothing decided this visit", never as a recorded decline', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [], declinedCapabilitiesFor: async () => undefined })
    const manifest = perCapabilityManifest()
    const perCapabilityConsent: PerCapabilityConsentPrompt = async () => { throw new Error('dialog failed to open') }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(requestInstallConsent(broker, async () => true, APP, manifest, perCapabilityConsent)).resolves.toBeUndefined()
    consoleError.mockRestore()

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('falls back to the all-or-nothing prompt when the manifest declares per-capability but no per-capability prompt is wired', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      grants: async () => [],
      declinedCapabilitiesFor: async () => undefined,
      clearDeclinedConsent: async () => {},
      grant: async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })
    })
    const manifest = perCapabilityManifest()
    const consent = vi.fn(async () => true)

    await requestInstallConsent(broker, consent, APP, manifest)

    expect(consent).toHaveBeenCalledOnce()
  })
})

describe('requestInstallConsent -- per-capability path (real broker, across a restart)', () => {
  it('a partial accept is remembered: the refused capability is asked again on a fresh manifest widening, the accepted one never is', async () => {
    const storage = memoryLedgerStorage()
    const manifest = perCapabilityManifest()

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, manifest)
    const firstChoice: PerCapabilityConsentPrompt = async (_o, _m, capabilities) => capabilities.filter((c) => c !== 'fs')
    await requestInstallConsent(firstRun, async () => true, APP, manifest, firstChoice)
    expect((await firstRun.app.grants(APP)).map((g) => g.capability).sort()).toEqual(['id', 'tcp.connect'])

    // A fresh process, same persisted ledger -- the real "once, ever" test.
    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, manifest)
    const secondChoice = vi.fn(async (_o: string, _m: Manifest, capabilities: readonly CapabilityKind[]) => capabilities)
    await requestInstallConsent(secondRun, async () => true, APP, manifest, secondChoice)

    // Nothing outstanding -- tcp.connect/id are held, fs was declined --
    // so the prompt is never even shown again.
    expect(secondChoice).not.toHaveBeenCalled()
    expect((await secondRun.app.grants(APP)).map((g) => g.capability).sort()).toEqual(['id', 'tcp.connect'])
  })

  it('a manifest that later widens is asked again, but ONLY about the new capability -- not the ones already held or declined', async () => {
    const storage = memoryLedgerStorage()
    const narrow: Manifest = { ...manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } }), consentGranularity: 'per-capability' }
    const wide: Manifest = { ...manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 }, id: {} }), consentGranularity: 'per-capability' }

    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await firstRun.registerApp(APP, narrow)
    const firstChoice: PerCapabilityConsentPrompt = async (_o, _m, capabilities) => capabilities.filter((c) => c !== 'fs')
    await requestInstallConsent(firstRun, async () => true, APP, narrow, firstChoice)

    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, wide)
    const secondChoice = vi.fn(async (_o: string, _m: Manifest, capabilities: readonly CapabilityKind[]) => capabilities)
    await requestInstallConsent(secondRun, async () => true, APP, wide, secondChoice)

    expect(secondChoice).toHaveBeenCalledWith(APP, wide, ['id'])
    expect((await secondRun.app.grants(APP)).map((g) => g.capability).sort()).toEqual(['id', 'tcp.connect'])
  })
})
