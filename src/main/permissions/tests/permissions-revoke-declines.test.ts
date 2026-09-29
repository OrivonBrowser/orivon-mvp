import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import { requestInstallConsent } from '../../consent/install-consent.js'
import { requestGrant } from '../../consent/request-grant.js'
import { createPermissionsController } from '../permissions.js'
import type { SubsystemContext } from '../../registry.js'

// A revoke in the permissions panel is the person saying no to that
// capability, so the install-consent dialog, which runs again on every
// launch's first visit, must not ask for it again. F2/decision 10: nor may
// the app get a SECOND dialog out of it by calling app.requestGrant itself
// -- a declined capability resolves false with no prompt, from either door,
// until the site-info popover's own "turn on" switch (site-switches.ts)
// clears the decline DIRECTLY, with no page involved at all.

function ctxWith (broker: Broker): SubsystemContext {
  return { broker } as unknown as SubsystemContext
}

const MANIFEST = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } })

async function installedAndAccepted (broker: Broker): Promise<void> {
  await broker.registerApp(APP, MANIFEST)
  await requestInstallConsent(broker, async () => true, APP, MANIFEST)
}

describe('revoking from the permissions panel', () => {
  it('records the capability as declined, so the next launch\'s install consent does not ask again', async () => {
    const storage = memoryLedgerStorage()
    const firstRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await installedAndAccepted(firstRun)
    const fs = (await firstRun.app.grants(APP)).find((grant) => grant.capability === 'fs')!

    await createPermissionsController(ctxWith(firstRun)).revoke(APP, fs.id)
    expect(await firstRun.declinedCapabilitiesFor(APP)).toEqual(['fs'])

    const secondRun = createBroker(baseDeps({ ledgerStorage: storage }))
    await secondRun.registerApp(APP, MANIFEST)
    const consent = vi.fn(async () => true)
    await requestInstallConsent(secondRun, consent, APP, MANIFEST)

    expect(consent).not.toHaveBeenCalled()
    expect((await secondRun.app.grants(APP)).map((grant) => grant.capability)).toEqual(['tcp.connect'])
  })

  it('does the same through the capability-addressed revoke a not-loaded app\'s row uses', async () => {
    const broker = createBroker(baseDeps())
    await installedAndAccepted(broker)

    await createPermissionsController(ctxWith(broker)).revokeCapability(APP, 'tcp.connect')

    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('adds to what was already declined, once per capability', async () => {
    const broker = createBroker(baseDeps())
    await installedAndAccepted(broker)
    await broker.recordDeclinedConsent(APP, ['id'])
    const controller = createPermissionsController(ctxWith(broker))

    await controller.revokeCapability(APP, 'fs')
    await controller.revokeCapability(APP, 'fs')

    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['id', 'fs'])
  })

  it('records nothing for a grant id the app does not hold', async () => {
    const broker = createBroker(baseDeps())
    await installedAndAccepted(broker)

    await createPermissionsController(ctxWith(broker)).revoke(APP, 'not-a-grant')

    expect(await broker.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  // F2/decision 10: a page cannot turn a revoked capability back on by
  // calling app.requestGrant itself, however willing `consent` here would
  // be to say yes -- requestGrant never even reaches it. Re-granting after
  // a revoke is the site-info popover's own direct path
  // (site-switches.ts's turnOn, tested in its own suite), never this one.
  it('does not re-prompt through app.requestGrant after a revoke -- that door is shut until the site-info popover clears it directly', async () => {
    const broker = createBroker(baseDeps())
    await installedAndAccepted(broker)
    await createPermissionsController(ctxWith(broker)).revokeCapability(APP, 'fs')

    const consent = vi.fn(async () => true)
    const granted = await requestGrant(broker, consent, APP, { capability: 'fs' })

    expect(granted).toBe(false)
    expect(consent).not.toHaveBeenCalled()
    expect((await broker.app.grants(APP)).map((grant) => grant.capability).sort()).toEqual(['tcp.connect'])
    expect(await broker.declinedCapabilitiesFor(APP)).toEqual(['fs']) // still declined -- nothing retired it
  })
})
