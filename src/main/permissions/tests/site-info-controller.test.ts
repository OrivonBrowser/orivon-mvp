import { describe, expect, it } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { APP, baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { Loader, LoadResult } from '../../../loader/index.js'
import type { SubsystemContext } from '../../registry.js'
import { createSiteInfoController } from '../site-info-controller.js'
import type { SiteTrustSources } from '../site-info-controller.js'

const OTHER = 'https://not-a-real-origin.invalid'

function ctxWith (broker: Broker | undefined, loader?: Loader): SubsystemContext {
  return { broker, loader } as unknown as SubsystemContext
}

const NO_TRUST: SiteTrustSources = { isOriginServedFromCacheSync: () => false, pinCoverageFor: () => undefined }

function fakeLoader (overrides: Partial<Loader> = {}): Loader {
  return {
    load: async (): Promise<LoadResult> => ({ outcome: 'rejected', reason: 'unused' }),
    installFetched: async () => { throw new Error('not stubbed') },
    reconsider: async () => { throw new Error('not stubbed') },
    pinFor: async () => null,
    ddocFor: async () => undefined,
    ...overrides
  }
}

describe('createSiteInfoController -- siteInfoFor / siteSummaryFor', () => {
  it('an ordinary, never-registered origin reports nothing asked', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)

    const info = await controller.siteInfoFor(OTHER)

    expect(info.asked).toBe(false)
    expect(info.capabilityRows).toEqual([])
  })

  it('a malformed url also reports nothing asked, rather than throwing', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)
    const summary = await controller.siteSummaryFor('not a url at all')
    expect(summary).toEqual({ asked: false, warning: false })
  })

  it('a registered app with a declared, not-yet-held capability reports asked, not warning', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    const summary = await controller.siteSummaryFor(APP)

    expect(summary).toEqual({ asked: true, warning: false })
  })

  it('an unlimited grant reports warning', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    await broker.grant(APP, 'tcp.connect', ['*:*'])
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    const summary = await controller.siteSummaryFor(APP)

    expect(summary.warning).toBe(true)
  })

  it('with no broker published yet, reports nothing asked rather than throwing', async () => {
    const controller = createSiteInfoController(ctxWith(undefined), NO_TRUST)
    expect(await controller.siteSummaryFor(APP)).toEqual({ asked: false, warning: false })
  })
})

describe('createSiteInfoController -- turnOn / turnOff', () => {
  it('turnOff revokes and the next siteInfoFor no longer shows the capability as held', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    await controller.turnOff(APP, 'fs')

    const info = await controller.siteInfoFor(APP)
    expect(info.capabilityRows).toEqual([{ capability: 'fs', on: false, canTurnOn: true, warning: false, message: 'Store files in a private folder for this app on this device', patterns: [] }])
  })

  it('turnOn grants, and the next siteInfoFor shows the capability as held', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    const result = await controller.turnOn(APP, 'fs', [])

    expect(result).toBe('ok')
    const info = await controller.siteInfoFor(APP)
    expect(info.capabilityRows[0]?.on).toBe(true)
  })

  it('turnOn with no broker published resolves not-registered rather than throwing', async () => {
    const controller = createSiteInfoController(ctxWith(undefined), NO_TRUST)
    expect(await controller.turnOn(APP, 'fs', [])).toBe('not-registered')
  })
})

describe('createSiteInfoController -- siteTrustFor', () => {
  it('reads the pin through the loader and the cache/coverage facts through the injected sources', async () => {
    const loader = fakeLoader({ pinFor: async () => ({ schema: 1, origin: APP, bundleHash: 'a'.repeat(64), assets: [], version: '3.0.0', pinnedAt: 10 }) })
    const trustSources: SiteTrustSources = {
      isOriginServedFromCacheSync: (origin) => origin === APP,
      pinCoverageFor: () => ({ pinnedRequests: 1, thirdPartyRequests: 0, deniedRequests: 0, pinnedBytes: 5, thirdPartyBytes: 0, bytesIncomplete: false })
    }
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), loader), trustSources)

    const trust = await controller.siteTrustFor(APP)

    expect(trust?.connection).toBe('cached')
    expect(trust?.pin).toEqual({ bundleHash: 'a'.repeat(64), version: '3.0.0', pinnedAt: 10 })
    expect(trust?.delivery.evidence.pinCoverage?.pinnedRequests).toBe(1)
  })

  it('null with no loader published yet', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)
    expect(await controller.siteTrustFor(APP)).toBeNull()
  })

  it('null for a malformed url', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), NO_TRUST)
    expect(await controller.siteTrustFor('not a url')).toBeNull()
  })
})

describe('createSiteInfoController -- storageDeclarationFor', () => {
  it('the declared fs quota and the pinned version, for a registered app', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 2048 } }))
    const loader = fakeLoader({ pinFor: async () => ({ schema: 1, origin: APP, bundleHash: 'a'.repeat(64), assets: [], version: '1.2.3', pinnedAt: 0 }) })
    const controller = createSiteInfoController(ctxWith(broker, loader), NO_TRUST)

    expect(await controller.storageDeclarationFor(APP)).toEqual({ filesQuotaBytes: 2048, codeVersion: '1.2.3' })
  })

  it('null for an unregistered origin', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)
    expect(await controller.storageDeclarationFor(OTHER)).toBeNull()
  })
})
