import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
import type { Manifest } from '../../../contracts/index.js'
import type { FirstBundle, FirstDeclaration, FirstManifest, Loader } from '../../../loader/index.js'
import type { InstallConsentPrompt } from '../../consent/install-consent.js'
import type { DialogCaller } from '../../consent/request-grant.js'
import { DeclinedApps } from '../declined-apps.js'
import { createFirstVisit, MANIFEST_PROBE_MS, runFirstVisit } from '../first-visit.js'
import type { FirstVisitDeps, SetupHost, SetupSheet, SetupStage } from '../first-visit.js'

// The order of a first visit: the person is asked as soon as the manifest is read, with the site's declared tree
// read beside the question; Allow grants and enters at once, every file is checked as it is served, and the
// download and pin follow in the background. A mismatch anywhere is bad data: the origin is taken away entirely.

const VERIFIED = 'https://abc.ipfs.orivon'
const WEBSITE = 'https://app.example.com'
const leaf = (character: string): string => `sha256:${character.repeat(64)}`
const MANIFEST: Manifest = { orivonApiVersion: 0, id: 'app.test', name: 'Test App', version: '1.0.0', entry: 'index.html', capabilities: { fs: { quotaBytes: 1024 } } }
const TREE = { root: leaf('r'), assets: [{ path: '/index.html', leaf: leaf('a') }] }
const CONTENT = { cid: 'bafy', via: 'ipfs' as const, pointersVerified: true }
const DECLARED = { kind: 'declared' as const, declaration: { bundleHash: TREE.root, leaves: [{ path: '/index.html', leaf: leaf('a') }] } }
const DIFFERENT = { bundleHash: TREE.root, leaves: [{ path: '/index.html', leaf: leaf('z') }] }

const readOf = (origin: string): FirstManifest => ({ kind: 'app', canonicalOrigin: origin, manifest: MANIFEST, bytes: new Uint8Array([1]), content: undefined })

type Fetched = Extract<FirstBundle, { ok: true }>

function bundle (origin: string, overrides: Partial<Fetched> = {}): Fetched {
  return { ok: true, canonicalOrigin: origin, manifest: MANIFEST, tree: TREE, entries: [], declaration: undefined, content: undefined, discard: vi.fn(async () => {}), ...overrides }
}

interface Harness {
  readonly origin: string
  readonly url: string
  readonly broker: ReturnType<typeof createBroker>
  readonly events: string[]
  readonly host: SetupHost & { sheets: SetupSheet[], stages: SetupStage[] }
  readonly loader: Pick<Loader, 'readManifest' | 'readDeclaration' | 'serveLive' | 'endLive' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent: ReturnType<typeof vi.fn<InstallConsentPrompt>>
  readonly declined: DeclinedApps
  readonly blocked: ReturnType<typeof vi.fn<NonNullable<FirstVisitDeps['blocked']>>>
  /** What the loader was told to call when a served file turns out bad. */
  readonly badData: () => ((found: { differing: readonly string[], invalid?: string }) => void) | undefined
  readonly grantsAt: Record<string, string[]>
}

function harness (options: {
  origin?: string
  reads?: FirstManifest[]
  declarations?: FirstDeclaration[]
  declarationGate?: Promise<void>
  bundles?: FirstBundle[]
  answer?: boolean | 'dismissed'
  choices?: Array<'retry' | 'leave'>
  installed?: 'ok' | 'rejected'
  live?: boolean | 'throws'
} = {}): Harness {
  const origin = options.origin ?? VERIFIED
  const events: string[] = []
  const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
  const reads = [...(options.reads ?? [readOf(origin)])]
  const declarations = [...(options.declarations ?? [DECLARED])]
  const bundles = [...(options.bundles ?? [bundle(origin)])]
  const choices = [...(options.choices ?? ['leave'])]
  const stages: SetupStage[] = []
  const sheets: SetupSheet[] = []
  const grantsAt: Record<string, string[]> = {}
  let reported: ReturnType<Harness['badData']>
  const host = {
    stages,
    sheets,
    show: (stage: SetupStage) => { stages.push(stage); events.push(`show:${stage.kind}`) },
    sheet: async (sheet: SetupSheet) => { sheets.push(sheet); events.push(`sheet:${sheet.kind}`); return choices.shift() ?? 'leave' },
    enter: () => { events.push('enter') },
    plain: () => { events.push('plain') },
    end: () => { events.push('end') },
    tab: () => TAB
  }
  const noteGrants = async (at: string): Promise<void> => { grantsAt[at] = (await broker.app.grants(origin)).map((grant) => grant.capability) }
  const loader: Harness['loader'] = {
    pinFor: vi.fn(async () => null),
    readManifest: vi.fn(async () => { events.push('read'); return reads.length > 1 ? reads.shift() as FirstManifest : reads[0] as FirstManifest }),
    readDeclaration: vi.fn(async () => {
      events.push('declaration')
      await options.declarationGate
      return declarations.length > 1 ? declarations.shift() as FirstDeclaration : declarations[0] as FirstDeclaration
    }),
    serveLive: vi.fn(async (_read, _declaration, onBadData) => {
      events.push('serve-live')
      await noteGrants('serve-live')
      reported = onBadData
      if (options.live === 'throws') throw new Error('no partition')
      return options.live ?? true
    }),
    endLive: vi.fn(async () => { events.push('end-live') }),
    fetchForInstall: vi.fn(async () => {
      events.push('fetch')
      return bundles.shift() ?? bundle(origin)
    }),
    installFetched: vi.fn(async (installOrigin, manifest, tree) => {
      events.push('install')
      if (options.installed === 'rejected') return { outcome: 'rejected' as const, reason: 'disk' }
      return { outcome: 'installed' as const, canonicalOrigin: installOrigin, manifest, pin: { schema: 1 as const, origin: installOrigin, bundleHash: tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    })
  }
  const consent = vi.fn<InstallConsentPrompt>(async () => { events.push('ask'); await noteGrants('ask'); return options.answer ?? true })
  const blocked = vi.fn<NonNullable<FirstVisitDeps['blocked']>>(async () => { events.push('blocked-tabs') })
  return { origin, url: `${origin}/`, broker, events, host, loader, consent, declined: new DeclinedApps(), blocked, badData: () => reported, grantsAt }
}

const TAB = { id: 'the-tab' }

const present: DialogCaller = { window: () => undefined, stillOn: () => true }

function depsOf (h: Harness): FirstVisitDeps {
  return { broker: h.broker, loader: h.loader as Loader, consent: h.consent, declined: h.declined, blocked: h.blocked, backgroundDelayMs: 0 }
}

async function run (h: Harness, caller: DialogCaller | undefined = present, signal?: AbortSignal, backgroundDelayMs = 0): ReturnType<typeof runFirstVisit> {
  return await runFirstVisit({ ...depsOf(h), backgroundDelayMs }, h.origin, h.url, caller, h.host, signal)
}

/** The background pin waits long enough for a test to act before it begins. */
const LATE = 200

async function settled (result: Awaited<ReturnType<typeof run>>): Promise<string> {
  if (result.outcome !== 'entered') throw new Error(`not entered: ${result.outcome}`)
  return await result.background
}

const grantsOf = async (h: Harness): Promise<string[]> => (await h.broker.app.grants(h.origin)).map((grant) => grant.capability)

describe('runFirstVisit, for an app a verifier serves', () => {
  it('asks as soon as the manifest is read, with the declared tree read beside the question, and downloads nothing before the person is in', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    expect(result.outcome).toBe('entered')
    expect(h.events.slice(0, 6)).toEqual(['read', 'show:asking', 'declaration', 'ask', 'serve-live', 'enter'])
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(h.grantsAt['ask']).toEqual([])
    await settled(result)
  })

  it('does not hold the question for the declared tree', async () => {
    let release = (): void => {}
    const h = harness({ declarationGate: new Promise<void>((resolve) => { release = resolve }) })
    const answered = h.consent.mockImplementation(async () => { h.events.push('ask'); return true })
    const pending = run(h)
    await vi.waitFor(() => { expect(answered).toHaveBeenCalled() })
    expect(h.events).not.toContain('serve-live')
    release()
    await settled(await pending)
  })

  it('grants at once and enters at once: the app is served live, registered and granted before the tab goes in', async () => {
    const h = harness()
    const result = await run(h)
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(true)
    expect(await grantsOf(h)).toEqual(['fs'])
    expect(h.events.indexOf('serve-live')).toBeLessThan(h.events.indexOf('enter'))
    expect(h.grantsAt['serve-live']).toEqual([])
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBe(DECLARED.declaration)
    await settled(result)
  })

  it('serves a site that declares nothing live all the same, on Orivon\'s own checks', async () => {
    const h = harness({ declarations: [{ kind: 'none' }] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBeUndefined()
    await settled(result)
  })

  it('pins the whole app in the background, after the tab is in, and says so', async () => {
    const h = harness()
    const result = await run(h)
    expect(h.events.indexOf('enter')).toBeLessThan(h.events.indexOf('fetch'))
    expect(await settled(result)).toBe('pinned')
    expect(h.events.slice(-2)).toEqual(['fetch', 'install'])
    expect(h.loader.endLive).not.toHaveBeenCalled()
  })

  it('does not download an app another path already pinned', async () => {
    const h = harness()
    vi.mocked(h.loader.pinFor).mockResolvedValue({ schema: 1, origin: h.origin, bundleHash: TREE.root, assets: [], version: '1.0.0', pinnedAt: 0 })
    const result = await run(h)
    expect(await settled(result)).toBe('pinned')
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
  })

  it('on files in the background that differ from the declaration blocks the app: grants and registration gone, nothing pinned, the tabs covered', async () => {
    const mismatched = bundle(VERIFIED, { declaration: DIFFERENT, content: CONTENT })
    const h = harness({ bundles: [mismatched] })
    const result = await run(h)
    expect(await settled(result)).toBe('blocked')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(mismatched.discard).toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.endLive).toHaveBeenCalledWith(h.origin)
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', name: 'Test App', differing: ['/index.html'] }), TAB)
  })

  it('treats a verification the verifier failed in the background as the same block', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'block does not hash to its CID', integrity: true }] })
    expect(await settled(await run(h))).toBe('blocked')
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', invalid: 'block does not hash to its CID' }), TAB)
  })

  it('is silent about a background download that fails: nothing blocked, nothing shown, the grants stay for the next visit to finish', async () => {
    for (const failure of [{ reason: 'HTTP 404 (/app.js)' }, { reason: 'timed out' }, { reason: 'bad gateway', transient: true as const }, { reason: 'over its cap', tooLarge: true as const }]) {
      const h = harness({ bundles: [{ ok: false, ...failure }] })
      expect(await settled(await run(h)), failure.reason).toBe('unfinished')
      expect(h.blocked, failure.reason).not.toHaveBeenCalled()
      expect(h.host.sheets, failure.reason).toEqual([])
      expect(await grantsOf(h), failure.reason).toEqual(['fs'])
      expect(h.loader.endLive, failure.reason).not.toHaveBeenCalled()
    }
  })

  it('stays unfinished, and quiet, when the bundle could not be saved', async () => {
    const h = harness({ installed: 'rejected' })
    expect(await settled(await run(h))).toBe('unfinished')
    expect(h.blocked).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual(['fs'])
  })

  it('blocks when a served file turns out not to be the declared one, once, however many fail', async () => {
    const h = harness({ bundles: [bundle(VERIFIED)] })
    const result = await run(h, present, undefined, LATE)
    const report = h.badData()
    if (report === undefined) throw new Error('the loader was never told where to report')
    report({ differing: ['/app.js'] })
    report({ differing: ['/other.js'] })
    expect(await settled(result)).toBe('blocked')
    await vi.waitFor(() => { expect(h.loader.endLive).toHaveBeenCalledTimes(1) })
    expect(h.blocked).toHaveBeenCalledTimes(1)
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', differing: ['/app.js'], differingCount: 1 }), TAB)
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('names content the verifier proved is not what its address names, rather than a file', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    h.badData()?.({ differing: [], invalid: '/index.html is not what its address names' })
    await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalled() })
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', invalid: '/index.html is not what its address names' }), TAB)
    await settled(result)
  })

  it('does not pin what a block was raised over before the download began', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    h.badData()?.({ differing: ['/index.html'] })
    expect(await settled(result)).toBe('blocked')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('never enters a tab for a manifest the declared tree gives another leaf: the warning, no grant, no registration', async () => {
    const h = harness({ declarations: [{ kind: 'mismatch', differing: ['/.well-known/orivon.json'] }] })
    const result = await run(h)
    expect(result).toMatchObject({ outcome: 'blocked', differing: ['/.well-known/orivon.json'] })
    expect(h.events).toEqual(['read', 'show:asking', 'declaration', 'ask', 'sheet:blocked', 'end'])
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.host.sheets[0]).toMatchObject({ kind: 'blocked', differing: ['/.well-known/orivon.json'] })
  })

  it('still revokes what an earlier version of Orivon had granted to an origin it blocks', async () => {
    const h = harness({ declarations: [{ kind: 'mismatch', differing: ['/.well-known/orivon.json'] }] })
    await h.broker.grant(h.origin, 'fs', [])
    await run(h)
    expect(await grantsOf(h)).toEqual([])
  })

  it('never enters a tab for content the verifier failed while the tree was read', async () => {
    const h = harness({ declarations: [{ kind: 'failed', reason: 'block does not hash to its CID', integrity: true }] })
    expect(await run(h)).toMatchObject({ outcome: 'blocked' })
    expect(h.host.sheets[0]).toMatchObject({ kind: 'blocked', invalid: 'block does not hash to its CID' })
    expect(h.loader.serveLive).not.toHaveBeenCalled()
  })

  it('shows a retry sheet when the declared tree cannot be read, keeps the answer, and reads it again without asking again', async () => {
    const h = harness({ declarations: [{ kind: 'failed', reason: 'gateway 502' }, DECLARED], choices: ['retry'] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(h.events.slice(0, 8)).toEqual(['read', 'show:asking', 'declaration', 'ask', 'sheet:download-failed', 'declaration', 'show:verifying', 'serve-live'])
    expect(h.consent).toHaveBeenCalledTimes(1)
    expect(h.host.sheets[0]).toMatchObject({ kind: 'download-failed', name: 'Test App', reason: 'gateway 502' })
    await settled(result)
  })

  it('opens nothing and grants nothing when the person leaves the retry sheet', async () => {
    const h = harness({ declarations: [{ kind: 'failed', reason: 'gateway 502' }], choices: ['leave'] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.events.at(-1)).toBe('end')
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual([])
    expect(h.declined.has(h.origin)).toBe(false)
  })

  it('opens nothing and grants nothing when the app cannot be served live, rather than let an unchecked page in', async () => {
    for (const live of [false, 'throws'] as const) {
      const h = harness({ live })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await run(h), String(live)).toMatchObject({ outcome: 'failed' })
      expect(h.events, String(live)).not.toContain('enter')
      expect(h.broker.app.isRegisteredSync(h.origin), String(live)).toBe(false)
      expect(await grantsOf(h), String(live)).toEqual([])
    }
  })

  it('asks nothing of a manifest that declares nothing, and still checks every file as it is served', async () => {
    const empty: Manifest = { ...MANIFEST, capabilities: {} }
    const h = harness({ reads: [{ ...readOf(VERIFIED), manifest: empty } as FirstManifest], bundles: [bundle(VERIFIED, { manifest: empty })] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(h.consent).not.toHaveBeenCalled()
    expect(h.events.slice(0, 6)).toEqual(['read', 'show:asking', 'declaration', 'show:verifying', 'serve-live', 'enter'])
    await settled(result)
  })

  it('on a pressed Deny downloads nothing, grants nothing, serves nothing live, records the refusal and opens a plain website', async () => {
    const h = harness({ answer: false })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(h.events).toEqual(['read', 'show:asking', 'declaration', 'ask', 'plain'])
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(h.declined.has(h.origin)).toBe(true)
    expect(await h.broker.declinedCapabilitiesFor(h.origin)).toBeUndefined()
  })

  it('on Escape, a closed tab or a navigation records nothing: the next visit asks again', async () => {
    const h = harness({ answer: 'dismissed' })
    expect((await run(h)).outcome).toBe('left')
    expect(h.events).toEqual(['read', 'show:asking', 'declaration', 'ask', 'end'])
    expect(h.declined.has(h.origin)).toBe(false)
    expect(h.loader.serveLive).not.toHaveBeenCalled()
  })

  it('stops reading the declared tree when the visit ends without an app', async () => {
    const h = harness({ answer: 'dismissed' })
    await run(h)
    const signal = vi.mocked(h.loader.readDeclaration).mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(true)
  })

  it('does not enter a tab that left while the tree was being read after the answer, and grants nothing', async () => {
    let away = false
    let release = (): void => {}
    const h = harness({ declarationGate: new Promise<void>((resolve) => { release = resolve }) })
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => !away }
    const pending = run(h, leaving)
    await vi.waitFor(() => { expect(h.consent).toHaveBeenCalled() })
    away = true
    release()
    expect((await pending).outcome).toBe('left')
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual([])
  })

  it('does not enter a tab that left as the app was let in, though the app is granted and goes on to be pinned', async () => {
    const h = harness()
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => !h.events.includes('serve-live') }
    const result = await run(h, leaving)
    expect(result.outcome).toBe('entered')
    expect(h.events).not.toContain('enter')
    expect(h.events).toContain('end')
    expect(await grantsOf(h)).toEqual(['fs'])
    expect(await settled(result)).toBe('pinned')
  })

  it('bounds the first look at the address only', async () => {
    const h = harness()
    await settled(await run(h))
    expect(vi.mocked(h.loader.readManifest).mock.calls[0]).toEqual([h.url, MANIFEST_PROBE_MS])
  })

  it('opens a site that has no manifest as a plain website, asking nothing', async () => {
    const h = harness({ reads: [{ kind: 'website' }] })
    expect((await run(h)).outcome).toBe('plain')
    expect(h.events).toEqual(['read', 'plain'])
  })

  it('opens a site whose manifest could not be read in time as an ordinary page', async () => {
    const h = harness({ reads: [{ kind: 'unread', reason: 'gateway down' }] })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'unread' })
    expect(h.events).toEqual(['read', 'plain'])
  })

  it('refuses an origin the hinted address is not the origin of', async () => {
    const h = harness()
    const result = await runFirstVisit(depsOf(h), 'https://other.example', h.url, present, h.host)
    expect(result.outcome).toBe('rejected')
    expect(h.events).toEqual([])
  })
})

describe('runFirstVisit, for an app an ordinary website serves', () => {
  const site = (overrides: Parameters<typeof harness>[0] = {}): Harness => harness({ origin: WEBSITE, ...overrides })

  it('has no per-file check to make, so it enters at once and checks the whole bundle in the background', async () => {
    const h = site()
    const result = await run(h)
    expect(h.events.slice(0, 4)).toEqual(['read', 'show:asking', 'ask', 'enter'])
    expect(h.loader.readDeclaration).not.toHaveBeenCalled()
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual(['fs'])
    expect(await settled(result)).toBe('pinned')
  })

  it('blocks within the background download when the files differ from the declaration', async () => {
    const mismatched = bundle(WEBSITE, { declaration: DIFFERENT, content: CONTENT })
    const h = site({ bundles: [mismatched] })
    expect(await settled(await run(h))).toBe('blocked')
    expect(h.blocked).toHaveBeenCalledWith(WEBSITE, expect.objectContaining({ kind: 'blocked' }), TAB)
    expect(h.broker.app.isRegisteredSync(WEBSITE)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('looks a second time before calling it tampering, since a site may have been deployed meanwhile', async () => {
    const h = site({ bundles: [bundle(WEBSITE, { declaration: DIFFERENT }), bundle(WEBSITE)] })
    expect(await settled(await run(h))).toBe('pinned')
    expect(h.loader.fetchForInstall).toHaveBeenCalledTimes(2)
    const twice = site({ bundles: [bundle(WEBSITE, { declaration: DIFFERENT }), bundle(WEBSITE, { declaration: DIFFERENT })] })
    expect(await settled(await run(twice))).toBe('blocked')
    expect(twice.loader.fetchForInstall).toHaveBeenCalledTimes(2)
  })

  it('does not look twice at content a name or address proved, which cannot be redeployed under the same root', async () => {
    const h = site({ bundles: [bundle(WEBSITE, { declaration: DIFFERENT, content: CONTENT })] })
    await settled(await run(h))
    expect(h.loader.fetchForInstall).toHaveBeenCalledTimes(1)
  })
})

describe('createFirstVisit', () => {
  function over (h: Harness, overrides: Partial<{ untouched: (origin: string) => boolean, servedFromCache: (origin: string) => boolean }> = {}): ReturnType<typeof createFirstVisit> {
    return createFirstVisit({ deps: depsOf(h), untouched: () => false, servedFromCache: () => false, ...overrides })
  }

  it('calls an origin Orivon has never held a first visit, and one it holds known', async () => {
    const h = harness()
    const visit = over(h)
    expect(await visit.kindOf(h.origin)).toBe('first')
    await settled(await run(h))
    expect(await visit.kindOf(h.origin)).toBe('known')
  })

  it('calls an origin settling while its background pin runs, so a page\'s own hint does not start a second install', async () => {
    let release = (): void => {}
    const h = harness()
    vi.mocked(h.loader.fetchForInstall).mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return bundle(h.origin)
    })
    const visit = over(h)
    const result = await visit.run(h.origin, h.url, present, h.host)
    expect(result.outcome).toBe('entered')
    await vi.waitFor(() => { expect(h.loader.fetchForInstall).toHaveBeenCalled() })
    expect(await visit.kindOf(h.origin)).toBe('settling')
    release()
    await vi.waitFor(async () => { expect(await visit.kindOf(h.origin)).toBe('known') })
  })

  it('calls an origin the person pressed Deny for declined, and an origin they escaped from still a first visit', async () => {
    const denied = harness({ answer: false })
    await run(denied)
    expect(await over(denied).kindOf(denied.origin)).toBe('declined')
    const escaped = harness({ answer: 'dismissed' })
    await run(escaped)
    expect(await over(escaped).kindOf(escaped.origin)).toBe('first')
  })

  it('leaves local files, loopback and developer origins, and an origin served from its partition, alone', async () => {
    const h = harness()
    expect(await over(h, { untouched: () => true }).kindOf(h.origin)).toBe('known')
    expect(await over(h, { servedFromCache: () => true }).kindOf(h.origin)).toBe('known')
  })

  it('serialises two visits to one origin and asks once: the second finds the app known', async () => {
    const h = harness()
    const visit = over(h)
    const [first, second] = await Promise.all([visit.run(h.origin, h.url, present, h.host), visit.run(h.origin, h.url, present, h.host)])
    expect(first.outcome).toBe('entered')
    expect(['known', 'settling']).toContain(second.outcome)
    expect(h.consent).toHaveBeenCalledTimes(1)
  })

  it('tells a second visit that the first was answered no', async () => {
    const h = harness({ answer: false })
    const visit = over(h)
    const [first, second] = await Promise.all([visit.run(h.origin, h.url, present, h.host), visit.run(h.origin, h.url, present, h.host)])
    expect(first).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(second.outcome).toBe('declined')
  })

  it('does not remember a block: the next visit is a first visit again, and asks again', async () => {
    const h = harness({ bundles: [bundle(VERIFIED, { declaration: DIFFERENT, content: CONTENT })] })
    const visit = over(h)
    const first = await visit.run(h.origin, h.url, present, h.host)
    if (first.outcome !== 'entered') throw new Error('expected an entry')
    expect(await first.background).toBe('blocked')
    await vi.waitFor(async () => { expect(await visit.kindOf(h.origin)).toBe('first') })
  })
})
