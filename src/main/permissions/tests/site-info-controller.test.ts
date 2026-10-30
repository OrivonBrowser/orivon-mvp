import { NYM_TARGET } from '../../route/nym-provider.js'
import { NYM_SWITCHED_OFF } from '../../route/nym-subsystem.js'
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
import type { ProxySetup, SiteTrustSources } from '../site-info-controller.js'
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
  const routesWith = (state: string, proxy: unknown = { host: '127.0.0.1', port: 9050 }): SubsystemContext['routes'] => {
    const kind = proxy === NYM_TARGET ? 'nym' : 'socks5'
    return ({ hub: { state: () => state, isRouted: () => state !== 'off', kindOf: () => state === 'off' ? undefined : kind, unreadable: () => false, isEverywhere: () => false, profileFor: () => undefined }, routeSwitch: { blockedFor: () => undefined, noticeFor: () => 'nym' }, store: { stateOf: () => undefined, entries: () => [] }, defaultKind: () => kind, proxy: () => proxy, nym: { state: () => ({ state: 'connecting' }) } }) as unknown as SubsystemContext['routes']
  }

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

  it('says a private window is held to Nym, and refuses to switch a website off or to the other tunnel in it', async () => {
    const choose = vi.fn(async () => {})
    const held = { ...ctxWith(createBroker(baseDeps())), privateTunnel: 'nym', routes: { ...routesWith('ok', NYM_TARGET), routeSwitch: { blockedFor: () => undefined, noticeFor: () => undefined, choose } } } as unknown as SubsystemContext
    const controller = createSiteInfoController(held, NO_TRUST)
    expect((await controller.siteInfoFor(OTHER)).tunnelHeld).toBe('nym')
    expect(await controller.setTunnel(OTHER, null)).toBe(false)
    expect(await controller.setTunnel(OTHER, 'socks5'), 'nor the other tunnel').toBe(false)
    expect(choose).not.toHaveBeenCalled()
    expect(await controller.setTunnel(OTHER, 'nym')).toBe(true)
    const plain = { ...ctxWith(createBroker(baseDeps())), privateTunnel: null, routes: routesWith('ok', NYM_TARGET) } as unknown as SubsystemContext
    expect('tunnelHeld' in await createSiteInfoController(plain, NO_TRUST).siteInfoFor(OTHER)).toBe(false)
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

    expect(await controller.siteSummaryFor(OTHER)).toEqual({ asked: true, warning: false, missing: false })
    expect(await controller.siteSummaryFor('http://127.0.0.1:8080/page')).toEqual({ asked: true, warning: false, missing: false })
  })

  it('a malformed url also reports nothing asked, rather than throwing', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST)
    const summary = await controller.siteSummaryFor('not a url at all')
    expect(summary).toEqual({ asked: false, warning: false, missing: false })
  })

  it('a registered app with a declared, not-yet-held capability reports asked, not warning', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    const summary = await controller.siteSummaryFor(APP)

    expect(summary).toEqual({ asked: true, warning: false, missing: true })
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
    expect(await controller.siteSummaryFor(APP)).toEqual({ asked: true, warning: false, missing: false })
    expect(await controller.siteSummaryFor('ipfs://bafy')).toEqual({ asked: false, warning: false, missing: false })
  })

  it('a registered app holding everything it declared is missing nothing', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    expect((await controller.siteSummaryFor(APP)).missing).toBe(false)
  })

  it('a registered app holding part of what it declared is missing something', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 }, id: {} }))
    await broker.grant(APP, 'fs', [])
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST)

    expect((await controller.siteSummaryFor(APP)).missing).toBe(true)
  })

  it.each(['later', 'declined'] as const)('an app that was never let in (%s) is missing its permissions, and its popup offers the question back', async (reason) => {
    const askAgain = vi.fn(async () => true)
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST, async () => false, { notLetIn: (origin) => origin === OTHER ? reason : undefined, askAgain, changed: () => {} })

    expect((await controller.siteSummaryFor(OTHER)).missing).toBe(true)
    expect((await controller.siteInfoFor(OTHER)).notLetIn).toBe(reason)
    expect((await controller.siteSummaryFor('https://elsewhere.example')).missing).toBe(false)
    expect('notLetIn' in await controller.siteInfoFor('https://elsewhere.example')).toBe(false)

    expect(await controller.reviewPermissions(OTHER)).toBe(true)
    expect(askAgain).toHaveBeenCalledWith(OTHER)
  })

  it('reviewing permissions says no when the refusal could not be forgotten, so nothing reloads for a question that will not come', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST, async () => false, { notLetIn: () => 'declined', askAgain: async () => false, changed: () => {} })
    expect(await controller.reviewPermissions(OTHER)).toBe(false)
  })

  it('announces a change after a switch of the popup moves, either way', async () => {
    const broker = createBroker(baseDeps())
    await broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    const changed = vi.fn()
    const controller = createSiteInfoController(ctxWith(broker), NO_TRUST, async () => false, { notLetIn: () => undefined, askAgain: async () => true, changed })
    const row = (await controller.siteInfoFor(APP)).capabilityRows[0]
    await controller.turnOn(APP, 'fs', row?.patterns ?? [])
    await controller.turnOff(APP, 'fs')
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('reviewing permissions does nothing for an origin that was let in or is no app', async () => {
    const askAgain = vi.fn(async () => true)
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps())), NO_TRUST, async () => false, { notLetIn: () => undefined, askAgain, changed: () => {} })

    expect(await controller.reviewPermissions(OTHER)).toBe(false)
    expect(askAgain).not.toHaveBeenCalled()
  })
})

describe('createSiteInfoController -- a local file', () => {
  const FILE = 'file:///home/u/notes/app.html'

  it('shows the key for a local file, asked or not, and a local file never has a Web3 Score', async () => {
    const controller = createSiteInfoController(ctxWith(createBroker(baseDeps()), fakeLoader()), NO_TRUST)
    expect(await controller.siteSummaryFor(`${FILE}?x=1#top`)).toEqual({ asked: true, warning: false, missing: false })
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

describe('createSiteInfoController -- the tunnel of a website or an installed app', () => {
  const SITE = 'https://news.example'
  interface Options {
    via?: 'nym' | 'socks5'
    blocked?: Partial<Record<'nym' | 'socks5', 'no-proxy' | 'not-cached'>>
    notices?: Partial<Record<'nym' | 'socks5' | 'none', 'nym' | 'socks5' | 'direct'>>
    unreadable?: boolean
    everywhere?: boolean
    defaultKind?: 'nym' | 'socks5'
    own?: boolean
    nymOff?: boolean
    sessionKind?: 'nym' | 'socks5' | 'held' | undefined
    entries?: Array<readonly [string, 'nym' | 'socks5' | 'off']>
    choose?: (origin: string, kind: string | null) => Promise<void>
  }
  function routesFor (options: Options = {}): SubsystemContext['routes'] {
    return {
      hub: { state: () => options.via === undefined ? 'off' : 'ok', isRouted: () => options.via !== undefined, kindOf: () => options.via, unreadable: () => options.unreadable === true, isEverywhere: () => options.everywhere === true, profileFor: () => undefined },
      store: { stateOf: () => options.own === true ? options.via ?? 'off' : undefined, entries: () => options.entries ?? [] },
      defaultKind: () => options.defaultKind ?? 'socks5',
      controller: { tunnelOf: () => options.sessionKind },
      nym: { state: () => options.nymOff === true ? { state: 'unavailable', cause: 'other', reason: NYM_SWITCHED_OFF } : { state: 'off' } },
      routeSwitch: {
        blockedFor: (_origin: string, kind: 'nym' | 'socks5') => options.blocked?.[kind],
        noticeFor: (_origin: string, kind: 'nym' | 'socks5' | null) => options.notices?.[kind ?? 'none'],
        choose: options.choose ?? (async () => {})
      }
    } as unknown as SubsystemContext['routes']
  }
  const controllerWith = (routes: SubsystemContext['routes'], trust: SiteTrustSources = NO_TRUST, proxy?: ProxySetup, privateTunnel: 'nym' | null = null) =>
    createSiteInfoController({ ...ctxWith(createBroker(baseDeps())), routes, privateTunnel } as unknown as SubsystemContext, trust, undefined, undefined, proxy)
  const AS_APP: SiteTrustSources = { ...NO_TRUST, isOriginServedFromCacheSync: () => true }

  it('offers both tunnels for an ordinary website, with nothing chosen and what the popover needs to ask first', async () => {
    const info = await controllerWith(routesFor({ notices: { nym: 'nym', socks5: 'socks5' } })).siteInfoFor(SITE)
    expect(info.tunnel).toEqual({ via: null, following: true, subject: 'site', blocked: {}, notices: { nym: 'nym', socks5: 'socks5' }, swarm: false, unreadable: false, defaultKind: 'socks5', proxy: { address: '', users: { sites: 0, apps: 0, tabs: 0, everything: false } } })
  })

  it('says which tunnel the site goes through, whether that is its own choice or the default, and names the direct profile when giving the tunnel up would move it there', async () => {
    const followed = await controllerWith(routesFor({ via: 'nym', everywhere: true, defaultKind: 'nym', notices: { none: 'direct' } })).siteInfoFor(SITE)
    expect(followed.tunnel).toMatchObject({ via: 'nym', following: true, notices: { off: 'direct' } })
    const chosen = await controllerWith(routesFor({ via: 'socks5', own: true })).siteInfoFor(SITE)
    expect(chosen.tunnel).toMatchObject({ via: 'socks5', following: false })
    expect(chosen.route).toBe('ok')
  })

  it('asks for no notice about the tunnel the site is on already', async () => {
    const info = await controllerWith(routesFor({ via: 'nym', own: true, notices: { nym: 'nym', socks5: 'socks5' } })).siteInfoFor(SITE)
    expect(info.tunnel?.notices).toEqual({ socks5: 'socks5' })
  })

  it('says why a tunnel cannot be chosen: the proxy has no address, Nym is switched off, an app\'s files are not held here', async () => {
    expect((await controllerWith(routesFor({ blocked: { socks5: 'no-proxy' } })).siteInfoFor(SITE)).tunnel?.blocked).toEqual({ socks5: 'no-proxy' })
    expect((await controllerWith(routesFor({ nymOff: true })).siteInfoFor(SITE)).tunnel?.blocked).toEqual({ nym: 'nym-off' })
    expect((await controllerWith(routesFor({ blocked: { nym: 'not-cached', socks5: 'not-cached' } }), AS_APP).siteInfoFor(SITE)).tunnel?.blocked).toEqual({ nym: 'not-kept', socks5: 'not-kept' })
    expect((await controllerWith(routesFor({ unreadable: true, via: 'nym' })).siteInfoFor(SITE)).tunnel?.unreadable).toBe(true)
  })

  it('says which tunnel the person chose and whether the whole browser is on it, for every origin', async () => {
    expect(await controllerWith(routesFor()).siteInfoFor(SITE)).toMatchObject({ tunnelKind: 'socks5', everywhere: false })
    expect(await controllerWith(routesFor({ defaultKind: 'nym' })).siteInfoFor(SITE)).toMatchObject({ tunnelKind: 'nym', tunnel: { defaultKind: 'nym' } })
    const everywhere = await controllerWith(routesFor({ defaultKind: 'nym', everywhere: true })).siteInfoFor('http://127.0.0.1:8080')
    expect(everywhere).toMatchObject({ tunnelKind: 'nym', everywhere: true })
    expect(everywhere.tunnel, 'this computer has no switch').toBeUndefined()
  })

  it('gives an installed app the same switches, with no word about a profile', async () => {
    const info = await controllerWith(routesFor({ via: 'nym', own: true }), AS_APP).siteInfoFor(SITE)
    expect(info.tunnel).toMatchObject({ subject: 'app', via: 'nym', following: false })
    expect(info.tunnel?.profile).toBeUndefined()
  })

  it('names the tunnel the site goes through when it is not the one chosen for the browser, and asks what Nym is doing for it', async () => {
    const info = await controllerWith(routesFor({ via: 'nym', own: true, defaultKind: 'socks5' })).siteInfoFor(SITE)
    expect(info).toMatchObject({ tunnelKind: 'nym', nym: { state: 'off' } })
    const proxied = await controllerWith(routesFor({ via: 'socks5', own: true, defaultKind: 'nym' })).siteInfoFor(SITE)
    expect(proxied.tunnelKind).toBe('socks5')
    expect('nym' in proxied).toBe(false)
  })

  it('marks a Swarm address, which cannot go through a tunnel, and no other Web3 name or address', async () => {
    expect((await controllerWith(routesFor()).siteInfoFor('https://abc.bzz.orivon')).tunnel?.swarm).toBe(true)
    expect((await controllerWith(routesFor()).siteInfoFor('https://vitalik.eth')).tunnel?.swarm).toBe(false)
    expect((await controllerWith(routesFor()).siteInfoFor('https://abc.ipfs.orivon')).tunnel?.swarm).toBe(false)
  })

  it('has no switch for this computer, a local file or when routes are not running', async () => {
    expect((await controllerWith(routesFor()).siteInfoFor('http://127.0.0.1:8080')).tunnel).toBeUndefined()
    expect((await controllerWith(routesFor()).siteInfoFor('http://localhost:3000')).tunnel).toBeUndefined()
    expect((await controllerWith(undefined).siteInfoFor(SITE)).tunnel).toBeUndefined()
  })

  it('sends a website or an app through the tunnel asked for, or through none, by the one switch path, and says whether it did', async () => {
    const choose = vi.fn(async () => {})
    const controller = controllerWith(routesFor({ choose }))
    expect(await controller.setTunnel(SITE, 'nym')).toBe(true)
    expect(await controller.setTunnel(SITE, 'socks5')).toBe(true)
    expect(await controller.setTunnel(SITE, null)).toBe(true)
    expect(choose.mock.calls).toEqual([[SITE, 'nym'], [SITE, 'socks5'], [SITE, null]])
    expect(await controllerWith(routesFor({ choose }), AS_APP).setTunnel(SITE, 'nym'), 'an app takes the same call').toBe(true)
    expect(choose).toHaveBeenLastCalledWith(SITE, 'nym')
  })

  it('refuses a tunnel that is blocked, or Nym while it is switched off, but always lets one go', async () => {
    const choose = vi.fn(async () => {})
    const blocked = controllerWith(routesFor({ blocked: { socks5: 'no-proxy' }, choose }))
    expect(await blocked.setTunnel(SITE, 'socks5')).toBe(false)
    expect(await blocked.setTunnel(SITE, 'nym')).toBe(true)
    expect(await blocked.setTunnel(SITE, null)).toBe(true)
    expect(choose.mock.calls).toEqual([[SITE, 'nym'], [SITE, null]])
    choose.mockClear()
    const off = controllerWith(routesFor({ nymOff: true, choose }))
    expect(await off.setTunnel(SITE, 'nym')).toBe(false)
    expect(await off.setTunnel(SITE, 'socks5')).toBe(true)
    expect(await off.setTunnel(SITE, null)).toBe(true)
  })

  it('refuses this computer, and reports a choice that could not be kept', async () => {
    const choose = vi.fn(async () => { throw new Error('disk full') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await controllerWith(routesFor({ choose })).setTunnel('http://127.0.0.1:8080', 'nym')).toBe(false)
    expect(choose).not.toHaveBeenCalled()
    expect(await controllerWith(routesFor({ choose })).setTunnel(SITE, 'nym')).toBe(false)
  })

  it('shows a page that runs in a session of another tunnel as going through that tunnel, with its switches fixed', async () => {
    const controller = controllerWith(routesFor({ sessionKind: 'nym', defaultKind: 'socks5' }))
    const info = await controller.siteInfoFor(SITE)
    const adopted = controller.inSession(info, {})
    expect(adopted.tunnel).toMatchObject({ via: 'nym', following: false, fixed: 'opened', notices: {} })
    expect(adopted).toMatchObject({ tunnelKind: 'nym', route: 'idle', nym: { state: 'off' } })
  })

  it('says a page is not on its tunnel yet when its session is not pointed at one, instead of showing the tunnel it will have', async () => {
    const controller = controllerWith(routesFor({ via: 'socks5', sessionKind: undefined }))
    const info = await controller.siteInfoFor(SITE)
    const moving = controller.inSession(info, {})
    expect(moving).toMatchObject({ route: 'moving', tunnelKind: 'socks5' })
    expect(moving.tunnel).toMatchObject({ via: 'socks5' })
    const own = controllerWith(routesFor({ sessionKind: undefined }))
    const plain = await own.siteInfoFor(SITE)
    expect(own.inSession(plain, {}), 'a page with no tunnel of its own has nothing to wait for').toBe(plain)
  })

  it('leaves a page alone that runs in the session of its own tunnel, or in one that is stopped', async () => {
    for (const sessionKind of ['socks5', 'held'] as const) {
      const controller = controllerWith(routesFor({ via: 'socks5', sessionKind }))
      const info = await controller.siteInfoFor(SITE)
      expect(controller.inSession(info, {}), String(sessionKind)).toBe(info)
    }
    const controller = controllerWith(routesFor({ sessionKind: 'nym' }))
    const info = await controller.siteInfoFor(SITE)
    expect(controller.inSession(info, undefined), 'no tab').toBe(info)
  })
})

describe('createSiteInfoController -- the proxy set from the menu', () => {
  const SITE = 'https://news.example'
  const routes = (extra: Record<string, unknown> = {}): SubsystemContext['routes'] => ({
    hub: { state: () => 'off', isRouted: () => false, kindOf: () => undefined, unreadable: () => false, isEverywhere: () => extra['everywhere'] === true, profileFor: () => undefined },
    store: { stateOf: () => undefined, entries: () => extra['entries'] ?? [] },
    defaultKind: () => extra['defaultKind'] ?? 'nym',
    controller: { tunnelOf: () => undefined },
    nym: { state: () => ({ state: 'off' }) },
    routeSwitch: { blockedFor: () => undefined, noticeFor: () => undefined, choose: async () => {} }
  }) as unknown as SubsystemContext['routes']
  const setup = (over: Partial<ProxySetup> = {}): ProxySetup => ({ address: () => '127.0.0.1:9050', save: vi.fn(() => 'ok' as const), test: vi.fn(async () => ({ ok: true as const, authentication: 'none' as const })), ...over })
  const controller = (rt: SubsystemContext['routes'], proxy: ProxySetup, privateTunnel: 'nym' | null = null, trust: SiteTrustSources = NO_TRUST) =>
    createSiteInfoController({ ...ctxWith(createBroker(baseDeps())), routes: rt, privateTunnel } as unknown as SubsystemContext, trust, undefined, undefined, proxy)

  it('carries the saved address and how many sites and apps go through the proxy now', async () => {
    const entries = [['https://a.example', 'socks5'], ['https://b.example', 'socks5'], ['https://c.example', 'nym'], ['https://d.example', 'off'], ['https://e.example', 'socks5']] as const
    const trust: SiteTrustSources = { ...NO_TRUST, isOriginServedFromCacheSync: (origin) => origin === 'https://e.example' }
    const info = await controller(routes({ entries }), setup(), null, trust).siteInfoFor(SITE)
    expect(info.tunnel?.proxy).toEqual({ address: '127.0.0.1:9050', users: { sites: 2, apps: 1, tabs: 0, everything: false } })
  })

  it('counts the whole browser as using the proxy when it is on the proxy', async () => {
    expect((await controller(routes({ everywhere: true, defaultKind: 'socks5' }), setup()).siteInfoFor(SITE)).tunnel?.proxy.users.everything).toBe(true)
    expect((await controller(routes({ everywhere: true, defaultKind: 'nym' }), setup()).siteInfoFor(SITE)).tunnel?.proxy.users.everything).toBe(false)
    expect((await controller(routes({ everywhere: false, defaultKind: 'socks5' }), setup()).siteInfoFor(SITE)).tunnel?.proxy.users.everything).toBe(false)
  })

  it('checks the address as Settings does before it reaches the settings, and saves it trimmed', () => {
    const proxy = setup()
    const c = controller(routes(), proxy)
    for (const bad of ['', 'nonsense', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:99999', 'a b:80', 'x'.repeat(400)]) expect(c.setProxyAddress(bad), bad).toBe('invalid')
    expect(proxy.save).not.toHaveBeenCalled()
    expect(c.setProxyAddress('  127.0.0.1:9150 ')).toBe('ok')
    expect(proxy.save).toHaveBeenCalledWith('127.0.0.1:9150')
    expect(c.setProxyAddress('socks5://127.0.0.1:9150')).toBe('ok')
  })

  it('passes on the settings\' answer, and is refused in a window held to Nym and while routes are not running', () => {
    expect(controller(routes(), setup({ save: () => 'invalid' })).setProxyAddress('127.0.0.1:9150')).toBe('invalid')
    expect(controller(routes(), setup({ save: () => 'refused' })).setProxyAddress('127.0.0.1:9150')).toBe('refused')
    const proxy = setup()
    expect(controller(routes(), proxy, 'nym').setProxyAddress('127.0.0.1:9150')).toBe('refused')
    expect(controller(undefined, proxy).setProxyAddress('127.0.0.1:9150')).toBe('refused')
    expect(proxy.save).not.toHaveBeenCalled()
  })

  it('tests the tunnel asked for, and answers nothing in a window held to Nym', async () => {
    const proxy = setup()
    expect(await controller(routes(), proxy).testTunnel('socks5')).toEqual({ ok: true, authentication: 'none' })
    expect(proxy.test).toHaveBeenCalledWith('socks5')
    expect(await controller(routes(), proxy, 'nym').testTunnel('socks5')).toBeNull()
    expect(await controller(undefined, proxy).testTunnel('nym')).toBeNull()
  })
})

