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

/** A real pinned bundle on disk, at `origin` -- shared by every describe
 * block below that needs a genuinely servable app rather than just a
 * registration call. */
async function pinRealOrigin (storage: ReturnType<typeof nodeLoaderStorage>, origin: string): Promise<void> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    { path: '/index.html', content: utf8('<h1>hi</h1>') }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

/** A minimal `Broker` stub -- only `app.grants` is ever called on this path
 * (`grantedConnectPatternsFor`), so nothing else needs a real implementation. */
function fakeBroker (grants: readonly Grant[]): Broker {
  return { app: { grants: vi.fn(async () => grants) } } as unknown as Broker
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
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
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

  it('reads the broker fresh on every request through the SAME handler -- a revoke narrows the very next request, no re-registration', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app.example')

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../electron-serve.js')

    const grant: Grant = { id: 'g1', origin: 'https://app.example', capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0 }
    const grantsSpy = vi.fn(async () => [grant])
    const broker = { app: { grants: grantsSpy } } as unknown as Broker
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

    const broker = { app: { grants: vi.fn(async () => { throw new Error('ledger read failed') }) } } as unknown as Broker
    await registerServingFor(storage, 'https://app.example', broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    const response = await handler(new Request('https://app.example/'))

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
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

describe('restorePinnedServing across a restart -- a real, persisted grant is not yet readable (A158)', () => {
  // A158 (docs/open-questions.md): restorePinnedServing runs in
  // loaderSubsystem.afterReady BEFORE any window exists, so the ledger it
  // hands to registerServingFor has never had registerApp called on THIS
  // origin THIS run -- registerApp's only production callers fire after a
  // page has already loaded and reported its manifest hint. GrantLedger's
  // own `grantsHydrated` doc says a persisted grant becomes readable only
  // on that first registerApp call, because re-validating it needs a
  // manifest. This suite uses a REAL GrantLedger/createBroker against a
  // REAL LedgerStorage double, not the fakeBroker stub above, so it proves
  // the defect against the actual hydration mechanism, not an assumption
  // about it.
  const ORIGIN = 'https://app.example'
  const GRANTED_PATTERNS = ['api.example.com:443']

  async function brokerRestartedWithAPersistedGrant (): Promise<{ ledgerStorage: ReturnType<typeof memoryLedgerStorage>, broker: Broker }> {
    // Session 1: the app was really installed and really granted, by a
    // person, and that landed on disk (persistGrants, A23).
    const ledgerStorage = memoryLedgerStorage()
    const firstRun = createBroker(baseDeps({ ledgerStorage }))
    firstRun.registerApp(ORIGIN, manifestWith({ net: { tcp: { connect: GRANTED_PATTERNS } } }))
    await firstRun.grant(ORIGIN, 'tcp.connect', GRANTED_PATTERNS)

    // Session 2: a restart. A fresh GrantLedger, same persisted storage --
    // exactly what loaderSubsystem.afterReady constructs before any window
    // exists (src/broker/transport/ipc.ts wires the real equivalent).
    return { ledgerStorage, broker: createBroker(baseDeps({ ledgerStorage })) }
  }

  it('serves the first document with a self-only CSP even though a real, persisted grant exists for this origin', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, ORIGIN)
    const { broker } = await brokerRestartedWithAPersistedGrant()

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    const response = await handler(new Request(`${ORIGIN}/`))

    // THE DEFECT: connect-src is 'self' only. The grant above is real and
    // persisted, but broker.app.grants(ORIGIN) reads GrantLedger.grantsFor,
    // which returns [] until this origin's grantsHydrated flag is set --
    // and nothing has called registerApp on THIS broker instance yet, so it
    // never has been. A person who already approved this app's network
    // access sees it fail as though they never had.
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'"
    )

    vi.doUnmock('electron')
  })

  it('THE RECOVERY PATH: once registerApp runs for this origin (the normal manifest-hint flow), the SAME already-registered handler reflects the real grant on its very next request -- no re-registration', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, ORIGIN)
    const { broker } = await brokerRestartedWithAPersistedGrant()

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    await restorePinnedServing(storage, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')

    // A person reloads (or the tab simply navigates again) after the page's
    // own manifest hint has been reported and the normal flow has called
    // registerApp with a freshly fetched manifest -- app-install.ts's real
    // production path, simulated here directly on the SAME broker instance
    // restorePinnedServing was given above.
    broker.registerApp(ORIGIN, manifestWith({ net: { tcp: { connect: GRANTED_PATTERNS } } }))

    const response = await handler(new Request(`${ORIGIN}/`))

    // This is what makes "a reload fixes it" true rather than assumed:
    // registerServingFor's handler closure reads broker.app.grants(ORIGIN)
    // fresh on every request (electron-serve.ts's own doc on
    // grantedConnectPatternsFor), so the SAME handler this suite's sibling
    // test found serving 'self'-only now answers with the real grant, with
    // no re-registration and no new protocol.handle call.
    expect(response.headers.get('content-security-policy')).toContain('api.example.com:443')

    vi.doUnmock('electron')
  })

  it('THE HONEST PART: logs a diagnostic naming the origin, since the CSP itself must still start narrow -- widening it from unvalidated disk state is the mistake A137 rejected', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, ORIGIN)
    const { broker } = await brokerRestartedWithAPersistedGrant()

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await restorePinnedServing(storage, broker)

    expect(warnSpy).toHaveBeenCalledWith(
      '[loader]', ORIGIN, expect.stringContaining('not yet reflected'), expect.stringContaining('A158')
    )

    warnSpy.mockRestore()
    vi.doUnmock('electron')
  })

  it('logs nothing for an origin with no persisted grant at all -- the ordinary case must stay quiet', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, ORIGIN)
    // A broker backed by real, empty ledger storage -- this origin was
    // never granted anything by anyone, in any session.
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await restorePinnedServing(storage, broker)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    vi.doUnmock('electron')
  })

  it('logs nothing with no broker at all -- there is no ledger to have missed hydrating', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restart-csp-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, ORIGIN)

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../electron-serve.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await restorePinnedServing(storage)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    vi.doUnmock('electron')
  })
})
