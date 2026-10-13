import { NYM_TARGET } from '../../route/nym-provider.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    applyUpdate: async () => ({ outcome: 'rejected', reason: 'unused' }),
    quietOffers: async () => ({ quiet: [] }),
    keepQuiet: async () => {},
    manifestFor: async () => undefined,
    manifestAt: async () => ({ kind: 'website' }),
    readManifest: async () => ({ kind: 'website' }),
    fetchForInstall: async () => ({ ok: false, reason: 'unused' }),
    readDeclaration: async () => ({ kind: 'none' }),
    serveLive: async () => false,
    endLive: async () => {},
    rememberConsent: async () => {},
    pendingConsents: async () => [],
    ...overrides
  }
}

describe('createSiteInfoController -- the route of a routed app', () => {
  const routesWith = (state: string, proxy: unknown = { host: '127.0.0.1', port: 9050 }): SubsystemContext['routes'] => ({ hub: { state: () => state, isRouted: () => state !== 'off', unreadable: () => false, isEverywhere: () => false, profileFor: () => undefined }, routeSwitch: { siteBlockedFor: () => undefined, siteNotice: () => 'tunnel' }, proxy: () => proxy, nym: { state: () => ({ state: 'connecting' }) } }) as unknown as SubsystemContext['routes']

  it('carries the state of the app\'s route, so the popover can say where its traffic goes and when the tunnel is not answering', async () => {
    for (const state of ['idle', 'ok', 'down', 'no-proxy']) {
      const ctx = { ...ctxWith(createBroker(baseDeps())), routes: routesWith(state) } as unknown as SubsystemContext
      expect((await createSiteInfoController(ctx, NO_TRUST).siteInfoFor(OTHER)).route, state).toBe(state)
    }
  })

  it('carries what Nym is doing when the app leaves through Nym, and not when it leaves through an address', async () => {
    const onNym = { ...ctxWith(createBroker(baseDeps())), routes: routesWith('ok', NYM_TARGET) } as unknown as SubsystemContext
    expect((await createSiteInfoController(onNym, NO_TRUST).siteInfoFor(OTHER)).nym).toEqual({ state: 'connecting' })
    const onAddress = { ...ctxWith(createBroker(baseDeps())), routes: routesWith('ok') } as unknown as SubsystemContext
    expect('nym' in await createSiteInfoController(onAddress, NO_TRUST).siteInfoFor(OTHER)).toBe(false)
  })

  it('carries nothing for an app that is not routed', async () => {
    const ctx = { ...ctxWith(createBroker(baseDeps())), routes: routesWith('off') } as unknown as SubsystemContext
    expect('route' in await createSiteInfoController(ctx, NO_TRUST).siteInfoFor(OTHER)).toBe(false)
    expect('route' in await createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST).siteInfoFor(OTHER)).toBe(false)
  })
})

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

describe('createSiteInfoController -- a local file', () => {
  const FILE = 'file:///home/u/notes/app.html'

  it('shows the key for a local file, asked or not, and a local file never has a Web3 Score', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), NO_TRUST)
    expect(await controller.siteSummaryFor(`${FILE}?x=1#top`)).toEqual({ asked: true, warning: false })
    expect(await controller.siteTrustFor(FILE)).toBeNull()
    expect((await controller.siteInfoFor(FILE)).origin).toBe(FILE)
  })

  it('reads a registered local file by its key, query and fragment aside, and turns a capability off for it', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(FILE, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(FILE, 'fs', [])
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    expect((await controller.siteInfoFor(`${FILE}?x=1`)).capabilityRows.map((row) => [row.capability, row.on])).toEqual([['fs', true]])
    await controller.turnOff(FILE, 'fs')
    expect((await controller.siteInfoFor(FILE)).capabilityRows.map((row) => row.on)).toEqual([false])
  })

  it('deletes a local file\'s data through the function it was given, for a local key only', async () => {
    const deleted: string[] = []
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST, async (key) => { deleted.push(key); return true })
    expect(await controller.deleteLocalFileData(FILE)).toBe(true)
    expect(await controller.deleteLocalFileData('https://example.com')).toBe(false)
    expect(deleted).toEqual([FILE])
    expect(await createSiteInfoController(ctxWith(undefined), NO_TRUST).deleteLocalFileData(FILE)).toBe(false)
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
    const loader = fakeLoader({ manifestAt: async () => ({ kind: 'app', manifest: { ...manifestWith({}), domain: 'app.eth' }, bytes: new Uint8Array() }) })
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

describe('createSiteInfoController -- the tunnel switch of a website', () => {
  const SITE = 'https://news.example'
  function routesFor (options: { on?: boolean, blocked?: 'no-proxy' | 'local', notice?: 'tunnel' | 'direct' | null, unreadable?: boolean, everywhere?: boolean, setSite?: (origin: string, on: boolean) => Promise<void> } = {}): SubsystemContext['routes'] {
    return {
      hub: { state: () => options.on === true ? 'ok' : 'off', isRouted: () => options.on === true, unreadable: () => options.unreadable === true, isEverywhere: () => options.everywhere === true, profileFor: () => undefined },
      proxy: () => ({ host: '127.0.0.1', port: 9050 }),
      routeSwitch: {
        siteBlockedFor: () => options.blocked,
        siteNotice: () => options.notice === null ? undefined : options.notice ?? 'tunnel',
        setSite: options.setSite ?? (async () => {})
      }
    } as unknown as SubsystemContext['routes']
  }
  const controllerWith = (routes: SubsystemContext['routes'], trust: SiteTrustSources = NO_TRUST) =>
    createSiteInfoController({ ...ctxWith(createBroker(baseDeps())), routes } as unknown as SubsystemContext, trust)

  it('offers the switch for an ordinary website, with what the popover needs to ask first', async () => {
    const info = await controllerWith(routesFor({ notice: 'tunnel' })).siteInfoFor(SITE)
    expect(info.tunnel).toEqual({ on: false, notice: 'tunnel', swarm: false, unreadable: false })
  })

  it('says it is on, and that no notice is needed once the site has storage in the profile the next change moves it to', async () => {
    const info = await controllerWith(routesFor({ on: true, notice: null })).siteInfoFor(SITE)
    expect(info.tunnel).toMatchObject({ on: true })
    expect(info.tunnel?.notice).toBeUndefined()
    expect(info.route).toBe('ok')
  })

  it('names the direct profile when turning a site off would move it there', async () => {
    const info = await controllerWith(routesFor({ on: true, notice: 'direct', everywhere: true })).siteInfoFor(SITE)
    expect(info.tunnel?.notice).toBe('direct')
  })

  it('says why it cannot be turned on, and when the list of tunnel settings could not be read', async () => {
    expect((await controllerWith(routesFor({ blocked: 'no-proxy' })).siteInfoFor(SITE)).tunnel?.blocked).toBe('no-proxy')
    expect((await controllerWith(routesFor({ unreadable: true, on: true })).siteInfoFor(SITE)).tunnel?.unreadable).toBe(true)
  })

  it('marks a Swarm address, which cannot go through the tunnel, and no other Web3 name or address', async () => {
    expect((await controllerWith(routesFor()).siteInfoFor('https://abc.bzz.orivon')).tunnel?.swarm).toBe(true)
    expect((await controllerWith(routesFor()).siteInfoFor('https://vitalik.eth')).tunnel?.swarm).toBe(false)
    expect((await controllerWith(routesFor()).siteInfoFor('https://abc.ipfs.orivon')).tunnel?.swarm).toBe(false)
  })

  it('has no switch for this computer, an installed app, a local file or when routes are not running', async () => {
    expect((await controllerWith(routesFor()).siteInfoFor('http://127.0.0.1:8080')).tunnel).toBeUndefined()
    expect((await controllerWith(routesFor()).siteInfoFor('http://localhost:3000')).tunnel).toBeUndefined()
    expect((await controllerWith(routesFor(), { ...NO_TRUST, isOriginServedFromCacheSync: () => true }).siteInfoFor(SITE)).tunnel).toBeUndefined()
    expect((await controllerWith(undefined).siteInfoFor(SITE)).tunnel).toBeUndefined()
  })

  it('turns the tunnel on or back to the default through the one switch path, and says whether it did', async () => {
    const setSite = vi.fn(async () => {})
    const controller = controllerWith(routesFor({ setSite }))
    expect(await controller.setTunnel(SITE, true)).toBe(true)
    expect(await controller.setTunnel(SITE, false)).toBe(true)
    expect(setSite.mock.calls).toEqual([[SITE, true], [SITE, false]])
  })

  it('refuses to turn it on when it is blocked, but always turns it off', async () => {
    const setSite = vi.fn(async () => {})
    const controller = controllerWith(routesFor({ blocked: 'no-proxy', setSite }))
    expect(await controller.setTunnel(SITE, true)).toBe(false)
    expect(await controller.setTunnel(SITE, false)).toBe(true)
    expect(setSite.mock.calls).toEqual([[SITE, false]])
  })

  it('refuses an installed app, whose card has its own switch, and reports a choice that could not be kept', async () => {
    const setSite = vi.fn(async () => { throw new Error('disk full') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await controllerWith(routesFor({ setSite }), { ...NO_TRUST, isOriginServedFromCacheSync: () => true }).setTunnel(SITE, true)).toBe(false)
    expect(setSite).not.toHaveBeenCalled()
    expect(await controllerWith(routesFor({ setSite })).setTunnel(SITE, true)).toBe(false)
  })
})
