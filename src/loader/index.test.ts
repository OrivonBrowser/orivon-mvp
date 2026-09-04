import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appRootDirectoryName, createLoader } from './index.js'
import type { LoadContext } from './index.js'
import { nodeLoaderStorage } from './node-storage.js'
import { MANIFEST_URL, ORIGIN, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', rollbackAcknowledged: false }

function fixedNow (value = 1_700_000_000_000): () => number {
  return () => value
}

// This suite is organised around the FIVE outcomes acceptance criterion 1
// names (installed / needs-reconsent / needs-capability-prompt /
// needs-rollback-choice / rejected -- needs-rollback-choice added
// 2026-09-04, the T19 policy reversal from a silent block to a warned
// choice), and separately around criterion 4 -- decideUpdate() must see the
// GRANTED pattern set, never the manifest's declared one (A18/A27's own
// failure class, named explicitly in this lane's brief).

describe('createLoader: fresh install (TOFU, ADR-0005)', () => {
  it('installs silently and persists the pin plus every asset', async () => {
    const storage = memoryStorage()
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    if (result.outcome !== 'installed') return
    expect(result.canonicalOrigin).toBe(ORIGIN)
    expect(result.pin.origin).toBe(ORIGIN)
    expect(result.pin.version).toBe('1.0.0')
    expect(result.pin.pinnedAt).toBe(1_700_000_000_000)

    expect(storage.pins.has(ORIGIN)).toBe(true)
    const written = storage.assets.get(ORIGIN)
    expect(written?.has('/.well-known/orivon.json')).toBe(true)
    expect(written?.has('/index.html')).toBe(true)
  })

  it('never prunes: no earlier pin means nothing a previous bundle could have left behind', async () => {
    const storage = memoryStorage()
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })

    await loader.load(ORIGIN, NO_GRANTS)

    expect(storage.pruneAssets).not.toHaveBeenCalled()
    expect(storage.pins.has(ORIGIN)).toBe(true)
  })

  // A raw node:fs message carries the absolute host path it failed on.
  // policy/paths.ts's CONFINEMENT_ERROR_CODE states the rule this follows:
  // a path oracle lets whatever holds this string map the host filesystem
  // one probe at a time, so the detail goes to the log and never into a
  // value returned across the boundary.
  it('a storage failure\'s reason names no host filesystem path -- the real error goes to the log instead', async () => {
    const hostPath = '/home/someone/.config/Orivon/apps/deadbeef/code/index.html'
    const base = memoryStorage()
    const storage = {
      ...base,
      writeAsset: vi.fn(async (): Promise<void> => { throw new Error(`EACCES: permission denied, open '${hostPath}'`) })
    }
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await loader.load(ORIGIN, NO_GRANTS)
    const loggedText = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    logged.mockRestore()

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.reason).not.toContain(hostPath)
    expect(result.reason).not.toContain('/home/')
    // Not merely swallowed: the full error is still recoverable locally.
    expect(loggedText).toContain(hostPath)
  })

  it('a rejected fetch (malformed manifest, oversized asset, missing entry, ...) surfaces as outcome "rejected" and writes nothing', async () => {
    const storage = memoryStorage()
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8('{not json') } }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('rejected')
    expect(storage.pins.size).toBe(0)
    expect(storage.assets.size).toBe(0)
  })
})

describe('createLoader: refetch against an existing pin', () => {
  async function install (storage: ReturnType<typeof memoryStorage>): Promise<void> {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const result = await loader.load(ORIGIN, NO_GRANTS)
    if (result.outcome !== 'installed') throw new Error('fixture setup failed')
  }

  it('calls pruneAssets with the new bundle\'s own paths, after every writeAsset and before writePin', async () => {
    const storage = memoryStorage()
    await install(storage)
    vi.clearAllMocks() // only the refetch's own calls, not the install fixture's

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000) })

    await loader.load(ORIGIN, NO_GRANTS)

    expect(storage.pruneAssets).toHaveBeenCalledWith(ORIGIN, ['/.well-known/orivon.json', '/index.html'])
    // Ordering matters, not just occurrence: pruneAssets must see every asset
    // this install just wrote (or it would delete one), and writePin must
    // not run until pruning is done (docs/open-questions.md A58 gap 2's own
    // reasoning for why install() calls these in this order).
    const order = (fn: unknown): number => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!
    const lastWriteAssetCall = Math.max(...(storage.writeAsset as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder)
    expect(lastWriteAssetCall).toBeLessThan(order(storage.pruneAssets))
    expect(order(storage.pruneAssets)).toBeLessThan(order(storage.writePin))
  })

  it('a storage failure while pruning old assets surfaces as outcome "rejected", never an uncaught throw', async () => {
    const base = memoryStorage()
    await install(base)
    vi.clearAllMocks()
    const storage = { ...base, pruneAssets: vi.fn(async (): Promise<void> => { throw new Error('disk full') }) }
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await loader.load(ORIGIN, NO_GRANTS)
    logged.mockRestore()

    expect(result.outcome).toBe('rejected')
    // A failed prune must not re-pin: the assets of the refetch are already
    // written, and a pin naming them while the prune left the previous
    // version's files in place is a record the disk does not back.
    expect(base.writePin).not.toHaveBeenCalled()
  })

  it('an unchanged bundle, still within the granted patterns, installs silently again', async () => {
    const storage = memoryStorage()
    await install(storage)
    const writeAssetCallsBefore = (storage.writeAsset as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000) })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    // Re-affirmed, not skipped -- but this is a real, if redundant, write:
    // more calls than before the refetch.
    const writeAssetCallsAfter = (storage.writeAsset as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    expect(writeAssetCallsAfter).toBeGreaterThan(writeAssetCallsBefore)
  })

  it('changed bytes (same authority) -> needs-reconsent, and nothing is persisted', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><!-- changed --> ') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const before = storage.pins.get(ORIGIN)
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('needs-reconsent')
    expect(storage.pins.get(ORIGIN)).toBe(before) // untouched
  })

  it('a manifest requesting a wider pattern set -> needs-capability-prompt, driven by the GRANTED set, not the declared one (A18/A27)', async () => {
    const storage = memoryStorage()
    // Install a version that declares (and by extension, per this fixture,
    // is granted) a NARROW connect pattern.
    const narrowRoutes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const narrowLoader = createLoader({ fetch: stubFetch(narrowRoutes), storage, now: fixedNow() })
    await narrowLoader.load(ORIGIN, NO_GRANTS)

    // The user actually granted exactly that narrow pattern -- this is the
    // GRANTED set decideUpdate must be checked against.
    const granted: LoadContext = {
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
      versionFloor: '0.0.0',
      rollbackAcknowledged: false
    }

    // The new manifest declares "*:*" -- strictly wider than what was
    // granted. If this were checked against the manifest's OWN declared set
    // instead of the granted one, a caller could construct a scenario where
    // a widened declaration is confused for authority already held; the
    // correct, load-bearing comparison is against `granted`.
    const wideRoutes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '1.0.1', capabilities: { net: { tcp: { connect: ['*:*'] } } } })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const wideLoader = createLoader({ fetch: stubFetch(wideRoutes), storage, now: fixedNow() })
    const result = await wideLoader.load(ORIGIN, granted)

    expect(result.outcome).toBe('needs-capability-prompt')
    if (result.outcome !== 'needs-capability-prompt') return
    expect(result.requestedPatterns['tcp.connect']).toEqual(['*:*'])
  })

  it('a version below the version floor, never acknowledged -> needs-rollback-choice, and nothing is persisted (T19, 2026-09-04)', async () => {
    const storage = memoryStorage()
    await install(storage)

    // The entry route must resolve, same as every other case in this
    // describe block -- fetchBundle() always fetches `entry` now (ADR-0011),
    // so an unrouted `/index.html` would reject on the fetch itself and
    // never reach decideUpdate() at all, proving nothing about the floor.
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.9.0' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const before = storage.pins.get(ORIGIN)
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0', rollbackAcknowledged: false })

    expect(result.outcome).toBe('needs-rollback-choice')
    if (result.outcome !== 'needs-rollback-choice') return
    expect(result.versionFloor).toBe('1.0.0')
    expect(result.manifest.version).toBe('0.9.0')
    expect(storage.pins.get(ORIGIN)).toBe(before) // untouched, same as needs-reconsent/needs-capability-prompt
  })

  it('a version below the version floor, already acknowledged for this origin -> installed with a rollback notice, no choice required', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.9.0' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000) })
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0', rollbackAcknowledged: true })

    expect(result.outcome).toBe('installed')
    if (result.outcome !== 'installed') return
    expect(result.pin.version).toBe('0.9.0')
    expect(result.rollbackNotice).toBe(true)
  })

  it('an ordinary silent install never carries a rollback notice', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000) })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    if (result.outcome !== 'installed') return
    expect(result.rollbackNotice).toBeUndefined()
  })

  it('a corrupted/unparseable existing pin forces at least reconsent -- never silently re-installs as TOFU', async () => {
    const storage = memoryStorage()
    storage.pins.set(ORIGIN, { not: 'a valid pin record' })

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    // NO_GRANTS means the app holds no capabilities at all, and this
    // manifest requests none either, so the pattern-subset check cannot
    // fire -- the corrupted-pin path must still force reconsent via the
    // blank-pinnedHash route (isSameBundle treats a blank digest as
    // CHANGED), not fall through to a silent re-install.
    expect(result.outcome).toBe('needs-reconsent')
  })
})

// One suite against the real node:fs storage rather than memoryStorage: the
// failure this guards against is a DISK state (a fully written bundle with
// no pin record), which an in-memory stub cannot produce.
describe('createLoader: against the real node:fs storage', () => {
  const ROUTES: Record<string, RouteSpec> = {
    [MANIFEST_URL]: { body: utf8(manifestJson()) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
  }

  it('still writes the pin record when a subtree under the code root cannot be listed during the prune', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-install-'))
    const storage = nodeLoaderStorage(userData)
    const appDir = join(userData, 'apps', appRootDirectoryName(ORIGIN))

    const first = await createLoader({ fetch: stubFetch(ROUTES), storage, now: fixedNow() }).load(ORIGIN, NO_GRANTS)
    expect(first.outcome).toBe('installed')

    // Left behind by an earlier install and since made unreadable: the prune
    // on the refetch below walks straight into it.
    await mkdir(join(appDir, 'code', 'sealed'), { recursive: true })
    await writeFile(join(appDir, 'code', 'sealed', 'stale.css'), 'stale')
    await chmod(join(appDir, 'code', 'sealed'), 0o000)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const again = await createLoader({ fetch: stubFetch(ROUTES), storage, now: fixedNow(1_700_000_009_000) }).load(ORIGIN, NO_GRANTS)

    logged.mockRestore()
    await chmod(join(appDir, 'code', 'sealed'), 0o755) // so a later run can clean up /tmp

    expect(again.outcome).toBe('installed')
    // The pin record ON DISK carries this second install's clock reading --
    // proof writePin ran after the prune, rather than the prune aborting
    // install() and leaving the first record standing.
    const pin = JSON.parse(await readFile(join(appDir, 'pin.json'), 'utf8')) as { pinnedAt: number }
    expect(pin.pinnedAt).toBe(1_700_000_009_000)
  })
})
