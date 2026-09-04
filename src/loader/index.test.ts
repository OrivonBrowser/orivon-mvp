import { describe, expect, it, vi } from 'vitest'
import { createLoader } from './index.js'
import type { LoadContext } from './index.js'
import { MANIFEST_URL, ORIGIN, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0' }

function fixedNow (value = 1_700_000_000_000): () => number {
  return () => value
}

// This suite is organised around the FOUR outcomes acceptance criterion 1
// names (installed / needs-reconsent / needs-capability-prompt / rejected),
// and separately around criterion 4 -- decideUpdate() must see the GRANTED
// pattern set, never the manifest's declared one (A18/A27's own failure
// class, named explicitly in this lane's brief).

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

  it('calls pruneAssets with the new bundle\'s own paths, after every writeAsset and before writePin', async () => {
    const storage = memoryStorage()
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })

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
    const storage = { ...base, pruneAssets: vi.fn(async (): Promise<void> => { throw new Error('disk full') }) }
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })

    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('rejected')
    // A failed prune must not leave assets written with no pin record --
    // load() would then read this origin back as never-pinned fresh TOFU.
    expect(base.writePin).not.toHaveBeenCalled()
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
      versionFloor: '0.0.0'
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

  it('a version below the version floor -> rejected, at every prompt (T19)', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.9.0' })) } }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow() })
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0' })

    expect(result.outcome).toBe('rejected')
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
