import { describe, expect, it, vi } from 'vitest'
import { installFromHint } from '../app-install.js'
import type { AppInstallDeps } from '../app-install.js'
import { APP, OTHER } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { LoadResult, Loader } from '../../loader/index.js'
import { createLoader } from '../../loader/index.js'
import type { Fetch } from '../../loader/index.js'
import { fromBundleTree } from '../../broker/policy/pin.js'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { MANIFEST_URL, manifestJson, memoryStorage, ORIGIN, PUBLIC_RESOLVER, stubFetch, utf8 } from '../../loader/tests/test-helpers.js'
import type { RouteSpec } from '../../loader/tests/test-helpers.js'
import { fakeBroker, fakeLoader, grant, installedResult, manifestWith, manifestWithCapabilities, REJECTED } from './app-install.test-helpers.js'

describe('installFromHint', () => {
  it('rejects an invalid hintedUrl before ever touching the broker or loader', async () => {
    const broker = fakeBroker()
    const loader = fakeLoader(REJECTED)

    const result = await installFromHint({ broker, loader }, APP, 'not a url')

    expect(result.outcome).toBe('rejected')
    expect(loader.load).not.toHaveBeenCalled()
  })

  // F10: a hostile page could otherwise emit a hint naming a completely
  // unrelated origin and have this read THAT origin's grants and raise its
  // version floor, with the user never having visited it.
  it('rejects a hintedUrl whose origin differs from hintingOrigin, before ever touching the broker or loader', async () => {
    const broker = fakeBroker()
    const loader = fakeLoader(REJECTED)

    const result = await installFromHint({ broker, loader }, OTHER, APP)

    expect(result.outcome).toBe('rejected')
    if (result.outcome === 'rejected') expect(result.reason).toContain(OTHER)
    expect(loader.load).not.toHaveBeenCalled()
  })

  it('proceeds when hintingOrigin equals the origin hintedUrl resolves to, reading that same origin from the broker', async () => {
    const calls: BrokerCall[] = []
    const broker = fakeBroker({ grants: [grant()], versionFloor: '2.0.0' }, calls)
    const loader = fakeLoader(REJECTED)

    await installFromHint({ broker, loader }, APP, APP)

    expect(calls).toContainEqual({ method: 'app.grants', origin: APP, args: undefined })
    expect(calls).toContainEqual({ method: 'versionFloorFor', origin: APP, args: undefined })
    expect(calls).toContainEqual({ method: 'rollbackAcknowledgedVersionFor', origin: APP, args: undefined })
    expect(loader.load).toHaveBeenCalledWith(APP, {
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
      versionFloor: '2.0.0',
      acknowledgedRollbackVersion: undefined
    })
  })

  // F3: the raw acknowledged version passes straight through to LoadContext,
  // unexamined -- installFromHint cannot know which version load() is about
  // to offer, so it must not do any comparison itself (see this file's own
  // header for why an origin-only check would reopen rollback-ack's flaw).
  it('passes the broker\'s acknowledged rollback version straight through to LoadContext, unexamined', async () => {
    const broker = fakeBroker({ acknowledgedRollback: '0.9.0' })
    const loader = fakeLoader(REJECTED)

    await installFromHint({ broker, loader }, APP, APP)

    expect(loader.load).toHaveBeenCalledWith(APP, expect.objectContaining({ acknowledgedRollbackVersion: '0.9.0' }))
  })

  it('calls registerApp when the outcome is installed, with exactly the result\'s own canonicalOrigin and manifest', async () => {
    const manifest = manifestWith('1.2.0')
    const registerApp = vi.fn(async () => {})
    const broker = fakeBroker({ registerApp })
    const loader = fakeLoader({ outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.2.0', pinnedAt: 0 } })

    await installFromHint({ broker, loader }, APP, APP)

    expect(registerApp).toHaveBeenCalledExactlyOnceWith(APP, manifest)
  })

  // F16: registerApp rejecting must not lose the already-successful install.
  it('still resolves to the LoadInstalled result when registerApp rejects', async () => {
    const manifest = manifestWith('1.2.0')
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.2.0', pinnedAt: 0 } }
    const registerApp = vi.fn(async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) })
    const broker = fakeBroker({ registerApp })
    const loader = fakeLoader(installed)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await installFromHint({ broker, loader }, APP, APP)

    expect(result).toBe(installed)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  // A60: registerApp must only fire on an ACCEPTED install, never a bare
  // fetch/parse -- otherwise a hostile origin can poison the version floor
  // with a fake high version and lock itself out of every real future
  // update, with no live caller to exhibit the bug until this file existed.
  // Every non-'installed' LoadResult outcome on the CURRENT src/loader/
  // index.ts union must appear here (F15) -- installFromHint's exhaustive
  // switch (F14) fails to compile if that union grows without a matching
  // case, which is what will force this table to grow too.
  it.each([
    ['needs-reconsent', { outcome: 'needs-reconsent', canonicalOrigin: APP, manifest: manifestWith(), tree: { root: 'sha256:' + 'a'.repeat(64), assets: [] }, entries: [] }],
    ['needs-capability-prompt', { outcome: 'needs-capability-prompt', canonicalOrigin: APP, manifest: manifestWith(), tree: { root: 'sha256:' + 'a'.repeat(64), assets: [] }, entries: [], requestedPatterns: {} }],
    ['needs-rollback-choice', { outcome: 'needs-rollback-choice', canonicalOrigin: APP, manifest: manifestWith(), tree: { root: 'sha256:' + 'a'.repeat(64), assets: [] }, entries: [], versionFloor: '1.0.0' }],
    ['rejected', { outcome: 'rejected', reason: 'malformed manifest' }]
  ] satisfies Array<[string, LoadResult]>)('never calls registerApp for outcome "%s" (A60)', async (_label, loadResult) => {
    const registerApp = vi.fn(async () => {})
    const broker = fakeBroker({ registerApp })
    const loader = fakeLoader(loadResult)

    const result = await installFromHint({ broker, loader }, APP, APP)

    expect(registerApp).not.toHaveBeenCalled()
    expect(result).toBe(loadResult)
  })

  it('serializes two calls for the same origin -- the second does not build its LoadContext until the first has fully finished', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const broker = fakeBroker()
    const loader: Loader = {
      load: vi.fn(async (): Promise<LoadResult> => {
        if (order.length === 0) {
          order.push('1 start')
          await firstGate
          order.push('1 end')
        } else {
          order.push('2 start')
        }
        return { outcome: 'rejected', reason: 'unused' }
      }),
      installFetched: vi.fn(async () => { throw new Error('installFetched was not stubbed for this test') }),
      reconsider: vi.fn(async () => { throw new Error('reconsider was not stubbed for this test') })
    }
    const deps: AppInstallDeps = { broker, loader }

    const call1 = installFromHint(deps, APP, APP)
    const call2 = installFromHint(deps, APP, APP)

    // Flushes every pending microtask (broker.app.grants/versionFloorFor,
    // Promise.all, etc.) regardless of exactly how many hops that takes --
    // a macrotask boundary is guaranteed to run after all of them.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['1 start'])

    releaseFirst()
    await call1
    await call2

    expect(order).toEqual(['1 start', '1 end', '2 start'])
  })

  // d-0025 (ADR-0012's 2026-09-13 amendment) / S4-4: consent is asked once,
  // after a successful install, before installFromHint's own promise
  // resolves -- see app-install.ts's header on exactly what guarantee that
  // is and is not. Four behaviours, matching the queue item's own exit
  // criterion verbatim.
  describe('install-time consent (S4-4)', () => {
    it('never invokes consent for a manifest declaring no capabilities', async () => {
      const consent = vi.fn(async () => true)
      const broker = fakeBroker()
      const loader = fakeLoader(installedResult(manifestWith()))

      await installFromHint({ broker, loader, consent }, APP, APP)

      expect(consent).not.toHaveBeenCalled()
    })

    it('a first visit asks once and grants what was accepted', async () => {
      const calls: BrokerCall[] = []
      const consent = vi.fn(async () => true)
      const manifest = manifestWithCapabilities()
      const broker = fakeBroker({ grants: [] }, calls)
      const loader = fakeLoader(installedResult(manifest))

      const result = await installFromHint({ broker, loader, consent }, APP, APP)

      expect(result.outcome).toBe('installed')
      // Nothing held -- the fourth argument (A170) is an empty list.
      expect(consent).toHaveBeenCalledExactlyOnceWith(APP, manifest, ['tcp.connect'], [])
      expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
    })

    it('a second visit -- the origin already holding the grant -- is silent', async () => {
      const consent = vi.fn(async () => true)
      const manifest = manifestWithCapabilities()
      const broker = fakeBroker({ grants: [grant()] })
      const loader = fakeLoader(installedResult(manifest))

      await installFromHint({ broker, loader, consent }, APP, APP)

      expect(consent).not.toHaveBeenCalled()
    })

    it('a declined dialog leaves the app installed with every capability denied', async () => {
      const calls: BrokerCall[] = []
      const consent = vi.fn(async () => false)
      const manifest = manifestWithCapabilities()
      const broker = fakeBroker({ grants: [] }, calls)
      const loader = fakeLoader(installedResult(manifest))

      const result = await installFromHint({ broker, loader, consent }, APP, APP)

      expect(result.outcome).toBe('installed')
      expect(consent).toHaveBeenCalledOnce()
      expect(calls.some((call) => call.method === 'grant')).toBe(false)
    })

    it('still runs the consent step when registerApp itself rejected (F16\'s own case)', async () => {
      const consent = vi.fn(async () => true)
      const manifest = manifestWithCapabilities()
      const registerApp = vi.fn(async () => { throw new Error('ENOSPC') })
      const broker = fakeBroker({ registerApp, grants: [] })
      const loader = fakeLoader(installedResult(manifest))
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      await installFromHint({ broker, loader, consent }, APP, APP)

      expect(consent).toHaveBeenCalledOnce()
      consoleError.mockRestore()
    })

    it('does not invoke consent for any non-installed outcome', async () => {
      const consent = vi.fn(async () => true)
      const broker = fakeBroker()
      const loader = fakeLoader({ outcome: 'rejected', reason: 'malformed manifest' })

      await installFromHint({ broker, loader, consent }, APP, APP)

      expect(consent).not.toHaveBeenCalled()
    })

    it('omitting deps.consent entirely still installs an app declaring no capabilities, unchanged from before this lane', async () => {
      const broker = fakeBroker()
      const loader = fakeLoader(installedResult(manifestWith()))

      const result = await installFromHint({ broker, loader }, APP, APP)

      expect(result.outcome).toBe('installed')
    })

    it('omitting deps.consent fails closed -- grants nothing, never throws -- for a manifest that does declare capabilities', async () => {
      const calls: BrokerCall[] = []
      const broker = fakeBroker({ grants: [] }, calls)
      const loader = fakeLoader(installedResult(manifestWithCapabilities()))

      const result = await installFromHint({ broker, loader }, APP, APP)

      expect(result.outcome).toBe('installed')
      expect(calls.some((call) => call.method === 'grant')).toBe(false)
    })
  })
})

// S4-5, full-stack: a REAL Loader (createLoader), not a fake, so the outcome
// driven through installFromHint's own capabilityPrompt/reconsentPrompt
// really came from decideUpdate() detecting an actual widening/code change --
// not a test-authored LoadResult standing in for one. The property this
// suite exists to prove: accepting the prompt never calls Loader.load() a
// second time, counted at the real fetch layer, not merely asserted against
// a mock.
describe('installFromHint + a real Loader (S4-5 integration)', () => {
  it('an update that widens its granted patterns raises the capability prompt, and accepting it installs with no second fetch', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '1.1.0', capabilities: { net: { tcp: { connect: ['api.example.com:443', 'other.example.com:443'] } } } })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const fetchCounts = new Map<string, number>()
    const countingFetch: Fetch = async (url, pinned, signal) => {
      fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1)
      return await stubFetch(routes)(url, pinned, signal)
    }
    const storage = memoryStorage()
    const loader = createLoader({ fetch: countingFetch, storage, now: () => 0, resolve: PUBLIC_RESOLVER })

    // Seed an existing pin at the OLD, narrower version/pattern -- writePin
    // directly, mirroring a prior TOFU install, so this test is entirely
    // about the UPDATE decision, not a second loader.load() round trip.
    const oldManifest = { orivonApiVersion: 0 as const, id: 'app.orivon.example', name: 'Example App', version: '1.0.0', entry: 'index.html', capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } }
    await storage.writeAsset(ORIGIN, '/.well-known/orivon.json', utf8(manifestJson({ version: '1.0.0', capabilities: oldManifest.capabilities })))
    await storage.writeAsset(ORIGIN, '/index.html', utf8('<!doctype html>'))
    const oldTree = await bundleTree([
      { path: '/.well-known/orivon.json', content: utf8(manifestJson({ version: '1.0.0', capabilities: oldManifest.capabilities })) },
      { path: '/index.html', content: utf8('<!doctype html>') }
    ])
    await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, oldTree.root, oldTree.assets, '1.0.0', 0))

    const calls: BrokerCall[] = []
    const broker = fakeBroker({ grants: [grant({ patterns: ['api.example.com:443'] })], versionFloor: '1.0.0' }, calls)
    const capabilityPrompt = vi.fn(async (_origin: string, _manifest: unknown, _requestedPatterns: Record<string, readonly string[]>) => true)

    const result = await installFromHint({ broker, loader, capabilityPrompt }, ORIGIN, ORIGIN)

    expect(capabilityPrompt).toHaveBeenCalledOnce()
    expect(capabilityPrompt.mock.calls[0]?.[2]).toEqual({ 'tcp.connect': ['api.example.com:443', 'other.example.com:443'] })
    expect(result.outcome).toBe('installed')
    // The whole point: ONE installFromHint call fetches the manifest exactly
    // ONCE, even though it took a prompt-and-accept round trip to resolve.
    expect(fetchCounts.get(MANIFEST_URL)).toBe(1)
  })

  it('declining the capability prompt leaves the previously pinned (narrower) version installed and servable', async () => {
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ version: '1.1.0', capabilities: { net: { tcp: { connect: ['*:*'] } } } })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const storage = memoryStorage()
    const loader = createLoader({ fetch: stubFetch(routes), storage, now: () => 0, resolve: PUBLIC_RESOLVER })

    const oldCapabilities = { net: { tcp: { connect: ['api.example.com:443'] } } }
    const oldTree = await bundleTree([
      { path: '/.well-known/orivon.json', content: utf8(manifestJson({ version: '1.0.0', capabilities: oldCapabilities })) },
      { path: '/index.html', content: utf8('<!doctype html>') }
    ])
    await storage.writeAsset(ORIGIN, '/.well-known/orivon.json', utf8(manifestJson({ version: '1.0.0', capabilities: oldCapabilities })))
    await storage.writeAsset(ORIGIN, '/index.html', utf8('<!doctype html>'))
    await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, oldTree.root, oldTree.assets, '1.0.0', 0))

    const broker = fakeBroker({ grants: [grant({ patterns: ['api.example.com:443'] })], versionFloor: '1.0.0' })
    const capabilityPrompt = vi.fn(async () => false)

    const result = await installFromHint({ broker, loader, capabilityPrompt }, ORIGIN, ORIGIN)

    expect(result.outcome).toBe('needs-capability-prompt')
    // The bundle actually on disk is still the OLD one -- pruneAssets/
    // writePin for the new bundle never ran.
    const pin = await storage.readPin(ORIGIN)
    expect(pin).toEqual(fromBundleTree(ORIGIN, oldTree.root, oldTree.assets, '1.0.0', 0))
  })
})
