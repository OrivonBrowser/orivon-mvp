import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../broker/policy/pin.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { createBroker } from '../../broker/index.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { baseDeps, manifestWith, memoryLedgerStorage } from '../../broker/tests/index.test-helpers.js'
import type { Grant } from '../../contracts/index.js'
import { nodeLoaderStorage } from '../node-storage.js'
import type { AppRequestHandler } from '../serve.js'
import { manifestJson, utf8 } from './test-helpers.js'

// registerAppOrigin needs no `electron` mock at all -- it takes a Session
// directly, the same "structural fake, no real Electron" pattern
// src/broker/policy/origin.ts's SenderFrameLike tests already use.
// `handlers` records what registerAppOrigin's SECOND argument actually was --
// the original fixture threw it away, which was fine when nothing here
// exercised the handler itself; S4-6's CSP tests below need to call it.
function fakeSession (): Session & { calls: { unhandle: string[], handle: string[] }, handlers: Map<string, AppRequestHandler> } {
  const handled = new Set<string>()
  const calls = { unhandle: [] as string[], handle: [] as string[] }
  const handlers = new Map<string, AppRequestHandler>()
  return {
    protocol: {
      isProtocolHandled: (scheme: string) => handled.has(scheme),
      unhandle: (scheme: string) => { handled.delete(scheme); calls.unhandle.push(scheme) },
      handle: (scheme: string, handler: AppRequestHandler) => { handled.add(scheme); calls.handle.push(scheme); handlers.set(scheme, handler) }
    },
    calls,
    handlers
  } as unknown as Session & { calls: { unhandle: string[], handle: string[] }, handlers: Map<string, AppRequestHandler> }
}

/**
 * A real pinned bundle on disk, at `origin` -- shared by every describe
 * block below that needs a genuinely servable app rather than just a
 * registration call. `manifestOverrides` lets a caller pin a manifest that
 * actually DECLARES a capability (A158): the pinned bundle's own manifest is
 * what `GrantLedger.hydrateFromPinnedManifest` re-validates a restored grant
 * against, so a test proving that hydration needs the two to agree, the same
 * way a real install always would -- unlike `manifestJson()`'s bare default
 * (`capabilities: {}`), which is deliberately what every OTHER test here,
 * uninterested in hydration, still gets by omitting the argument.
 */
async function pinRealOrigin (
  storage: ReturnType<typeof nodeLoaderStorage>,
  origin: string,
  manifestOverrides: Record<string, unknown> = {}
): Promise<void> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson(manifestOverrides)) },
    { path: '/index.html', content: utf8('<h1>hi</h1>') }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

/**
 * A minimal `Broker` stub -- `app.grants` is the real call site on this path
 * (`liveGrantedPatternsFor` reads it directly, A158). `hydrateFromPinnedManifest`
 * is a no-op here: every test using this fixture passes a `broker` straight
 * to `registerServingFor`/`createAppRequestHandler` without a real pinned
 * bundle behind it in most cases, so there is nothing for the real hydration
 * seam to do -- `restorePinnedServing across a restart` below exercises that
 * seam itself, against a REAL `createBroker`, not this stub.
 */
function fakeBroker (grants: readonly Grant[]): Broker {
  return {
    app: {
      grants: vi.fn(async () => grants),
      isRegisteredSync: () => true,
      persistedAppsSync: () => [],
      hydrateFromPinnedManifest: vi.fn(async () => {})
    }
  } as unknown as Broker
}

describe('registerAppOrigin', () => {
  it('derives the scheme from the origin itself and registers a handler for it', async () => {
    const { registerAppOrigin } = await import('../electron-serve.js')
    const session = fakeSession()

    registerAppOrigin(session, 'https://app.example', async () => new Response(null))

    expect(session.calls.handle).toEqual(['https'])
    expect(session.calls.unhandle).toEqual([])
  })

  it('registers "http" for a plain-http origin -- the dev-mode fixture app case (canonical-path.ts\'s ASSET_SCHEMES)', async () => {
    const { registerAppOrigin } = await import('../electron-serve.js')
    const session = fakeSession()

    registerAppOrigin(session, 'http://127.0.0.1:8872', async () => new Response(null))

    expect(session.calls.handle).toEqual(['http'])
  })

  it('unhandles first when the scheme is already registered -- Electron throws on a second handle() for one scheme otherwise', async () => {
    const { registerAppOrigin } = await import('../electron-serve.js')
    const session = fakeSession()

    registerAppOrigin(session, 'https://app.example', async () => new Response(null))
    registerAppOrigin(session, 'https://app.example', async () => new Response(null))

    expect(session.calls.handle).toEqual(['https', 'https'])
    expect(session.calls.unhandle).toEqual(['https'])
  })
})

describe('restorePinnedServing', () => {
  it('registers a handler, on the correct partition, for every real pinned origin found on disk', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restore-serving-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app-a.example')
    await pinRealOrigin(storage, 'https://app-b.example')

    const sessionsByPartition = new Map<string, ReturnType<typeof fakeSession>>()
    const fromPartition = vi.fn((partition: string) => {
      const existing = sessionsByPartition.get(partition)
      if (existing !== undefined) return existing
      const created = fakeSession()
      sessionsByPartition.set(partition, created)
      return created
    })
    vi.doMock('electron', () => ({ session: { fromPartition } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    const results = await restorePinnedServing(storage)

    expect([...results].sort((a, b) => a.origin.localeCompare(b.origin))).toEqual([
      { origin: 'https://app-a.example', ok: true },
      { origin: 'https://app-b.example', ok: true }
    ])
    expect(fromPartition).toHaveBeenCalledWith(partitionFor('https://app-a.example'))
    expect(fromPartition).toHaveBeenCalledWith(partitionFor('https://app-b.example'))
    expect(sessionsByPartition.get(partitionFor('https://app-a.example'))?.calls.handle).toEqual(['https'])

    vi.doUnmock('electron')
  })

  it('one origin throwing during registration is reported and does not stop the rest', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restore-serving-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://good.example')
    await pinRealOrigin(storage, 'https://also-good.example')

    const fromPartition = vi.fn((partition: string) => {
      if (partition === partitionFor('https://good.example')) throw new Error('simulated Electron failure')
      return fakeSession()
    })
    vi.doMock('electron', () => ({ session: { fromPartition } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    const results = await restorePinnedServing(storage)

    expect([...results].sort((a, b) => a.origin.localeCompare(b.origin))).toEqual([
      { origin: 'https://also-good.example', ok: true },
      { origin: 'https://good.example', ok: false }
    ])

    vi.doUnmock('electron')
  })

  it('is a no-op, registering nothing, when no origin is pinned', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restore-serving-'))
    const storage = nodeLoaderStorage(userData)
    const fromPartition = vi.fn()
    vi.doMock('electron', () => ({ session: { fromPartition } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    expect(await restorePinnedServing(storage)).toEqual([])
    expect(fromPartition).not.toHaveBeenCalled()

    vi.doUnmock('electron')
  })
})

describe('registerServingFor -- the served bundle\'s CSP reads the LIVE broker grant (S4-6)', () => {
  it('with no broker given, the registered handler answers with a self-only CSP', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../electron-serve.js')

    await registerServingFor(storage, 'https://app.example')
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request('https://app.example/'))

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
      "img-src 'self'; font-src 'self'; media-src 'self'"
    )

    vi.doUnmock('electron')
  })

  it('with a broker given, the registered handler\'s CSP widens to the origin\'s live tcp.connect grant', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../electron-serve.js')

    const grant: Grant = { id: 'g1', origin: 'https://app.example', capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0 }
    await registerServingFor(storage, 'https://app.example', fakeBroker([grant]))
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request('https://app.example/'))

    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self' api.example.com:443")

    vi.doUnmock('electron')
  })

  it('with a broker given, the registered handler\'s img-src/font-src/media-src widen to the origin\'s live https.connect grant -- a SEPARATE grant from tcp.connect above', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../electron-serve.js')

    const grant: Grant = { id: 'g1', origin: 'https://app.example', capability: 'https.connect', patterns: ['cdn.example.com:443'], grantedAt: 0 }
    await registerServingFor(storage, 'https://app.example', fakeBroker([grant]))
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request('https://app.example/'))

    const csp = response.headers.get('content-security-policy')
    expect(csp).toContain("img-src 'self' cdn.example.com:443; font-src 'self' cdn.example.com:443; media-src 'self' cdn.example.com:443")
    // A https.connect grant never widens connect-src -- that stays sourced from tcp.connect alone.
    expect(csp).toContain("connect-src 'self';")

    vi.doUnmock('electron')
  })

  it('reads the broker fresh on every request through the SAME handler -- a revoke narrows the very next request, no re-registration', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../electron-serve.js')

    const grant: Grant = { id: 'g1', origin: 'https://app.example', capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0 }
    const grantsSpy = vi.fn(async () => [grant])
    const broker = {
      app: { grants: grantsSpy, isRegisteredSync: () => true, persistedAppsSync: () => [], hydrateFromPinnedManifest: vi.fn(async () => {}) }
    } as unknown as Broker
    await registerServingFor(storage, 'https://app.example', broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const before = await handler(new Request('https://app.example/'))
    expect(before.headers.get('content-security-policy')).toContain('api.example.com:443')

    grantsSpy.mockResolvedValue([]) // simulates the app's grant being revoked
    const after = await handler(new Request('https://app.example/'))
    expect(after.headers.get('content-security-policy')).not.toContain('api.example.com')

    vi.doUnmock('electron')
  })

  it('a broker fault falls back to the strict self-only CSP, never a wider one', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../electron-serve.js')

    const broker = {
      app: {
        grants: vi.fn(async () => { throw new Error('ledger read failed') }),
        isRegisteredSync: () => true,
        persistedAppsSync: () => [],
        hydrateFromPinnedManifest: vi.fn(async () => {})
      }
    } as unknown as Broker
    await registerServingFor(storage, 'https://app.example', broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request('https://app.example/'))

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
      "img-src 'self'; font-src 'self'; media-src 'self'"
    )

    vi.doUnmock('electron')
  })
})

describe('isOriginServedFromCache -- the address bar\'s S4-6 provenance signal', () => {
  it('is true once the origin\'s own scheme is actually registered', async () => {
    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerAppOrigin, isOriginServedFromCache } = await import('../electron-serve.js')

    registerAppOrigin(session, 'https://app.example', async () => new Response(null))

    expect(await isOriginServedFromCache('https://app.example')).toBe(true)

    vi.doUnmock('electron')
  })

  it('is false for an origin nothing has registered serving for -- never a manifest-only "isRegisteredSync" guess', async () => {
    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { isOriginServedFromCache } = await import('../electron-serve.js')

    expect(await isOriginServedFromCache('https://never-installed.example')).toBe(false)

    vi.doUnmock('electron')
  })

  it('is false, not thrown, for a malformed origin', async () => {
    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { isOriginServedFromCache } = await import('../electron-serve.js')

    expect(await isOriginServedFromCache('not a url')).toBe(false)

    vi.doUnmock('electron')
  })
})

describe('pinCoverageFor -- the registered handler\'s own pin-coverage tracker', () => {
  it('is undefined for an origin nothing has registered serving for', async () => {
    vi.doMock('electron', () => ({ session: { fromPartition: () => fakeSession() } }))
    const { pinCoverageFor } = await import('../electron-serve.js')

    expect(pinCoverageFor('https://never-registered.example')).toBeUndefined()

    vi.doUnmock('electron')
  })

  it('a real request through the registered handler updates what pinCoverageFor reports for that origin', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-pin-coverage-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor, pinCoverageFor } = await import('../electron-serve.js')

    await registerServingFor(storage, 'https://app.example')
    expect(pinCoverageFor('https://app.example')).toEqual({
      pinnedRequests: 0, thirdPartyRequests: 0, deniedRequests: 0, pinnedBytes: 0, thirdPartyBytes: 0, bytesIncomplete: false
    })

    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    await handler(new Request('https://app.example/'))

    expect(pinCoverageFor('https://app.example')).toEqual({
      pinnedRequests: 1, thirdPartyRequests: 0, deniedRequests: 0, pinnedBytes: '<h1>hi</h1>'.length, thirdPartyBytes: 0, bytesIncomplete: false
    })

    vi.doUnmock('electron')
  })

  it('re-registering the same origin starts a fresh tracker -- a reinstall\'s counts never carry the previous session\'s forward', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-pin-coverage-reinstall-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor, pinCoverageFor } = await import('../electron-serve.js')

    await registerServingFor(storage, 'https://app.example')
    const firstHandler = session.handlers.get('https')
    if (firstHandler === undefined) throw new Error('no handler was registered')
    await firstHandler(new Request('https://app.example/'))
    expect(pinCoverageFor('https://app.example')?.pinnedRequests).toBe(1)

    await registerServingFor(storage, 'https://app.example')
    expect(pinCoverageFor('https://app.example')?.pinnedRequests).toBe(0)

    vi.doUnmock('electron')
  })
})

describe('restorePinnedServing across a restart -- A158, resolved for every directive via early hydration', () => {
  // A158 (docs/open-questions.md): restorePinnedServing runs in
  // loaderSubsystem.afterReady BEFORE any window exists. Before this lane,
  // the ledger it handed to registerServingFor had never had registerApp
  // called on THIS origin THIS run, so every persisted grant read back as
  // [] until a page loaded and reported its manifest hint. This lane makes
  // registerServingFor hydrate GrantLedger from the PINNED, hash-verified
  // manifest (GrantLedger.hydrateFromPinnedManifest) before it ever
  // registers a handler that could answer a request -- so this suite now
  // proves grants are live from the very first request, using a REAL
  // GrantLedger/createBroker against a REAL LedgerStorage double, not the
  // fakeBroker stub above, the same way it proved the defect before.
  const ORIGIN = 'https://app.example'
  const GRANTED_PATTERNS = ['api.example.com:443']
  const SECURE_GRANTED_PATTERNS = ['granted.example:443']

  /**
   * Simulates a real restart for one capability: session 1 installs, pins
   * and grants; session 2 is a fresh GrantLedger over the SAME persisted
   * storage, exactly what `loaderSubsystem.afterReady` constructs before any
   * window exists. `capabilities` is written into BOTH the pinned bundle's
   * own manifest (`pinRealOrigin`) and the session-1 `registerApp` call --
   * they MUST agree, because `hydrateFromPinnedManifest` re-validates a
   * restored grant against exactly the manifest the pinned bundle carries,
   * the same way `registerApp` always has (A158, A137).
   */
  async function restartedWithAPersistedGrant (
    storage: ReturnType<typeof nodeLoaderStorage>,
    capabilities: Parameters<typeof manifestWith>[0],
    capability: 'tcp.connect' | 'https.connect',
    patterns: readonly string[]
  ): Promise<{ ledgerStorage: ReturnType<typeof memoryLedgerStorage>, broker: Broker }> {
    await pinRealOrigin(storage, ORIGIN, { capabilities })

    // Session 1: the app was really installed and really granted, by a
    // person, and that landed on disk (persistGrants, A23).
    const ledgerStorage = memoryLedgerStorage()
    const firstRun = createBroker(baseDeps({ ledgerStorage }))
    firstRun.registerApp(ORIGIN, manifestWith(capabilities))
    await firstRun.grant(ORIGIN, capability, patterns)

    // Session 2: a restart. A fresh GrantLedger, same persisted storage.
    return { ledgerStorage, broker: createBroker(baseDeps({ ledgerStorage })) }
  }

  it('THE GRANT IS LIVE, NOT JUST DISPLAYED: broker.app.grants(ORIGIN) already holds the real, persisted tcp.connect AND https.connect grants right after restorePinnedServing -- before any registerApp call', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const capabilities = { net: { tcp: { connect: GRANTED_PATTERNS }, https: { connect: SECURE_GRANTED_PATTERNS } } }
    await pinRealOrigin(storage, ORIGIN, { capabilities })
    const ledgerStorage = memoryLedgerStorage()
    const firstRun = createBroker(baseDeps({ ledgerStorage }))
    firstRun.registerApp(ORIGIN, manifestWith(capabilities))
    await firstRun.grant(ORIGIN, 'tcp.connect', GRANTED_PATTERNS)
    await firstRun.grant(ORIGIN, 'https.connect', SECURE_GRANTED_PATTERNS)
    const broker = createBroker(baseDeps({ ledgerStorage })) // the "restart"

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)

    // This is the SAME read `net-capability.ts`'s real orivon.net.connect/
    // connectSecure check performs (ledger.currentGrant) -- not merely a
    // header computation. registerApp was never called on this broker.
    const grants = await broker.app.grants(ORIGIN)
    expect(grants.find((g) => g.capability === 'tcp.connect')?.patterns).toEqual(GRANTED_PATTERNS)
    expect(grants.find((g) => g.capability === 'https.connect')?.patterns).toEqual(SECURE_GRANTED_PATTERNS)

    vi.doUnmock('electron')
  })

  it('A158 RESOLVED FOR connect-src: a real, persisted tcp.connect grant already widens the FIRST served document\'s connect-src -- no reload, no registerApp call', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const { broker } = await restartedWithAPersistedGrant(
      storage, { net: { tcp: { connect: GRANTED_PATTERNS } } }, 'tcp.connect', GRANTED_PATTERNS
    )

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const response = await handler(new Request(`${ORIGIN}/`))

    // Before this lane, this stayed falsely 'self'-only: broker.app.grants
    // read GrantLedger.grantsFor, which returned [] until registerApp had
    // run. registerServingFor now hydrates from the pinned, hash-verified
    // manifest before this handler was ever registered -- widening this is
    // no longer widening from anything unverified (A137's objection does
    // not apply to a hash-pinned leaf).
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self' api.example.com:443")

    vi.doUnmock('electron')
  })

  it('A158 RESOLVED FOR img-src/font-src/media-src: a real, persisted https.connect grant already widens the FIRST served document\'s header the same way', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const { broker } = await restartedWithAPersistedGrant(
      storage, { net: { https: { connect: SECURE_GRANTED_PATTERNS } } }, 'https.connect', SECURE_GRANTED_PATTERNS
    )

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const response = await handler(new Request(`${ORIGIN}/`))

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
      "img-src 'self' granted.example:443; font-src 'self' granted.example:443; media-src 'self' granted.example:443"
    )

    vi.doUnmock('electron')
  })

  it('THE LIVE GATE ALSO WORKS, NOT JUST THE HEADER: a real third-party https.connect request to the granted host SUCCEEDS on the very first request after a restart', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const { broker } = await restartedWithAPersistedGrant(
      storage, { net: { https: { connect: SECURE_GRANTED_PATTERNS } } }, 'https.connect', SECURE_GRANTED_PATTERNS
    )

    const session = fakeSession()
    // `nodeReachDial` is a STATIC top-level import in electron-serve.ts, not
    // a per-call `await import(...)` like 'electron' -- so it is bound once,
    // whenever that module is first linked. Every earlier test in this file
    // already imported it (unmocked), so mocking `serve-reach.js` alone
    // would not reach that stale binding; resetModules forces a fresh link.
    vi.resetModules()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    vi.doMock('../serve-reach.js', () => ({
      nodeReachDial: () => async (_request: Request, _host: string, _port: number) => new Response('granted bytes', { status: 200 })
    }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    // Before this lane, authoriseReachFor's live read of broker.app.grants
    // came back empty during this exact window and this request was
    // refused with a 404, even though the header above already claimed
    // wider reach (the whole point A158 named as still real and dangerous).
    // It is no longer empty: the grant was hydrated before this handler was
    // ever registered.
    const response = await handler(new Request('https://granted.example/font.woff2'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('granted bytes')

    vi.doUnmock('../serve-reach.js')
    vi.doUnmock('electron')
  })

  it('THE OWNER\'S POINT, END TO END: a later real registerApp call with a manifest that no longer declares the capability drops it, even though it was already live from the pinned one', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const { broker } = await restartedWithAPersistedGrant(
      storage, { net: { tcp: { connect: GRANTED_PATTERNS } } }, 'tcp.connect', GRANTED_PATTERNS
    )

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const beforeRegisterApp = await handler(new Request(`${ORIGIN}/`))
    expect(beforeRegisterApp.headers.get('content-security-policy')).toContain('api.example.com:443')

    // The page loads, reports its manifest hint, and the real manifest --
    // fetched fresh over the network -- no longer declares net.tcp.connect
    // at all. The owner's own reasoning: a manifest change is itself enough
    // to restart the status of permissions, so this must be authoritative,
    // dropping what the pinned manifest still had.
    broker.registerApp(ORIGIN, manifestWith({}))

    const afterRegisterApp = await handler(new Request(`${ORIGIN}/`))
    expect(afterRegisterApp.headers.get('content-security-policy')).not.toContain('api.example.com')

    vi.doUnmock('electron')
  })

  it('A LATER MANIFEST THAT NO LONGER COVERS THE FULL GRANTED PATTERN SET DROPS THE WHOLE CAPABILITY (all-or-nothing, GrantLedger\'s own pre-existing rule -- decideGrantRequest never narrows to a subset)', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const bothHosts = ['api.example.com:443', 'second.example.com:443']
    const { broker } = await restartedWithAPersistedGrant(
      storage, { net: { tcp: { connect: bothHosts } } }, 'tcp.connect', bothHosts
    )

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const beforeRegisterApp = await handler(new Request(`${ORIGIN}/`))
    expect(beforeRegisterApp.headers.get('content-security-policy')).toContain("connect-src 'self' api.example.com:443 second.example.com:443")

    // The fresh manifest declares LESS than the persisted grant held --
    // `decideGrantRequest`'s existing widensAuthority check refuses the
    // WHOLE capability rather than narrowing it to the covered subset, the
    // same all-or-nothing rule an ordinary (non-pinned) restore has always
    // applied. This lane changes WHEN that check runs, never what it does.
    broker.registerApp(ORIGIN, manifestWith({ net: { tcp: { connect: GRANTED_PATTERNS } } }))

    const afterRegisterApp = await handler(new Request(`${ORIGIN}/`))
    expect(afterRegisterApp.headers.get('content-security-policy')).toContain("connect-src 'self';")
    expect(afterRegisterApp.headers.get('content-security-policy')).not.toContain('example.com')

    vi.doUnmock('electron')
  })

  it('DOES NOT WIDEN AN ORIGIN WHOSE PIN FAILS RE-VERIFICATION -- a tampered bundle gets nothing hydrated and stays denied', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    const { broker } = await restartedWithAPersistedGrant(
      storage, { net: { tcp: { connect: GRANTED_PATTERNS } } }, 'tcp.connect', GRANTED_PATTERNS
    )
    // Tampered AFTER pinning, but BEFORE the restart's restorePinnedServing
    // call -- verifyPinnedTree must refuse this bundle, and nothing may be
    // hydrated from a manifest this codebase never proved unchanged.
    await storage.writeAsset(ORIGIN, '/index.html', utf8('tampered'))

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)

    expect(await broker.app.grants(ORIGIN)).toEqual([])
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request(`${ORIGIN}/`))
    expect(response.status).toBe(404)

    vi.doUnmock('electron')
  })

  it('DOES NOT WIDEN AN ORIGIN WITH NO PERSISTED GRANT AT ALL -- the ordinary case stays exactly self-only', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, ORIGIN)
    // A broker backed by real, empty ledger storage -- this origin was
    // never granted anything by anyone, in any session.
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    await restorePinnedServing(storage, broker)

    expect(await broker.app.grants(ORIGIN)).toEqual([])
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request(`${ORIGIN}/`))
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
      "img-src 'self'; font-src 'self'; media-src 'self'"
    )

    vi.doUnmock('electron')
  })
})

// A200 (docs/open-questions.md): the real wiring, not the fakeBroker-shaped
// enforcement serve.test.ts's own A200 suite already proves -- a REAL
// createBroker, a manifest that actually DECLARES net.concurrentSockets,
// and a REAL Broker.app.socketAllowanceSync reached through
// registerServingFor's own reachSlotsFor, the same seam authoriseReachFor
// already uses for the live grant check.
describe('registerServingFor -- A200 real wiring (reach socket allowance)', () => {
  it('enforces this origin\'s REAL manifest-declared concurrentSockets end to end, and restores the slot once the held request finishes', async () => {
    const ORIGIN = 'https://reach-allowance.example'
    const userData = await mkdtemp(join(tmpdir(), 'orivon-reach-allowance-'))
    const storage = nodeLoaderStorage(userData)
    const capabilities = { net: { https: { connect: ['granted.example:443'] }, concurrentSockets: 1 } }
    await pinRealOrigin(storage, ORIGIN, { capabilities })

    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
    broker.registerApp(ORIGIN, manifestWith(capabilities))
    await broker.grant(ORIGIN, 'https.connect', ['granted.example:443'])
    // The exact number `net.connect`/`net.connectSecure`/`net.listen` already
    // enforce for a live handle -- proven live, not merely declared.
    expect(broker.app.socketAllowanceSync(ORIGIN)).toBe(1)

    const session = fakeSession()
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
    vi.resetModules() // see "THE LIVE GATE ALSO WORKS" above for why this precedes mocking serve-reach.js
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    vi.doMock('../serve-reach.js', () => ({
      nodeReachDial: () => async () => new Response(new ReadableStream<Uint8Array>({ start: (c) => { controllers.push(c) } }))
    }))
    const { registerServingFor } = await import('../electron-serve.js')
    await registerServingFor(storage, ORIGIN, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const first = await handler(new Request('https://granted.example/a'))
    expect(first.status).toBe(200)

    // The allowance is 1: a second CONCURRENT reach must be refused, not
    // silently dialled alongside the first.
    const second = await handler(new Request('https://granted.example/b'))
    expect(second.status).toBe(404)

    controllers.forEach((c) => { c.close() })
    await first.text()

    // Restored once the held request actually finished.
    const third = await handler(new Request('https://granted.example/c'))
    expect(third.status).toBe(200)

    vi.doUnmock('../serve-reach.js')
    vi.doUnmock('electron')
  })
})
