import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appRootDirectoryName, createLoader } from '../index.js'
import type { LoadContext, LoadResult, LoaderStorage } from '../index.js'
import { nodeLoaderStorage } from '../cache/node-storage.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }

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
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
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
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })

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
      commitStaged: vi.fn(async (): Promise<void> => { throw new Error(`EACCES: permission denied, rename '${hostPath}'`) })
    }
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
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
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
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
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    const result = await loader.load(ORIGIN, NO_GRANTS)
    if (result.outcome !== 'installed') throw new Error('fixture setup failed')
  }

  /** A second version of the fixture (same authority, different entry bytes), fetched and approved: the path that replaces a pin. */
  async function approveChangedBundle (storage: LoaderStorage, now: number): Promise<LoadResult> {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><p>v2</p>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(now), resolve: PUBLIC_RESOLVER })
    const pending = await loader.load(ORIGIN, NO_GRANTS)
    if (pending.outcome !== 'needs-reconsent') throw new Error(`fixture expected needs-reconsent, got ${pending.outcome}`)
    return await loader.installFetched(ORIGIN, pending.manifest, pending.tree, pending.entries, pending.declaration, undefined)
  }

  it('replacing a pin leaves the previous bundle\'s files on disk -- a page still running it may load them; the next start prunes', async () => {
    const storage = memoryStorage()
    await install(storage)
    await storage.writeAsset(ORIGIN, '/old-chunk.js', utf8('from the previous version'))
    vi.clearAllMocks()

    const result = await approveChangedBundle(storage, 1_700_000_001_000)

    expect(result.outcome).toBe('installed')
    expect(storage.pruneAssets).not.toHaveBeenCalled()
    expect(storage.assets.get(ORIGIN)?.has('/old-chunk.js')).toBe(true)
    expect(storage.writePin).toHaveBeenCalledOnce()
  })

  it('an unchanged bundle installs silently again without rewriting a single file or the pin', async () => {
    const storage = memoryStorage()
    await install(storage)
    vi.clearAllMocks()

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000), resolve: PUBLIC_RESOLVER })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    expect(storage.commitStaged).not.toHaveBeenCalled()
    expect(storage.writePin).not.toHaveBeenCalled()
    expect(storage.staged.size).toBe(0)
    if (result.outcome === 'installed') expect(result.pin.pinnedAt).toBe(fixedNow()())
  })

  it('an unchanged bundle rewrites a cached file that no longer matches its leaf -- a corrupted cache heals on the next check', async () => {
    const storage = memoryStorage()
    await install(storage)
    await storage.writeAsset(ORIGIN, '/index.html', utf8('corrupted on disk'))
    vi.clearAllMocks()

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000), resolve: PUBLIC_RESOLVER })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    expect(storage.commitStaged).toHaveBeenCalledOnce()
    expect(new TextDecoder().decode(storage.assets.get(ORIGIN)?.get('/index.html'))).toBe('<!doctype html>')
  })

  it('changed bytes (same authority) -> needs-reconsent, and nothing is persisted', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><!-- changed --> ') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
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
    const narrowLoader = createLoader({ fetch: stubFetch(narrowRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    await narrowLoader.load(ORIGIN, NO_GRANTS)

    // The user actually granted exactly that narrow pattern -- this is the
    // GRANTED set decideUpdate must be checked against.
    const granted: LoadContext = {
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
      versionFloor: '0.0.0',
      acknowledgedRollbackVersion: undefined
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
    const wideLoader = createLoader({ fetch: stubFetch(wideRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    const result = await wideLoader.load(ORIGIN, granted)

    expect(result.outcome).toBe('needs-capability-prompt')
    if (result.outcome !== 'needs-capability-prompt') return
    expect(result.requestedPatterns['tcp.connect']).toEqual(['*:*'])
  })

  // The site-info popover's "off" switch must stick: LoadContext.
  // declinedCapabilities names a kind the person switched off, and a
  // re-visit must not treat that still-declared kind as newly requested --
  // see withoutSwitchedOffCapabilities's own doc for why "not currently
  // held" is the condition.
  describe('declinedCapabilities (the site-info popover\'s "off" switch, A2)', () => {
    it('a person who granted fs then turned it off is not re-prompted on the next, byte-identical visit', async () => {
      const storage = memoryStorage()
      // Both kinds are declared from the start -- ADR-0009 makes the
      // manifest a hashed leaf, so declaring a capability AFTER install
      // would itself change the bundle hash and force at least
      // `reconsent`. The realistic "off sticks" scenario is a manifest
      // that never changes: the person granted fs once, later revoked it
      // from the site-info popover, and the SAME manifest keeps being
      // served on every later visit.
      const routes: Record<string, RouteSpec> = {
        [MANIFEST_URL]: { body: utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } } })) },
        [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
      }
      const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
      // Fresh TOFU install -- both kinds granted at this point, in the real ledger.
      await loader.load(ORIGIN, { grantedPatterns: { 'tcp.connect': ['api.example.com:443'], fs: [] }, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined })

      // fs has since been revoked (site-switches.js's turnOff) and declined
      // -- grantedPatterns no longer holds it, but the manifest still
      // declares it, unchanged.
      const context: LoadContext = { grantedPatterns: { 'tcp.connect': ['api.example.com:443'] }, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined, declinedCapabilities: ['fs'] }

      const result = await loader.load(ORIGIN, context)

      expect(result.outcome).toBe('installed')
    })

    it('a currently-held kind that was once declined is still watched for widening, even if the person later turns it back on', async () => {
      const storage = memoryStorage()
      const narrowRoutes: Record<string, RouteSpec> = {
        [MANIFEST_URL]: { body: utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } })) },
        [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
      }
      const narrowLoader = createLoader({ fetch: stubFetch(narrowRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
      const granted: LoadContext = { grantedPatterns: { 'tcp.connect': ['api.example.com:443'] }, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
      await narrowLoader.load(ORIGIN, granted)

      // The manifest now widens tcp.connect itself -- HELD, so it must
      // still prompt, whatever declinedCapabilities says about that kind.
      const wideRoutes: Record<string, RouteSpec> = {
        [MANIFEST_URL]: { body: utf8(manifestJson({ version: '1.0.1', capabilities: { net: { tcp: { connect: ['*:*'] } } } })) },
        [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
      }
      const wideLoader = createLoader({ fetch: stubFetch(wideRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
      const context: LoadContext = { ...granted, declinedCapabilities: ['tcp.connect'] }

      const result = await wideLoader.load(ORIGIN, context)

      expect(result.outcome).toBe('needs-capability-prompt')
    })

    it('a bundle change is still caught even when its only widening is a switched-off kind -- never installs new code unprompted', async () => {
      const storage = memoryStorage()
      const narrowRoutes: Record<string, RouteSpec> = {
        [MANIFEST_URL]: { body: utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } })) },
        [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
      }
      const narrowLoader = createLoader({ fetch: stubFetch(narrowRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
      const granted: LoadContext = { grantedPatterns: { 'tcp.connect': ['api.example.com:443'] }, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }
      await narrowLoader.load(ORIGIN, granted)

      // New code AND a newly declared, declined-and-unheld capability.
      const wideRoutes: Record<string, RouteSpec> = {
        [MANIFEST_URL]: { body: utf8(manifestJson({ version: '1.0.1', capabilities: { net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } } })) },
        [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>, changed') }
      }
      const wideLoader = createLoader({ fetch: stubFetch(wideRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
      const context: LoadContext = { ...granted, declinedCapabilities: ['fs'] }

      const result = await wideLoader.load(ORIGIN, context)

      // Filtering out the declined 'fs' key leaves newPatterns identical to
      // grantedPatterns, so widensAuthority is false -- but the bundle hash
      // differs, so ordinaryEscalation must still fall through to
      // 'reconsent', never 'silent'.
      expect(result.outcome).toBe('needs-reconsent')
    })
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
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    const before = storage.pins.get(ORIGIN)
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0', acknowledgedRollbackVersion: undefined })

    expect(result.outcome).toBe('needs-rollback-choice')
    if (result.outcome !== 'needs-rollback-choice') return
    expect(result.versionFloor).toBe('1.0.0')
    expect(result.manifest.version).toBe('0.9.0')
    expect(storage.pins.get(ORIGIN)).toBe(before) // untouched, same as needs-reconsent/needs-capability-prompt
  })

  it('an acknowledged version that does not match the one being offered -> needs-rollback-choice, never treated as acknowledged', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.5.0' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    const before = storage.pins.get(ORIGIN)
    // The origin's rollback to a DIFFERENT below-floor version (0.9.0) was
    // acknowledged previously -- exactly the scenario the version-keyed
    // design (not a bare boolean) exists to distinguish from THIS version
    // (0.5.0) being offered now. A caller comparing loosely (any prior
    // acknowledgment counts) would silently install 0.5.0; this must not.
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0', acknowledgedRollbackVersion: '0.9.0' })

    expect(result.outcome).toBe('needs-rollback-choice')
    if (result.outcome !== 'needs-rollback-choice') return
    expect(result.manifest.version).toBe('0.5.0')
    expect(storage.pins.get(ORIGIN)).toBe(before) // untouched
  })

  it('a version below the version floor, already acknowledged, offering exactly what is already pinned -> installed with a rollback notice, no choice required', async () => {
    const storage = memoryStorage()
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.9.0' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    // The origin's own below-floor bundle is what's ALREADY pinned -- TOFU
    // against a floor of '0.0.0' accepts any first version -- so refetching
    // the identical bytes below is the genuine no-op repeat `rollback-notice`
    // exists for (same authority, same code as what's on disk), not a fresh
    // below-floor transition. This is the one input combination with no
    // widening and no bundle change; see the two tests below for the
    // adversarial combinations the 2026-09-05 fix actually exists to catch.
    const firstLoad = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    const first = await firstLoad.load(ORIGIN, { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined })
    if (first.outcome !== 'installed') throw new Error('fixture setup failed')

    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000), resolve: PUBLIC_RESOLVER })
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0', acknowledgedRollbackVersion: '0.9.0' })

    expect(result.outcome).toBe('installed')
    if (result.outcome !== 'installed') return
    expect(result.pin.version).toBe('0.9.0')
    expect(result.rollbackNotice).toBe(true)
  })

  it('a version below the version floor, already acknowledged, but its bytes differ from what is pinned -> needs-reconsent, never a silent install', async () => {
    const storage = memoryStorage()
    await install(storage) // pins manifestJson()'s own 1.0.0 bundle

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.9.0' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000), resolve: PUBLIC_RESOLVER })
    const before = storage.pins.get(ORIGIN)
    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '1.0.0', acknowledgedRollbackVersion: '0.9.0' })

    // Acknowledging a rollback for this origin is not a blank cheque for
    // whatever code that origin serves under an already-forgiven version
    // number: this 0.9.0 bundle's bytes are not what's actually pinned (the
    // fixture installed a DIFFERENT 1.0.0 bundle), so it must still surface
    // as reconsent -- never fold into the silently-installing rollback
    // notice (the 2026-09-05 fix, ADR-0013's own amendment).
    expect(result.outcome).toBe('needs-reconsent')
    expect(storage.pins.get(ORIGIN)).toBe(before) // untouched
  })

  it('a version below the version floor, already acknowledged, but widening the granted patterns -> needs-capability-prompt, never a silent install', async () => {
    const storage = memoryStorage()
    const narrowRoutes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    await createLoader({ fetch: stubFetch(narrowRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER }).load(ORIGIN, NO_GRANTS)

    // The user actually granted exactly that narrow pattern, and the origin
    // once shipped something at or above 2.0.0 (hence this floor) -- it is
    // now offering a below-floor 0.9.0 that ALSO asks for "*:*", strictly
    // wider than granted.
    const granted: LoadContext = {
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
      versionFloor: '2.0.0',
      acknowledgedRollbackVersion: '0.9.0'
    }
    const wideRoutes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '0.9.0', capabilities: { net: { tcp: { connect: ['*:*'] } } } })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const result = await createLoader({ fetch: stubFetch(wideRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER }).load(ORIGIN, granted)

    // An acknowledged rollback that ALSO widens authority is exactly as
    // capability-prompt-worthy as an ordinary update making the same
    // request -- it must never resolve to the silently-installing rollback
    // notice (the 2026-09-05 fix, ADR-0013's own amendment).
    expect(result.outcome).toBe('needs-capability-prompt')
    if (result.outcome !== 'needs-capability-prompt') return
    expect(result.requestedPatterns['tcp.connect']).toEqual(['*:*'])
  })

  it('an ordinary silent install never carries a rollback notice', async () => {
    const storage = memoryStorage()
    await install(storage)

    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(1_700_000_001_000), resolve: PUBLIC_RESOLVER })
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
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    const result = await loader.load(ORIGIN, NO_GRANTS)

    // NO_GRANTS means the app holds no capabilities at all, and this
    // manifest requests none either, so the pattern-subset check cannot
    // fire -- the corrupted-pin path must still force reconsent via the
    // blank-pinnedHash route (isSameBundle treats a blank digest as
    // CHANGED), not fall through to a silent re-install.
    expect(result.outcome).toBe('needs-reconsent')
  })
})

// The site-info popover's Web3 Score page (../../main/browsing/site-
// trust.js) reads the pin without re-fetching or re-deciding anything --
// exactly the parse `decideAndRoute` uses internally, exposed read-only.
describe('createLoader: pinFor', () => {
  it('null for an origin that has never been pinned', async () => {
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch({}), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })

    expect(await loader.pinFor(ORIGIN)).toBeNull()
  })

  it('the current pin, after a fresh install', async () => {
    const storage = memoryStorage()
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({})) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })
    await loader.load(ORIGIN, NO_GRANTS)

    const pin = await loader.pinFor(ORIGIN)

    expect(pin?.origin).toBe(ORIGIN)
    expect(pin?.version).toBe('1.0.0')
  })

  it('null, not a throw, when the stored pin fails to parse', async () => {
    const storage = memoryStorage()
    storage.pins.set(ORIGIN, { not: 'a real pin record' })
    const loader = createLoader({ fetch: stubFetch({}), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER })

    expect(await loader.pinFor(ORIGIN)).toBeNull()
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

  it('an update commits over the real code/ tree and rewrites the pin with the new clock reading', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-loader-install-'))
    const storage = nodeLoaderStorage(userData)
    const appDir = join(userData, 'apps', appRootDirectoryName(ORIGIN))

    const first = await createLoader({ fetch: stubFetch(ROUTES), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER }).load(ORIGIN, NO_GRANTS)
    expect(first.outcome).toBe('installed')

    const updated: Record<string, RouteSpec> = { ...ROUTES, [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><p>v2</p>') } }
    const loader = createLoader({ fetch: stubFetch(updated), storage, now: fixedNow(1_700_000_009_000), resolve: PUBLIC_RESOLVER })
    const pending = await loader.load(ORIGIN, NO_GRANTS)
    if (pending.outcome !== 'needs-reconsent') throw new Error(`fixture expected needs-reconsent, got ${pending.outcome}`)
    const again = await loader.installFetched(ORIGIN, pending.manifest, pending.tree, pending.entries, pending.declaration, undefined)

    expect(again.outcome).toBe('installed')
    expect(await readFile(join(appDir, 'code', 'index.html'), 'utf8')).toBe('<!doctype html><p>v2</p>')
    const pin = JSON.parse(await readFile(join(appDir, 'pin.json'), 'utf8')) as { pinnedAt: number }
    expect(pin.pinnedAt).toBe(1_700_000_009_000)
  })
})

// src/loader/electron/serve.ts's onInstalled hook: fires exactly on the
// outcomes that actually persist a bundle, never on one that only returns a
// prompt to the caller. This is the seam electron/serve.ts's
// registerServingFor plugs into so an app already works from cache within
// the SAME run it was installed in.
describe('createLoader: onInstalled', () => {
  const ROUTES: Record<string, RouteSpec> = {
    [MANIFEST_URL]: { body: utf8(manifestJson()) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
  }

  it('fires once, with the canonical origin, on a fresh TOFU install', async () => {
    const onInstalled = vi.fn(async () => {})
    const loader = createLoader({ fetch: stubFetch(ROUTES), storage: memoryStorage(), now: fixedNow(), resolve: PUBLIC_RESOLVER, onInstalled })

    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith(ORIGIN)
  })

  it('fires again on a "silent" re-install of an unchanged, still-in-authority bundle', async () => {
    const storage = memoryStorage()
    const onInstalled = vi.fn(async () => {})
    await createLoader({ fetch: stubFetch(ROUTES), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER, onInstalled }).load(ORIGIN, NO_GRANTS)
    onInstalled.mockClear()

    const result = await createLoader({ fetch: stubFetch(ROUTES), storage, now: fixedNow(1_700_000_001_000), resolve: PUBLIC_RESOLVER, onInstalled }).load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith(ORIGIN)
  })

  it('does NOT fire on needs-reconsent -- nothing was persisted for it to serve', async () => {
    const storage = memoryStorage()
    await createLoader({ fetch: stubFetch(ROUTES), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER }).load(ORIGIN, NO_GRANTS)
    const onInstalled = vi.fn(async () => {})
    const changedRoutes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><!-- changed -->') }
    }

    const result = await createLoader({ fetch: stubFetch(changedRoutes), storage, now: fixedNow(), resolve: PUBLIC_RESOLVER, onInstalled }).load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('needs-reconsent')
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('does NOT fire on a rejected fetch', async () => {
    const onInstalled = vi.fn(async () => {})
    const loader = createLoader({ fetch: stubFetch({}), storage: memoryStorage(), now: fixedNow(), resolve: PUBLIC_RESOLVER, onInstalled })

    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('rejected')
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('a throwing onInstalled hook is logged, not left to fail the install it followed', async () => {
    const onInstalled = vi.fn(async () => { throw new Error('registerServingFor blew up') })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loader = createLoader({ fetch: stubFetch(ROUTES), storage: memoryStorage(), now: fixedNow(), resolve: PUBLIC_RESOLVER, onInstalled })

    const result = await loader.load(ORIGIN, NO_GRANTS)

    logged.mockRestore()
    expect(result.outcome).toBe('installed')
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith(ORIGIN)
  })

  it('is entirely optional -- omitting it changes nothing about a normal install', async () => {
    const loader = createLoader({ fetch: stubFetch(ROUTES), storage: memoryStorage(), now: fixedNow(), resolve: PUBLIC_RESOLVER })

    const result = await loader.load(ORIGIN, NO_GRANTS)

    expect(result.outcome).toBe('installed')
  })
})
