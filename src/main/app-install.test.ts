import { describe, expect, it, vi } from 'vitest'
import { installFromHint } from './app-install.js'
import type { AppInstallDeps } from './app-install.js'
import { APP, OTHER, stubBroker } from '../broker/ipc.test-helpers.js'
import type { BrokerCall } from '../broker/ipc.test-helpers.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { LoadResult, Loader } from '../loader/index.js'
import type { Grant, Manifest } from '../contracts/index.js'

function manifestWith (version = '1.0.0'): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

/**
 * `stubBroker` (ipc.test-helpers.ts) extended with `registerApp`/
 * `versionFloorFor` overrides -- see that file's own doc on why this reuses
 * it rather than a second full fake Broker. `calls` defaults to a
 * throwaway array; pass one in to assert which origin each method was
 * actually called with.
 */
function fakeBroker (
  overrides: Partial<{ grants: readonly Grant[], versionFloor: string, registerApp: Broker['registerApp'] }> = {},
  calls: BrokerCall[] = []
): Broker {
  return stubBroker(calls, {
    grants: async () => overrides.grants ?? [],
    versionFloorFor: async () => overrides.versionFloor ?? '0.0.0',
    registerApp: overrides.registerApp ?? (async () => {})
  })
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
    expect(loader.load).toHaveBeenCalledWith(APP, {
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
      versionFloor: '2.0.0'
    })
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
})
