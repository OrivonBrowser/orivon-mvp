import { describe, expect, it, vi } from 'vitest'
import { installFromHint } from './app-install.js'
import type { AppInstallDeps } from './app-install.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { LoadResult, Loader } from '../loader/index.js'
import type { Grant, Manifest } from '../contracts/index.js'

const ORIGIN = 'https://app.example.com'

function manifestWith (version = '1.0.0'): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: ORIGIN, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

/** A minimal fake Broker -- only the three methods installFromHint actually calls. Deliberately not the real createBroker(): this suite tests call sequencing and argument-passing, not broker behaviour, which src/broker/index.test.ts already owns. */
function fakeBroker (overrides: Partial<{ grants: readonly Grant[], versionFloor: string, registerApp: Broker['registerApp'] }> = {}): Broker {
  return {
    app: {
      manifest: vi.fn(),
      grants: vi.fn(async () => overrides.grants ?? [])
    },
    net: {} as Broker['net'],
    fs: {} as Broker['fs'],
    registerApp: overrides.registerApp ?? vi.fn(async () => {}),
    versionFloorFor: vi.fn(async () => overrides.versionFloor ?? '0.0.0'),
    grant: vi.fn(),
    revoke: vi.fn()
  }
}

function fakeLoader (result: LoadResult): Loader & { load: ReturnType<typeof vi.fn> } {
  return { load: vi.fn(async () => result) }
}

describe('installFromHint', () => {
  it('rejects an invalid hintedUrl before ever touching the broker or loader', async () => {
    const broker = fakeBroker()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })

    const result = await installFromHint({ broker, loader }, 'not a url')

    expect(result.outcome).toBe('rejected')
    expect(broker.app.grants).not.toHaveBeenCalled()
    expect(loader.load).not.toHaveBeenCalled()
  })

  it('builds LoadContext from the broker -- grantedPatterns via patternSetFromGrants, versionFloor verbatim', async () => {
    const broker = fakeBroker({ grants: [grant()], versionFloor: '2.0.0' })
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })

    await installFromHint({ broker, loader }, ORIGIN)

    expect(broker.app.grants).toHaveBeenCalledWith(ORIGIN)
    expect(broker.versionFloorFor).toHaveBeenCalledWith(ORIGIN)
    expect(loader.load).toHaveBeenCalledWith(ORIGIN, {
      grantedPatterns: { 'tcp.connect': ['api.example.com:443'] },
      versionFloor: '2.0.0'
    })
  })

  it('calls registerApp when the outcome is installed, with exactly the result\'s own canonicalOrigin and manifest', async () => {
    const manifest = manifestWith('1.2.0')
    const registerApp = vi.fn(async () => {})
    const broker = fakeBroker({ registerApp })
    const loader = fakeLoader({ outcome: 'installed', canonicalOrigin: ORIGIN, manifest, pin: { schema: 1, origin: ORIGIN, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.2.0', pinnedAt: 0 } })

    await installFromHint({ broker, loader }, ORIGIN)

    expect(registerApp).toHaveBeenCalledExactlyOnceWith(ORIGIN, manifest)
  })

  // A60: registerApp must only fire on an ACCEPTED install, never a bare
  // fetch/parse -- otherwise a hostile origin can poison the version floor
  // with a fake high version and lock itself out of every real future
  // update, with no live caller to exhibit the bug until this file existed.
  it.each([
    ['needs-reconsent', { outcome: 'needs-reconsent', canonicalOrigin: ORIGIN, manifest: manifestWith(), tree: { root: 'sha256:' + 'a'.repeat(64), assets: [] }, entries: [] }],
    ['needs-capability-prompt', { outcome: 'needs-capability-prompt', canonicalOrigin: ORIGIN, manifest: manifestWith(), tree: { root: 'sha256:' + 'a'.repeat(64), assets: [] }, entries: [], requestedPatterns: {} }],
    ['rejected', { outcome: 'rejected', reason: 'malformed manifest' }]
  ] satisfies Array<[string, LoadResult]>)('never calls registerApp for outcome "%s" (A60)', async (_label, loadResult) => {
    const registerApp = vi.fn(async () => {})
    const broker = fakeBroker({ registerApp })
    const loader = fakeLoader(loadResult)

    const result = await installFromHint({ broker, loader }, ORIGIN)

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

    const call1 = installFromHint(deps, ORIGIN)
    const call2 = installFromHint(deps, ORIGIN)

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
