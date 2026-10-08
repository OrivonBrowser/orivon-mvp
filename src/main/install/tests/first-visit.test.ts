import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
import type { Manifest } from '../../../contracts/index.js'
import type { FirstBundle, FirstManifest, Loader } from '../../../loader/index.js'
import type { InstallConsentPrompt } from '../../consent/install-consent.js'
import type { DialogCaller } from '../../consent/request-grant.js'
import { createFirstVisit, runFirstVisit } from '../first-visit.js'
import type { SetupHost, SetupSheet, SetupStage } from '../first-visit.js'

// ADR-0074's order: the question comes before any file, the files are checked before the page is
// entered, a mismatch removes every grant, a failed download keeps them, and a no is a plain website.

const ORIGIN = 'https://abc.ipfs.orivon'
const URL_ = `${ORIGIN}/`
const leaf = (character: string): string => `sha256:${character.repeat(64)}`
const MANIFEST: Manifest = { orivonApiVersion: 0, id: 'app.test', name: 'Test App', version: '1.0.0', entry: 'index.html', capabilities: { fs: { quotaBytes: 1024 } } }
const TREE = { root: leaf('r'), assets: [{ path: '/index.html', leaf: leaf('a') }] }

const READ: FirstManifest = { kind: 'app', canonicalOrigin: ORIGIN, manifest: MANIFEST, bytes: new Uint8Array([1]), content: undefined }

function bundle (overrides: Partial<Extract<FirstBundle, { ok: true }>> = {}): FirstBundle {
  return { ok: true, canonicalOrigin: ORIGIN, manifest: MANIFEST, tree: TREE, entries: [], declaration: undefined, content: undefined, discard: vi.fn(async () => {}), ...overrides }
}

interface Harness {
  readonly broker: ReturnType<typeof createBroker>
  readonly events: string[]
  readonly host: SetupHost & { sheets: SetupSheet[], stages: SetupStage[] }
  readonly loader: Pick<Loader, 'readManifest' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent: InstallConsentPrompt
}

function harness (options: {
  read?: FirstManifest
  bundles?: FirstBundle[]
  answer?: boolean
  choices?: Array<'retry' | 'leave'>
  installed?: 'ok' | 'rejected'
  manifest?: Manifest
} = {}): Harness {
  const events: string[] = []
  const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
  const bundles = [...(options.bundles ?? [bundle()])]
  const choices = [...(options.choices ?? ['leave'])]
  const stages: SetupStage[] = []
  const sheets: SetupSheet[] = []
  const host = {
    stages,
    sheets,
    show: (stage: SetupStage) => { stages.push(stage); events.push(`show:${stage.kind}`) },
    sheet: async (sheet: SetupSheet) => { sheets.push(sheet); events.push(`sheet:${sheet.kind}`); return choices.shift() ?? 'leave' },
    enter: () => { events.push('enter') },
    plain: () => { events.push('plain') },
    end: () => { events.push('end') }
  }
  const loader: Harness['loader'] = {
    pinFor: vi.fn(async () => null),
    readManifest: vi.fn(async () => { events.push('read'); return options.read ?? READ }),
    fetchForInstall: vi.fn(async () => { events.push('fetch'); return bundles.shift() ?? bundle() }),
    installFetched: vi.fn(async (origin, manifest, tree) => {
      events.push('install')
      if (options.installed === 'rejected') return { outcome: 'rejected' as const, reason: 'disk' }
      return { outcome: 'installed' as const, canonicalOrigin: origin, manifest, pin: { schema: 1, origin, bundleHash: tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    })
  }
  const consent: InstallConsentPrompt = vi.fn(async () => { events.push('ask'); return options.answer ?? true })
  return { broker, events, host, loader, consent }
}

const present: DialogCaller = { window: () => undefined, stillOn: () => true }

async function run (h: Harness, caller: DialogCaller | undefined = present): ReturnType<typeof runFirstVisit> {
  return await runFirstVisit({ broker: h.broker, loader: h.loader as Loader, consent: h.consent }, ORIGIN, URL_, caller, h.host)
}

describe('runFirstVisit', () => {
  it('asks before any file is downloaded, verifies before it installs, and enters last', async () => {
    const h = harness()
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'install', 'enter'])
    expect(h.host.stages.map((stage) => stage.name)).toEqual(['Test App', 'Test App'])
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(true)
    expect((await h.broker.app.grants(ORIGIN)).map((grant) => grant.capability)).toEqual(['fs'])
  })

  it('opens a site that has no manifest as a plain website, asking nothing', async () => {
    const h = harness({ read: { kind: 'website' } })
    expect((await run(h)).outcome).toBe('plain')
    expect(h.events).toEqual(['read', 'plain'])
  })

  it('opens a site whose manifest could not be read as a plain website', async () => {
    const h = harness({ read: { kind: 'unread', reason: 'gateway down' } })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'unread' })
    expect(h.events).toEqual(['read', 'plain'])
  })

  it('on Deny downloads nothing, installs nothing, remembers the no and opens a plain website', async () => {
    const h = harness({ answer: false })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'plain'])
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(false)
    expect(await h.broker.declinedCapabilitiesFor(ORIGIN)).toEqual(['fs'])
  })

  it('on files that differ from the declaration never installs, revokes every grant and shows the warning', async () => {
    const declaration = { bundleHash: TREE.root, leaves: [{ path: '/index.html', leaf: leaf('z') }] }
    const mismatched = bundle({ declaration })
    const h = harness({ bundles: [mismatched] })
    const result = await run(h)
    expect(result).toMatchObject({ outcome: 'blocked', differing: ['/index.html'] })
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'sheet:blocked', 'end'])
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(false)
    expect(await h.broker.app.grants(ORIGIN)).toEqual([])
    expect(h.host.sheets[0]).toMatchObject({ kind: 'blocked', name: 'Test App', differing: ['/index.html'] })
    expect((mismatched as Extract<FirstBundle, { ok: true }>).discard).toHaveBeenCalled()
  })

  it('a block is not remembered: the next visit asks again', async () => {
    const mismatched = bundle({ declaration: { bundleHash: leaf('q'), leaves: TREE.assets } })
    const first = harness({ bundles: [mismatched] })
    await run(first)
    expect(await first.broker.declinedCapabilitiesFor(ORIGIN)).toBeUndefined()
  })

  it('enters when the site publishes a tree and the files match it', async () => {
    const h = harness({ bundles: [bundle({ declaration: { bundleHash: TREE.root, leaves: TREE.assets } })] })
    expect((await run(h)).outcome).toBe('entered')
  })

  it('on a download failure keeps the grants, shows Try again, and a retry downloads again without asking again', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'gateway 502' }, bundle()], choices: ['retry'] })
    expect((await run(h)).outcome).toBe('entered')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'sheet:download-failed', 'read', 'show:asking', 'show:verifying', 'fetch', 'install', 'enter'])
    expect(h.consent).toHaveBeenCalledTimes(1)
    expect(h.host.sheets[0]).toMatchObject({ kind: 'download-failed', name: 'Test App', reason: 'gateway 502' })
    expect((await h.broker.app.grants(ORIGIN)).map((grant) => grant.capability)).toEqual(['fs'])
  })

  it('when the person leaves a failed download, grants stay, nothing is installed and no warning is shown', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'gateway 502' }], choices: ['leave'] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.events.at(-1)).toBe('end')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.host.sheets.map((sheet) => sheet.kind)).toEqual(['download-failed'])
    expect((await h.broker.app.grants(ORIGIN)).map((grant) => grant.capability)).toEqual(['fs'])
  })

  it('treats a bundle that could not be saved like a download that failed', async () => {
    const h = harness({ installed: 'rejected' })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.host.sheets[0]).toMatchObject({ kind: 'download-failed' })
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(false)
  })

  it('asks nothing of a manifest that declares nothing, and still verifies before entering', async () => {
    const empty: Manifest = { ...MANIFEST, capabilities: {} }
    const h = harness({ read: { ...READ, manifest: empty }, bundles: [bundle({ manifest: empty })] })
    expect((await run(h)).outcome).toBe('entered')
    expect(h.consent).not.toHaveBeenCalled()
    expect(h.events).toEqual(['read', 'show:asking', 'show:verifying', 'fetch', 'install', 'enter'])
  })

  it('stops quietly when the person left while the question was open', async () => {
    const h = harness()
    const away: DialogCaller = { window: () => undefined, stillOn: () => false }
    expect((await run(h, away)).outcome).toBe('left')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'end'])
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
  })

  it('discards what it downloaded when the person left during the download', async () => {
    const downloaded = bundle()
    let calls = 0
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => { calls += 1; return calls < 2 } }
    const h = harness({ bundles: [downloaded] })
    expect((await run(h, leaving)).outcome).toBe('left')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect((downloaded as Extract<FirstBundle, { ok: true }>).discard).toHaveBeenCalled()
  })

  it('refuses an origin the hinted address is not the origin of', async () => {
    const h = harness()
    const result = await runFirstVisit({ broker: h.broker, loader: h.loader as Loader, consent: h.consent }, 'https://other.example', URL_, present, h.host)
    expect(result.outcome).toBe('rejected')
    expect(h.events).toEqual([])
  })
})

describe('createFirstVisit', () => {
  function over (h: Harness, overrides: Partial<{ untouched: (origin: string) => boolean, servedFromCache: (origin: string) => boolean }> = {}): ReturnType<typeof createFirstVisit> {
    return createFirstVisit({ deps: { broker: h.broker, loader: h.loader as Loader, consent: h.consent }, untouched: () => false, servedFromCache: () => false, ...overrides })
  }

  it('calls an origin Orivon has never held a first visit, and one it holds known', async () => {
    const h = harness()
    const visit = over(h)
    expect(await visit.kindOf(ORIGIN)).toBe('first')
    await run(h)
    expect(await visit.kindOf(ORIGIN)).toBe('known')
  })

  it('calls an origin the person said no to declined', async () => {
    const h = harness({ answer: false })
    await run(h)
    expect(await over(h).kindOf(ORIGIN)).toBe('declined')
  })

  it('leaves local files, loopback and developer origins, and an origin served from the cache, alone', async () => {
    const h = harness()
    expect(await over(h, { untouched: () => true }).kindOf(ORIGIN)).toBe('known')
    expect(await over(h, { servedFromCache: () => true }).kindOf(ORIGIN)).toBe('known')
  })

  it('serialises two visits to one origin and asks once: the second finds the app known', async () => {
    const h = harness()
    const visit = over(h)
    const [first, second] = await Promise.all([visit.run(ORIGIN, URL_, present, h.host), visit.run(ORIGIN, URL_, present, h.host)])
    expect(first.outcome).toBe('entered')
    expect(second.outcome).toBe('known')
    expect(h.consent).toHaveBeenCalledTimes(1)
  })

  it('tells a second visit that the first was answered no', async () => {
    const h = harness({ answer: false })
    const visit = over(h)
    const [first, second] = await Promise.all([visit.run(ORIGIN, URL_, present, h.host), visit.run(ORIGIN, URL_, present, h.host)])
    expect(first).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(second.outcome).toBe('declined')
  })
})
