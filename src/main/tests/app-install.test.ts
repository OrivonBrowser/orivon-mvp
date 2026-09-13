import { describe, expect, it, vi } from 'vitest'
import { installFromHint } from '../app-install.js'
import type { AppInstallDeps } from '../app-install.js'
import { APP, OTHER, stubBroker } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { LoadResult, Loader } from '../../loader/index.js'
import type { Grant, Manifest } from '../../contracts/index.js'

function manifestWith (version = '1.0.0'): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

/**
 * `stubBroker` (ipc.test-helpers.ts) extended with `registerApp`/
 * `versionFloorFor`/`rollbackAcknowledgedVersionFor` overrides -- see that
 * file's own doc on why this reuses it rather than a second full fake
 * Broker. `calls` defaults to a throwaway array; pass one in to assert
 * which origin each method was actually called with. `acknowledgedRollback`
 * defaults to `undefined` (never acknowledged) -- the natural default for
 * every test that isn't specifically about rollback acknowledgement.
 */
function fakeBroker (
  overrides: Partial<{ grants: readonly Grant[], versionFloor: string, acknowledgedRollback: string | undefined, registerApp: Broker['registerApp'], grant: Broker['grant'] }> = {},
  calls: BrokerCall[] = []
): Broker {
  return stubBroker(calls, {
    grants: async () => overrides.grants ?? [],
    versionFloorFor: async () => overrides.versionFloor ?? '0.0.0',
    rollbackAcknowledgedVersionFor: async () => overrides.acknowledgedRollback,
    registerApp: overrides.registerApp ?? (async () => {}),
    grant: overrides.grant ?? (async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 }))
  })
}

/** `manifestWith`, but declaring a real capability -- S4-4's consent-wiring
 * tests below need a manifest that is actually something to ask about;
 * every other test in this file relies on `manifestWith`'s empty default. */
function manifestWithCapabilities (): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } }
}

function installedResult (manifest: Manifest): LoadResult {
  return { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: manifest.version, pinnedAt: 0 } }
}

function fakeLoader (result: LoadResult): Loader & { load: ReturnType<typeof vi.fn> } {
  return { load: vi.fn(async () => result) }
}

const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }

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
      })
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
      expect(consent).toHaveBeenCalledExactlyOnceWith(APP, manifest, ['tcp.connect'])
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
