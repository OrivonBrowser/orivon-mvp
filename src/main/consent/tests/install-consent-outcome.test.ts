import { describe, expect, it, vi } from 'vitest'
import { requestInstallConsent } from '../install-consent.js'
import type { DialogCaller } from '../request-grant.js'
import { APP, stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// What the question came to, as a first visit needs it: whether to go on with the download, to open the
// site as a plain website, or to stop because nobody was there to answer.

const MANIFEST = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

function broker (held: readonly string[] = [], declined: readonly string[] | undefined = undefined): ReturnType<typeof stubBroker> {
  return stubBroker([], {
    grants: async () => held.map((capability) => ({ id: capability, origin: APP, capability: capability as 'fs', patterns: [], grantedAt: 0 })),
    declinedCapabilitiesFor: async () => declined as undefined,
    clearDeclinedConsent: async () => {},
    recordDeclinedConsent: async () => {},
    grant: async (origin, capability, patterns) => ({ id: 'g', origin, capability, patterns, grantedAt: 0 })
  })
}

const present: DialogCaller = { window: () => undefined, stillOn: () => true }
const gone: DialogCaller = { window: () => undefined, stillOn: () => false }

describe('requestInstallConsent: the outcome', () => {
  it('is granted when the person allows', async () => {
    expect(await requestInstallConsent(broker(), async () => true, APP, MANIFEST)).toBe('granted')
  })

  it('is declined when the person denies', async () => {
    expect(await requestInstallConsent(broker(), async () => false, APP, MANIFEST)).toBe('declined')
  })

  it('is not-asked for a manifest that declares nothing, with no prompt shown', async () => {
    const consent = vi.fn(async () => true)
    expect(await requestInstallConsent(broker(), consent, APP, manifestWith({}))).toBe('not-asked')
    expect(consent).not.toHaveBeenCalled()
  })

  it('is not-asked when everything declared is already held', async () => {
    expect(await requestInstallConsent(broker(['tcp.connect', 'fs']), async () => false, APP, MANIFEST)).toBe('not-asked')
  })

  it('is declined, with no prompt shown, when the question was already answered no', async () => {
    const consent = vi.fn(async () => true)
    expect(await requestInstallConsent(broker([], ['tcp.connect', 'fs']), consent, APP, MANIFEST)).toBe('declined')
    expect(consent).not.toHaveBeenCalled()
  })

  it('is left when the tab moved on before it was answered, and records nothing', async () => {
    const recorded = vi.fn(async () => {})
    const b = stubBroker([], { grants: async () => [], declinedCapabilitiesFor: async () => undefined, recordDeclinedConsent: recorded, clearDeclinedConsent: async () => {} })
    expect(await requestInstallConsent(b, async () => false, APP, MANIFEST, undefined, gone)).toBe('left')
    expect(recorded).not.toHaveBeenCalled()
    expect(await requestInstallConsent(broker(), async () => true, APP, MANIFEST, undefined, present)).toBe('granted')
  })

  it('is left when the prompt itself failed', async () => {
    expect(await requestInstallConsent(broker(), async () => { throw new Error('no window') }, APP, MANIFEST)).toBe('left')
  })

  it('is not-asked, failing closed, when no prompt is wired', async () => {
    expect(await requestInstallConsent(broker(), undefined, APP, MANIFEST)).toBe('not-asked')
  })

  it('per capability: granted when any is accepted, declined when none is, left when nobody answered', async () => {
    const per = (accepted: readonly string[]) => async () => accepted as never
    const perManifest = { ...MANIFEST, consentGranularity: 'per-capability' as const }
    expect(await requestInstallConsent(broker(), undefined, APP, perManifest, per(['fs']))).toBe('granted')
    expect(await requestInstallConsent(broker(), undefined, APP, perManifest, per([]))).toBe('declined')
    expect(await requestInstallConsent(broker(), undefined, APP, perManifest, per(['fs']), gone)).toBe('left')
    expect(await requestInstallConsent(broker(), undefined, APP, perManifest, async () => { throw new Error('x') })).toBe('left')
  })
})
