import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { APP, baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import { requestInstallConsent } from '../../consent/install-consent.js'
import { requestGrant } from '../../consent/request-grant.js'
import { createPermissionsController } from '../permissions.js'
import type { SubsystemContext } from '../../registry.js'

// An app's camera, microphone and screen grants (ADR-0032, ADR-0055) go through the same install consent, the same
// Settings rows and the same revoke as every other capability.

const MANIFEST = manifestWith({ media: { camera: true, microphone: true, screen: true } })

function ctxWith (broker: Broker): SubsystemContext {
  return { broker } as unknown as SubsystemContext
}

async function installedAndAccepted (): Promise<Broker> {
  const broker = createBroker(baseDeps())
  await broker.registerApp(APP, MANIFEST)
  await requestInstallConsent(broker, async () => true, APP, MANIFEST)
  return broker
}

describe('an app declaring media', () => {
  it('is asked about all three at install, and holds all three once the person accepts', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, MANIFEST)
    const asked: Array<readonly string[]> = []
    await requestInstallConsent(broker, async (_origin, _manifest, capabilities) => { asked.push(capabilities); return true }, APP, MANIFEST)
    expect(asked).toEqual([['media.camera', 'media.microphone', 'media.screen']])
    for (const kind of ['media.camera', 'media.microphone', 'media.screen'] as const) expect(broker.app.heldSync(APP, kind)).toBe(true)
  })

  it('shows one Settings row per kind, in words', async () => {
    const broker = await installedAndAccepted()
    const rows = (await createPermissionsController(ctxWith(broker)).forUrl(APP))?.rows ?? []
    expect(rows.map((row) => row.message).sort()).toEqual([
      'Ask to share your screen, a window or a tab; you choose each time',
      'Use your camera',
      'Use your microphone'
    ])
  })

  it('refuses the next request once the camera is revoked, without asking again, and leaves the others', async () => {
    const broker = await installedAndAccepted()
    await createPermissionsController(ctxWith(broker)).revokeCapability(APP, 'media.camera')
    expect(broker.app.heldSync(APP, 'media.camera')).toBe(false)
    expect(broker.app.heldSync(APP, 'media.microphone')).toBe(true)
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['media.camera'])

    const consent = vi.fn(async () => true)
    expect(await requestGrant(broker, consent, APP, { capability: 'media.camera' })).toBe(false)
    expect(consent).not.toHaveBeenCalled()
  })

  it('does not ask again at the next launch for what the person revoked', async () => {
    const broker = await installedAndAccepted()
    await createPermissionsController(ctxWith(broker)).revokeCapability(APP, 'media.screen')
    const consent = vi.fn(async () => true)
    await requestInstallConsent(broker, consent, APP, MANIFEST)
    expect(consent).not.toHaveBeenCalled()
  })

  it('is asked when it requests a declared kind at run time, and never for an undeclared one', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ media: { camera: true } })
    await broker.registerApp(APP, manifest)
    const consent = vi.fn(async () => true)
    expect(await requestGrant(broker, consent, APP, { capability: 'media.microphone' })).toBe(false)
    expect(consent).not.toHaveBeenCalled()
    expect(await requestGrant(broker, consent, APP, { capability: 'media.camera' })).toBe(true)
    expect(consent).toHaveBeenCalledOnce()
    expect(broker.app.heldSync(APP, 'media.camera')).toBe(true)
  })
})
