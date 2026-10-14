import { describe, expect, it, vi } from 'vitest'
import { grantNone } from './install-consent.test-helpers.js'
import type { InstallConsentPrompt } from '../install-consent.js'
import { applyInstallConsent, askInstallConsent } from '../install-consent-ask.js'
import { requestInstallConsent } from '../install-consent.js'
import { APP, stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../../broker/transport/tests/ipc.test-helpers.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// Only a capability the panel can show as a row can be asked about, and so refused: the panel's Close would
// otherwise record a "no" the person never saw.

vi.mock('../capability-row.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../capability-row.js')>()
  return { ...original, offerCapability: (...args: Parameters<typeof original.offerCapability>) => (args[1] === 'tcp.connect' ? undefined : original.offerCapability(...args)) }
})

const MANIFEST = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })
const ONLY_HIDDEN = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

function broker (calls: BrokerCall[] = []): ReturnType<typeof stubBroker> {
  return stubBroker(calls, {
    grants: async () => [],
    declinedCapabilitiesFor: async () => undefined,
    clearDeclinedConsent: async () => {},
    recordDeclinedConsent: async () => {},
    grant: async (origin, capability, patterns) => ({ id: 'g', origin, capability, patterns, grantedAt: 0 })
  })
}

describe('the first-visit question asks about the rows it can show', () => {
  it('asks only about offered capabilities, and records nothing for one it never showed', async () => {
    const calls: BrokerCall[] = []
    const consent = vi.fn<InstallConsentPrompt>(async () => [])
    expect(await requestInstallConsent(broker(calls), consent, APP, MANIFEST)).toBe('declined')
    expect(consent).toHaveBeenCalledWith(APP, MANIFEST, ['fs'])
    expect(calls).toContainEqual({ method: 'recordDeclinedConsent', origin: APP, args: ['fs'] })
    expect(calls.some((call) => call.method === 'recordDeclinedConsent' && (call.args as readonly string[]).includes('tcp.connect'))).toBe(false)
  })

  it('asks nothing when no declared capability has a row, on both doors', async () => {
    const consent = vi.fn(grantNone)
    const calls: BrokerCall[] = []
    expect(await requestInstallConsent(broker(calls), consent, APP, ONLY_HIDDEN)).toBe('not-asked')
    expect(await askInstallConsent(broker(calls), consent, APP, ONLY_HIDDEN)).toEqual({ outcome: 'not-asked' })
    expect(consent).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })

  it('the first-visit door asks about the offered rows only and names only those as refused', async () => {
    const consent = vi.fn<InstallConsentPrompt>(async (_origin, _manifest, capabilities) => capabilities)
    expect(await askInstallConsent(broker(), consent, APP, MANIFEST)).toEqual({ outcome: 'accepted', capabilities: ['fs'], refused: [] })
    expect(consent).toHaveBeenCalledWith(APP, MANIFEST, ['fs'])
    const calls: BrokerCall[] = []
    await applyInstallConsent(broker(calls), APP, MANIFEST, { outcome: 'accepted', capabilities: ['fs'], refused: [] })
    expect(calls.some((call) => call.method === 'recordDeclinedConsent')).toBe(false)
  })
})
