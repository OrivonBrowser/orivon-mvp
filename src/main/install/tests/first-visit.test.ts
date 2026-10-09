import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
import type { Manifest } from '../../../contracts/index.js'
import type { FirstBundle, FirstManifest, Loader } from '../../../loader/index.js'
import type { InstallConsentPrompt } from '../../consent/install-consent.js'
import type { DialogCaller } from '../../consent/request-grant.js'
import { DeclinedApps } from '../declined-apps.js'
import { createFirstVisit, MANIFEST_PROBE_MS, runFirstVisit } from '../first-visit.js'
import type { SetupHost, SetupSheet, SetupStage } from '../first-visit.js'

// ADR-0074's order: the question comes before any file, nothing is granted until the files are checked, a
// mismatch is never entered, a failed download keeps the answer for Try again, and only Deny is a no.

const ORIGIN = 'https://abc.ipfs.orivon'
const URL_ = `${ORIGIN}/`
const leaf = (character: string): string => `sha256:${character.repeat(64)}`
const MANIFEST: Manifest = { orivonApiVersion: 0, id: 'app.test', name: 'Test App', version: '1.0.0', entry: 'index.html', capabilities: { fs: { quotaBytes: 1024 } } }
const TREE = { root: leaf('r'), assets: [{ path: '/index.html', leaf: leaf('a') }] }
const CONTENT = { cid: 'bafy', via: 'ipfs' as const, pointersVerified: true }

const READ: FirstManifest = { kind: 'app', canonicalOrigin: ORIGIN, manifest: MANIFEST, bytes: new Uint8Array([1]), content: undefined }

type Fetched = Extract<FirstBundle, { ok: true }>

function bundle (overrides: Partial<Fetched> = {}): Fetched {
  return { ok: true, canonicalOrigin: ORIGIN, manifest: MANIFEST, tree: TREE, entries: [], declaration: undefined, content: undefined, discard: vi.fn(async () => {}), ...overrides }
}

const MISMATCH = { bundleHash: TREE.root, leaves: [{ path: '/index.html', leaf: leaf('z') }] }

interface Harness {
  readonly broker: ReturnType<typeof createBroker>
  readonly events: string[]
  readonly host: SetupHost & { sheets: SetupSheet[], stages: SetupStage[] }
  readonly loader: Pick<Loader, 'readManifest' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent: ReturnType<typeof vi.fn<InstallConsentPrompt>>
  readonly declined: DeclinedApps
  readonly grantsAtFetch: string[][]
}

function harness (options: {
  reads?: FirstManifest[]
  bundles?: FirstBundle[]
  answer?: boolean | 'dismissed'
  choices?: Array<'retry' | 'leave'>
  installed?: 'ok' | 'rejected'
} = {}): Harness {
  const events: string[] = []
  const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
  const reads = [...(options.reads ?? [READ])]
  const bundles = [...(options.bundles ?? [bundle()])]
  const choices = [...(options.choices ?? ['leave'])]
  const stages: SetupStage[] = []
  const sheets: SetupSheet[] = []
  const grantsAtFetch: string[][] = []
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
    readManifest: vi.fn(async () => { events.push('read'); return reads.length > 1 ? reads.shift() as FirstManifest : reads[0] as FirstManifest }),
    fetchForInstall: vi.fn(async () => {
      events.push('fetch')
      grantsAtFetch.push((await broker.app.grants(ORIGIN)).map((grant) => grant.capability))
      return bundles.shift() ?? bundle()
    }),
    installFetched: vi.fn(async (origin, manifest, tree) => {
      events.push('install')
      if (options.installed === 'rejected') return { outcome: 'rejected' as const, reason: 'disk' }
      return { outcome: 'installed' as const, canonicalOrigin: origin, manifest, pin: { schema: 1 as const, origin, bundleHash: tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    })
  }
  const consent = vi.fn<InstallConsentPrompt>(async () => { events.push('ask'); return options.answer ?? true })
  return { broker, events, host, loader, consent, declined: new DeclinedApps(), grantsAtFetch }
}

const present: DialogCaller = { window: () => undefined, stillOn: () => true }

async function run (h: Harness, caller: DialogCaller | undefined = present, signal?: AbortSignal): ReturnType<typeof runFirstVisit> {
  return await runFirstVisit({ broker: h.broker, loader: h.loader as Loader, consent: h.consent, declined: h.declined }, ORIGIN, URL_, caller, h.host, signal)
}

const grantsOf = async (h: Harness): Promise<string[]> => (await h.broker.app.grants(ORIGIN)).map((grant) => grant.capability)

describe('runFirstVisit', () => {
  it('asks before any file is downloaded, grants nothing until the files are checked, and enters last', async () => {
    const h = harness()
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'install', 'enter'])
    expect(h.grantsAtFetch).toEqual([[]])
    expect(h.host.stages.map((stage) => stage.name)).toEqual(['Test App', 'Test App'])
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(true)
    expect(await grantsOf(h)).toEqual(['fs'])
  })

  it('bounds the first look at the address, and not the reads after the person has answered', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'down' }, bundle()], choices: ['retry'] })
    await run(h)
    const calls = vi.mocked(h.loader.readManifest).mock.calls
    expect(calls[0]).toEqual([URL_, MANIFEST_PROBE_MS])
    expect(calls[1]).toEqual([URL_, undefined])
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

  it('on a pressed Deny downloads nothing, grants nothing, records the refusal for the site and opens a plain website', async () => {
    const h = harness({ answer: false })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'plain'])
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(false)
    expect(h.declined.has(ORIGIN)).toBe(true)
    expect(await h.broker.declinedCapabilitiesFor(ORIGIN)).toBeUndefined()
  })

  it('on Escape, a closed tab or a navigation records nothing: the next visit asks again', async () => {
    const h = harness({ answer: 'dismissed' })
    expect((await run(h)).outcome).toBe('left')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'end'])
    expect(h.declined.has(ORIGIN)).toBe(false)
    expect(await h.broker.declinedCapabilitiesFor(ORIGIN)).toBeUndefined()
  })

  it('on files that differ from the declaration never installs, grants nothing, and shows the warning', async () => {
    const mismatched = bundle({ declaration: MISMATCH, content: CONTENT })
    const h = harness({ bundles: [mismatched] })
    const result = await run(h)
    expect(result).toMatchObject({ outcome: 'blocked', differing: ['/index.html'] })
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'sheet:blocked', 'end'])
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.host.sheets[0]).toMatchObject({ kind: 'blocked', name: 'Test App', differing: ['/index.html'] })
    expect(mismatched.discard).toHaveBeenCalled()
  })

  it('still revokes what an earlier version of Orivon had granted to a blocked origin', async () => {
    const h = harness({ bundles: [bundle({ declaration: MISMATCH, content: CONTENT })] })
    await h.broker.grant(ORIGIN, 'fs', [])
    await run(h)
    expect(await grantsOf(h)).toEqual([])
  })

  it('looks a second time at an https site before calling it tampering, since it may have been deployed meanwhile', async () => {
    const h = harness({ bundles: [bundle({ declaration: MISMATCH }), bundle()] })
    expect((await run(h)).outcome).toBe('entered')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'read', 'show:verifying', 'fetch', 'install', 'enter'])
    expect(h.consent).toHaveBeenCalledTimes(1)
    const twice = harness({ bundles: [bundle({ declaration: MISMATCH }), bundle({ declaration: MISMATCH })] })
    expect(await run(twice)).toMatchObject({ outcome: 'blocked' })
    expect(twice.loader.fetchForInstall).toHaveBeenCalledTimes(2)
  })

  it('does not look twice at content a name or address proved, which cannot be redeployed under the same root', async () => {
    const h = harness({ bundles: [bundle({ declaration: MISMATCH, content: CONTENT })] })
    await run(h)
    expect(h.loader.fetchForInstall).toHaveBeenCalledTimes(1)
  })

  it('treats a verification the verifier failed as a block, and any other failure of the files as a download', async () => {
    const integrity = harness({ bundles: [{ ok: false, reason: 'block does not hash to its CID', integrity: true }] })
    expect(await run(integrity)).toMatchObject({ outcome: 'blocked' })
    expect(integrity.host.sheets[0]).toMatchObject({ kind: 'blocked', invalid: 'block does not hash to its CID' })
    for (const failure of [{ reason: 'HTTP 404 (/app.js)' }, { reason: 'timed out' }, { reason: 'HTTP 403' }, { reason: 'the HTML page' }, { reason: 'bad gateway', transient: true as const }]) {
      const h = harness({ bundles: [{ ok: false, ...failure }], choices: ['leave'] })
      expect(await run(h), failure.reason).toMatchObject({ outcome: 'failed' })
      expect(h.host.sheets.map((sheet) => sheet.kind), failure.reason).toEqual(['download-failed'])
    }
  })

  it('says plainly that an app is too large, with no Try again and no warning', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'over its cap', tooLarge: true }] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.host.sheets).toEqual([{ kind: 'too-large', name: 'Test App' }])
    expect(await grantsOf(h)).toEqual([])
  })

  it('on a failed download keeps the answer for Try again, which downloads again without asking again', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'gateway 502', transient: true }, bundle()], choices: ['retry'] })
    expect((await run(h)).outcome).toBe('entered')
    expect(h.events).toEqual(['read', 'show:asking', 'ask', 'show:verifying', 'fetch', 'sheet:download-failed', 'read', 'show:verifying', 'fetch', 'install', 'enter'])
    expect(h.consent).toHaveBeenCalledTimes(1)
    expect(h.host.sheets[0]).toMatchObject({ kind: 'download-failed', name: 'Test App', reason: 'gateway 502' })
    expect(await grantsOf(h)).toEqual(['fs'])
  })

  it('asks again on Try again when the manifest now asks for more than the person was shown', async () => {
    const wider: Manifest = { ...MANIFEST, capabilities: { fs: { quotaBytes: 2048 } } }
    const h = harness({ reads: [READ, { ...READ, manifest: wider }], bundles: [{ ok: false, reason: 'down' }, bundle({ manifest: wider })], choices: ['retry'] })
    await run(h)
    expect(h.consent).toHaveBeenCalledTimes(2)
  })

  it('when the person leaves a failed download nothing is granted, installed or recorded', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'gateway 502', transient: true }], choices: ['leave'] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.events.at(-1)).toBe('end')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.host.sheets.map((sheet) => sheet.kind)).toEqual(['download-failed'])
    expect(await grantsOf(h)).toEqual([])
    expect(h.declined.has(ORIGIN)).toBe(false)
  })

  it('shows the retry sheet when the manifest cannot be read again after the person answered', async () => {
    const h = harness({ reads: [READ, { kind: 'unread', reason: 'gateway down' }], bundles: [{ ok: false, reason: 'down' }, bundle()], choices: ['retry', 'leave'] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.host.sheets.map((sheet) => sheet.kind)).toEqual(['download-failed', 'download-failed'])
  })

  it('treats a bundle that could not be saved like a download that failed', async () => {
    const h = harness({ installed: 'rejected' })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.host.sheets[0]).toMatchObject({ kind: 'download-failed' })
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
  })

  it('asks nothing of a manifest that declares nothing, and still verifies before entering', async () => {
    const empty: Manifest = { ...MANIFEST, capabilities: {} }
    const h = harness({ reads: [{ ...READ, manifest: empty }], bundles: [bundle({ manifest: empty })] })
    expect((await run(h)).outcome).toBe('entered')
    expect(h.consent).not.toHaveBeenCalled()
    expect(h.events).toEqual(['read', 'show:asking', 'show:verifying', 'fetch', 'install', 'enter'])
  })

  it('stops quietly when the person left while the question was open', async () => {
    const h = harness()
    const away: DialogCaller = { window: () => undefined, stillOn: () => false }
    expect((await run(h, away)).outcome).toBe('left')
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(h.declined.has(ORIGIN)).toBe(false)
  })

  it('discards what it downloaded when the person left during the download', async () => {
    const downloaded = bundle()
    const h = harness({ bundles: [downloaded] })
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => !h.events.includes('fetch') }
    expect((await run(h, leaving)).outcome).toBe('left')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(downloaded.discard).toHaveBeenCalled()
  })

  it('hands the download a signal, and gives up quietly when it is aborted', async () => {
    const controller = new AbortController()
    const h = harness()
    vi.mocked(h.loader.fetchForInstall).mockImplementationOnce(async (_read, _url, signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      return { ok: false, reason: 'aborted' }
    })
    expect((await run(h, present, controller.signal)).outcome).toBe('left')
    expect(h.host.sheets).toEqual([])
  })

  it('does not enter a tab that left while the files were being saved, though the app is installed and granted', async () => {
    const h = harness()
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => !h.events.includes('install') }
    expect((await run(h, leaving)).outcome).toBe('left')
    expect(h.events).not.toContain('enter')
    expect(h.broker.app.isRegisteredSync(ORIGIN)).toBe(true)
    expect(await grantsOf(h)).toEqual(['fs'])
  })

  it('refuses an origin the hinted address is not the origin of', async () => {
    const h = harness()
    const result = await runFirstVisit({ broker: h.broker, loader: h.loader as Loader, consent: h.consent, declined: h.declined }, 'https://other.example', URL_, present, h.host)
    expect(result.outcome).toBe('rejected')
    expect(h.events).toEqual([])
  })
})

describe('createFirstVisit', () => {
  function over (h: Harness, overrides: Partial<{ untouched: (origin: string) => boolean, servedFromCache: (origin: string) => boolean }> = {}): ReturnType<typeof createFirstVisit> {
    return createFirstVisit({ deps: { broker: h.broker, loader: h.loader as Loader, consent: h.consent, declined: h.declined }, untouched: () => false, servedFromCache: () => false, ...overrides })
  }

  it('calls an origin Orivon has never held a first visit, and one it holds known', async () => {
    const h = harness()
    const visit = over(h)
    expect(await visit.kindOf(ORIGIN)).toBe('first')
    await run(h)
    expect(await visit.kindOf(ORIGIN)).toBe('known')
  })

  it('calls an origin the person pressed Deny for declined, and an origin they escaped from still a first visit', async () => {
    const denied = harness({ answer: false })
    await run(denied)
    expect(await over(denied).kindOf(ORIGIN)).toBe('declined')
    const escaped = harness({ answer: 'dismissed' })
    await run(escaped)
    expect(await over(escaped).kindOf(ORIGIN)).toBe('first')
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
