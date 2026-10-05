import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { APP, baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { Loader, LoadResult } from '../../../loader/index.js'
import type { SubsystemContext } from '../../registry.js'
import { createSiteInfoController } from '../site-info-controller.js'
import type { SiteTrustSources } from '../site-info-controller.js'
import type { ExtensionsApi } from '../../extensions/extensions-subsystem.js'
import type { InstalledExtension } from '../../extensions/registry.js'

const OTHER = 'https://not-a-real-origin.invalid'

function ctxWith (broker: Broker | undefined, loader?: Loader, extensions?: ExtensionsApi): SubsystemContext {
  return { broker, loader, extensions } as unknown as SubsystemContext
}

/** Only `list` is ever called (the extensions disclosure reads no other method of
 * `ExtensionsApi`) -- every other member is unused here on purpose. */
function fakeExtensions (entries: readonly InstalledExtension[]): ExtensionsApi {
  return { list: () => entries } as unknown as ExtensionsApi
}

function installedAt (path: string, name: string): InstalledExtension {
  return {
    id: 'fixture-extension-id-0000000000',
    name,
    version: '1.0.0',
    enabled: true,
    installedAt: 0,
    updatedAt: 0,
    source: { kind: 'unpacked', from: path },
    updater: { kind: 'none', reason: 'test fixture' },
    path,
    stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
  }
}

const LOCAL_HASH = 'sha256:' + 'e'.repeat(64)

const NO_TRUST: SiteTrustSources = {
  isOriginServedFromCacheSync: () => false,
  pinCoverageFor: () => undefined,
  nameEvidenceFor: async () => undefined,
  levelOverrideFor: () => undefined,
  deliveryOverrideFor: () => undefined,
  localDdocHashFor: async () => undefined,
  providerVerdictFor: async () => ({ status: 'off' })
}

function fakeLoader (overrides: Partial<Loader> = {}): Loader {
  return {
    load: async (): Promise<LoadResult> => ({ outcome: 'rejected', reason: 'unused' }),
    installFetched: async () => { throw new Error('not stubbed') },
    reconsider: async () => { throw new Error('not stubbed') },
    pinFor: async () => null,
    ddocFor: async () => undefined,
    manifestFor: async () => undefined,
    manifestAt: async () => ({ kind: 'website' }),
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

  it('an ordinary website always shows the key, because its popover lists what it may do', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)

    expect(await controller.siteSummaryFor(OTHER)).toEqual({ asked: true, warning: false })
    expect(await controller.siteSummaryFor('http://127.0.0.1:8080/page')).toEqual({ asked: true, warning: false })
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

  it('with no broker published yet, reports no warning rather than throwing', async () => {
    const controller = createSiteInfoController(ctxWith(undefined), NO_TRUST)
    expect(await controller.siteSummaryFor(APP)).toEqual({ asked: true, warning: false })
    expect(await controller.siteSummaryFor('ipfs://bafy')).toEqual({ asked: false, warning: false })
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
      pinCoverageFor: () => ({ pinnedRequests: 1, thirdPartyRequests: 0, deniedRequests: 0, pinnedBytes: 5, thirdPartyBytes: 0, bytesIncomplete: false }),
      nameEvidenceFor: async () => undefined,
      levelOverrideFor: () => undefined,
      deliveryOverrideFor: () => undefined,
      localDdocHashFor: async () => undefined,
      providerVerdictFor: async () => ({ status: 'off' })
    }
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), loader), trustSources)

    const trust = await controller.siteTrustFor(APP)

    expect(trust?.connection).toBe('cached')
    expect(trust?.pin).toEqual({ bundleHash: 'a'.repeat(64), version: '3.0.0', pinnedAt: 10 })
    expect(trust?.delivery.evidence.pinCoverage?.pinnedRequests).toBe(1)
  })

  it('asks the name-evidence source with the pin and cache facts, and shows what it answers', async () => {
    const pin = { schema: 1 as const, origin: 'https://site.eth', bundleHash: 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 10 }
    const asked: unknown[] = []
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader({ pinFor: async () => pin })), {
      ...NO_TRUST,
      isOriginServedFromCacheSync: () => true,
      nameEvidenceFor: async (...args) => {
        asked.push(args)
        return { content: { source: 'pinned', cid: 'bafy', pointersVerified: true }, nameProven: true, line: 'Installed', rows: [] }
      }
    })

    const trust = await controller.siteTrustFor('https://site.eth/app/')

    expect(asked).toEqual([['https://site.eth', pin, true]])
    expect(trust?.level.level).toBe(2)
    expect(trust?.name?.line).toBe('Installed')
  })

  it('null with no loader published yet', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)
    expect(await controller.siteTrustFor(APP)).toBeNull()
  })

  it('null for a malformed url', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), NO_TRUST)
    expect(await controller.siteTrustFor('not a url')).toBeNull()
  })

  it('asks the injected sources for a level and a delivery override, and shows them as the displayed values', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), {
      ...NO_TRUST,
      levelOverrideFor: (origin) => origin === APP ? 4 : undefined,
      deliveryOverrideFor: (origin) => origin === APP ? 3 : undefined
    })

    const trust = await controller.siteTrustFor(APP)

    expect(trust?.levelOverride).toBe(4)
    expect(trust?.displayedLevel).toBe(4)
    expect(trust?.deliveryOverride).toBe(3)
    expect(trust?.displayedDelivery).toBe(3)
    // The observed level is untouched by the override.
    expect(trust?.level.level).toBe(1)
  })

  it('asks the local-DDOC source for an unpinned origin, and shows its answer as DDOC', async () => {
    const LOCAL = 'http://127.0.0.1:8875'
    const asked: string[] = []
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), {
      ...NO_TRUST,
      localDdocHashFor: async (origin) => { asked.push(origin); return origin === LOCAL ? LOCAL_HASH : undefined }
    })

    const trust = await controller.siteTrustFor(`${LOCAL}/app/`)

    expect(asked).toEqual([LOCAL])
    expect(trust?.ddoc).toEqual({ status: 'local-dev' })
    expect(trust?.displayedLevel).toBe(2)
  })

  it('asks the provider about the page\'s identity only once DDOC holds, and shows its judgement', async () => {
    const LOCAL = 'http://127.0.0.1:8875'
    const asked: Array<string | undefined> = []
    const sources = (hash: string | undefined): SiteTrustSources => ({
      ...NO_TRUST,
      localDdocHashFor: async () => hash,
      providerVerdictFor: async (id, waitMs) => {
        asked.push(id)
        expect(waitMs).toBeGreaterThan(0)
        return id === undefined
          ? { status: 'not-assessable', address: 'http://127.0.0.1:7860/score' }
          : { status: 'judged', provider: { name: 'Test provider', address: 'http://127.0.0.1:7860/score' }, evaluation: { id, name: 'App', version: undefined, evaluated: '2026-10-03', trustlessity: { level: 3, privacy: false }, summary: undefined, operations: [], connections: [], evidence: [] } }
      }
    })

    const judged = await createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), sources(LOCAL_HASH)).siteTrustFor(LOCAL)
    const unchecked = await createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), sources(undefined)).siteTrustFor(LOCAL)

    expect(asked).toEqual([LOCAL_HASH, undefined])
    expect(judged?.displayedLevel).toBe(3)
    expect(judged?.judged.status).toBe('judged')
    expect(unchecked?.displayedLevel).toBe(1)
    expect(unchecked?.judged.status).toBe('not-assessable')
  })

  it('shows a provider\'s Level 4 only at the domain the live manifest names', async () => {
    const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
    const sourcesFor = (): SiteTrustSources => ({
      ...NO_TRUST,
      nameEvidenceFor: async () => ({ content: { source: 'live', cid: CID, pointersVerified: true }, nameProven: true, line: 'n', rows: [] }),
      providerVerdictFor: async (id) => ({ status: 'judged', provider: { name: 'P', address: 'x' }, evaluation: { id: id ?? '', name: 'App', version: undefined, evaluated: '2026-10-05', trustlessity: { level: 4, privacy: true }, summary: undefined, operations: [], connections: [], evidence: [] } })
    })
    const loader = fakeLoader({ manifestAt: async () => ({ kind: 'app', manifest: { ...manifestWith({}), domain: 'app.eth' } }) })
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), loader), sourcesFor())

    expect((await controller.siteTrustFor('https://app.eth'))?.displayedLevel).toBe(4)
    const evil = await controller.siteTrustFor('https://evil.eth')
    expect(evil?.displayedLevel).toBe(2)
    expect(evil).toMatchObject({ binding: 'other-home', homeDomain: 'app.eth', judgedElsewhere: true })
  })

  it('never asks the local-DDOC source for a pinned origin: its pin is compared instead', async () => {
    const asked: string[] = []
    const loader = fakeLoader({ pinFor: async () => ({ schema: 1, origin: APP, bundleHash: 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 10 }) })
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), loader), {
      ...NO_TRUST,
      localDdocHashFor: async (origin) => { asked.push(origin); return LOCAL_HASH }
    })

    const trust = await controller.siteTrustFor(APP)

    expect(asked).toEqual([])
    expect(trust?.ddoc).toEqual({ status: 'not-published' })
  })
})

describe('createSiteInfoController -- extensionsOnSite (the extensions disclosure)', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-site-info-ext-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function seededExtension (name: string): Promise<InstalledExtension> {
    const extDir = join(dir, name.toLowerCase().replace(/\s+/g, '-'))
    await mkdir(extDir, { recursive: true })
    await writeFile(join(extDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name, version: '1.0.0', host_permissions: ['<all_urls>']
    }))
    return installedAt(extDir, name)
  }

  it('names a covering extension on an ordinary, never-registered origin', async () => {
    const extensions = fakeExtensions([await seededExtension('Ad Blocker')])
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), undefined, extensions), NO_TRUST)

    const info = await controller.siteInfoFor(OTHER)

    expect(info.extensionsOnSite).toEqual(['Ad Blocker'])
  })

  it('names a covering extension on a registered app too, alongside its capability rows', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    const extensions = fakeExtensions([await seededExtension('Ad Blocker')])
    const controller = createSiteInfoController(ctxWith(broker, undefined, extensions), NO_TRUST)

    const info = await controller.siteInfoFor(APP)

    expect(info.extensionsOnSite).toEqual(['Ad Blocker'])
    expect(info.capabilityRows.length).toBeGreaterThan(0)
  })

  it('names none for an origin served from its pinned cache', async () => {
    const extensions = fakeExtensions([await seededExtension('Ad Blocker')])
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), undefined, extensions), {
      ...NO_TRUST,
      isOriginServedFromCacheSync: (origin) => origin === OTHER
    })

    const info = await controller.siteInfoFor(OTHER)

    expect(info.extensionsOnSite).toEqual([])
  })

  it('names none with no ctx.extensions published yet, rather than throwing', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)

    const info = await controller.siteInfoFor(OTHER)

    expect(info.extensionsOnSite).toEqual([])
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
