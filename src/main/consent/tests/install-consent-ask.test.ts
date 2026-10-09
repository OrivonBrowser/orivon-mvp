import { describe, expect, it, vi } from 'vitest'
import { applyInstallConsent, askInstallConsent } from '../install-consent-ask.js'
import type { DialogCaller } from '../request-grant.js'
import { APP, stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../../broker/transport/tests/ipc.test-helpers.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// The first visit's two halves of the install question (ADR-0074): asking decides and records nothing,
// applying grants only once the files are checked, and only an explicit Deny is a no.

const MANIFEST = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
const PER_CAPABILITY = { ...MANIFEST, consentGranularity: 'per-capability' as const }
const present: DialogCaller = { window: () => undefined, stillOn: () => true }
const gone: DialogCaller = { window: () => undefined, stillOn: () => false }

function broker (calls: BrokerCall[] = [], held: readonly string[] = [], declined: readonly string[] | undefined = undefined): ReturnType<typeof stubBroker> {
  return stubBroker(calls, {
    grants: async () => held.map((capability) => ({ id: capability, origin: APP, capability: capability as 'fs', patterns: [], grantedAt: 0 })),
    declinedCapabilitiesFor: async () => declined as undefined,
    clearDeclinedConsent: async () => {},
    recordDeclinedConsent: async () => {},
    grant: async (origin, capability, patterns) => ({ id: 'g', origin, capability, patterns, grantedAt: 0 })
  })
}

describe('askInstallConsent', () => {
  it('accepts the whole declared set on Allow, and touches no grant', async () => {
    const calls: BrokerCall[] = []
    const ask = await askInstallConsent(broker(calls), async () => true, APP, MANIFEST)
    expect(ask).toEqual({ outcome: 'accepted', capabilities: expect.arrayContaining(['tcp.connect', 'fs']), refused: [] })
    expect(calls.filter((call) => call.method === 'grant' || call.method === 'recordDeclinedConsent' || call.method === 'clearDeclinedConsent')).toEqual([])
  })

  it('is denied only for the Deny button, and records nothing', async () => {
    const calls: BrokerCall[] = []
    expect(await askInstallConsent(broker(calls), async () => false, APP, MANIFEST)).toEqual({ outcome: 'denied' })
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('is left for Escape, a closed tab, a navigation, a prompt that failed, or a tab that moved on', async () => {
    expect(await askInstallConsent(broker(), async () => 'dismissed', APP, MANIFEST)).toEqual({ outcome: 'left' })
    expect(await askInstallConsent(broker(), async () => { throw new Error('no window') }, APP, MANIFEST)).toEqual({ outcome: 'left' })
    expect(await askInstallConsent(broker(), async () => true, APP, MANIFEST, undefined, gone)).toEqual({ outcome: 'left' })
    expect(await askInstallConsent(broker(), async () => true, APP, MANIFEST, undefined, present)).toMatchObject({ outcome: 'accepted' })
  })

  it('asks nothing of a manifest that declares nothing, or whose declared set is all held, or when no prompt is wired', async () => {
    const consent = vi.fn(async () => true)
    expect(await askInstallConsent(broker(), consent, APP, manifestWith({}))).toEqual({ outcome: 'not-asked' })
    expect(await askInstallConsent(broker([], ['tcp.connect', 'fs']), consent, APP, MANIFEST)).toEqual({ outcome: 'not-asked' })
    expect(await askInstallConsent(broker(), undefined, APP, MANIFEST)).toEqual({ outcome: 'not-asked' })
    expect(consent).not.toHaveBeenCalled()
  })

  it('does not ask again about a capability an earlier question already refused one by one', async () => {
    const consent = vi.fn(async () => true)
    expect(await askInstallConsent(broker([], [], ['tcp.connect', 'fs']), consent, APP, MANIFEST)).toEqual({ outcome: 'not-asked' })
    expect(consent).not.toHaveBeenCalled()
  })

  it('per capability: accepts the subset, and names what was refused', async () => {
    const ask = await askInstallConsent(broker(), undefined, APP, PER_CAPABILITY, async () => ['fs'])
    expect(ask).toEqual({ outcome: 'accepted', capabilities: ['fs'], refused: ['tcp.connect'] })
  })

  it('per capability: is denied when none is accepted, and left when the questions were dismissed', async () => {
    expect(await askInstallConsent(broker(), undefined, APP, PER_CAPABILITY, async () => [])).toEqual({ outcome: 'denied' })
    expect(await askInstallConsent(broker(), undefined, APP, PER_CAPABILITY, async () => null)).toEqual({ outcome: 'left' })
    expect(await askInstallConsent(broker(), undefined, APP, PER_CAPABILITY, async () => ['fs'], gone)).toEqual({ outcome: 'left' })
    expect(await askInstallConsent(broker(), undefined, APP, PER_CAPABILITY, async () => { throw new Error('x') })).toEqual({ outcome: 'left' })
  })

  it('per capability: never accepts what it did not ask about', async () => {
    const ask = await askInstallConsent(broker([], ['fs']), undefined, APP, PER_CAPABILITY, async () => ['fs', 'tcp.connect', 'id'] as never)
    expect(ask).toEqual({ outcome: 'accepted', capabilities: ['tcp.connect'], refused: [] })
  })
})

describe('applyInstallConsent', () => {
  it('grants each accepted capability, bounded by the manifest, after clearing an old decline', async () => {
    const calls: BrokerCall[] = []
    await applyInstallConsent(broker(calls), APP, MANIFEST, { outcome: 'accepted', capabilities: ['tcp.connect', 'fs'], refused: [] })
    const granted = calls.filter((call) => call.method === 'grant').map((call) => (call.args as { capability: string }).capability)
    expect(granted.sort()).toEqual(['fs', 'tcp.connect'])
    expect(calls.findIndex((call) => call.method === 'clearDeclinedConsent')).toBeLessThan(calls.findIndex((call) => call.method === 'grant'))
  })

  it('records the capabilities refused one by one, as the old question did, and grants only the rest', async () => {
    const calls: BrokerCall[] = []
    await applyInstallConsent(broker(calls), APP, PER_CAPABILITY, { outcome: 'accepted', capabilities: ['fs'], refused: ['tcp.connect'] })
    expect(calls).toContainEqual({ method: 'recordDeclinedConsent', origin: APP, args: ['tcp.connect'] })
    expect(calls.filter((call) => call.method === 'grant')).toHaveLength(1)
  })

  it('does nothing for an answer that granted nothing', async () => {
    const calls: BrokerCall[] = []
    await applyInstallConsent(broker(calls), APP, MANIFEST, { outcome: 'denied' })
    await applyInstallConsent(broker(calls), APP, MANIFEST, { outcome: 'not-asked' })
    expect(calls).toEqual([])
  })
})
