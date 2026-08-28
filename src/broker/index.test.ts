import { describe, expect, it, vi } from 'vitest'
import { rejection } from './handles.test-helpers.js'
import { createBroker } from './index.js'
import type { CreateBrokerOptions, Dial, DialedSocket } from './index.js'
import type { Capabilities, Manifest } from '../contracts/index.js'

// This is the assembly step build-plan.md's "Structural decision, day 1"
// exists for: everything under ./policy/ is a decision function, and this
// suite is what proves createBroker actually MAKES the decision from the
// GRANTED set, never the manifest's DECLARED one (open-questions.md A18) --
// the single idea the whole task is about.
//
// EVERY TEST BELOW was checked against a deliberately-broken implementation
// while writing it (see the PR body): the ledger read from the manifest
// instead of the grant, the resolve step skipped in favour of comparing the
// hostname string, a socket registered under the wrong origin, a denial
// carrying a platformCode, and `app.manifest()` returning a plain value.
// Each one was watched to fail before being fixed back. A passing suite
// proves nothing until it has been watched to fail.

const APP = 'https://app.example'
const OTHER = 'https://other.example'

function manifestWith (capabilities: Capabilities): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'org.orivon.test',
    name: 'Test app',
    version: '1.0.0',
    entry: '/index.html',
    capabilities
  }
}

/** A DialedSocket that never touches a real stream -- readable/writable are never read from in these tests. */
function okSocket (overrides: Partial<DialedSocket> = {}): DialedSocket {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    remoteAddress: '93.184.216.34',
    remotePort: 443,
    localAddress: '10.0.0.5',
    localPort: 54321,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    destroy: vi.fn(),
    ...overrides
  }
}

interface StubResolve {
  (host: string): Promise<readonly string[]>
  readonly calls: string[]
}

/** Records what it was asked, so "resolve, never the hostname" is assertable. */
function stubResolve (answers: Readonly<Record<string, readonly string[]>>): StubResolve {
  const calls: string[] = []
  const fn = async (host: string): Promise<readonly string[]> => {
    calls.push(host)
    return answers[host] ?? []
  }
  return Object.assign(fn, { calls })
}

function stubFs (options: { root?: string, files?: Map<string, Uint8Array> } = {}): CreateBrokerOptions['fs'] {
  const root = options.root ?? '/apps/app'
  const files = options.files ?? new Map<string, Uint8Array>()
  return {
    rootFor: () => root,
    // Everything "exists" and resolves to itself. Confinement's own edge
    // cases (symlink escapes, Windows device names, ..) are policy/paths.ts's
    // suite; this file only has to prove createBroker calls it.
    realpathSync: (p) => p,
    readFile: async (path) => {
      const data = files.get(path)
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return data
    },
    writeFile: async (path, data) => { files.set(path, data) }
  }
}

function baseDeps (overrides: Partial<CreateBrokerOptions> = {}): CreateBrokerOptions {
  return {
    dial: overrides.dial ?? (async () => okSocket()),
    resolve: overrides.resolve ?? (async () => []),
    now: overrides.now ?? (() => 0),
    fs: overrides.fs ?? stubFs(),
    keychain: overrides.keychain ?? { getSeed: async () => new Uint8Array(32) }
  }
}

/** One real event-loop tick -- enough for a literal-address checkConnect (no real DNS) to reach `dial`. */
function nextTick (): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('the grant ledger is consulted, never the manifest (open-questions.md A18)', () => {
  it('denies a connection the manifest declares but the grant does not cover', async () => {
    // `evil.example` resolves to an ordinary PUBLIC address -- deliberately,
    // so the only thing standing between this call and a live socket is the
    // pattern check. Under the declared set ("*:*") this would be ALLOWED;
    // only reading the granted set denies it. A resolver that answered []
    // would deny for an unrelated reason (empty-resolution) and prove
    // nothing about which set was consulted.
    const broker = createBroker(baseDeps({ resolve: stubResolve({ 'evil.example': ['93.184.216.34'] }) }))
    // The flagship's own shape: declares "*:*", but the user granted one host.
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const error = await rejection(broker.net.connect(APP, { host: 'evil.example', port: 443 }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('denies every connection when the manifest declares broadly but nothing was ever granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))

    const error = await rejection(broker.net.connect(APP, { host: '93.184.216.34', port: 443 }))

    expect(error.code).toBe('denied')
  })

  it('allows a connection that is within the granted pattern, narrower than the declared one', async () => {
    const broker = createBroker(baseDeps({ resolve: stubResolve({ 'api.example.com': ['93.184.216.34'] }) }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    const socket = await broker.net.connect(APP, { host: 'api.example.com', port: 443 })

    expect(socket.remoteAddress).toBe('93.184.216.34')
    await socket.close()
  })
})

describe('resolve is actually consulted -- comparing the hostname alone is T12', () => {
  it('dials the resolved address, never the hostname the app supplied', async () => {
    const resolve = stubResolve({ 'api.example.com': ['93.184.216.34'] })
    const dialCalls: Array<{ addresses: readonly string[], port: number }> = []
    const dial: Dial = async (addresses, port) => {
      dialCalls.push({ addresses, port })
      return okSocket()
    }
    const broker = createBroker(baseDeps({ resolve, dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    await broker.net.connect(APP, { host: 'api.example.com', port: 443 })

    expect(resolve.calls).toEqual(['api.example.com'])
    expect(dialCalls).toEqual([{ addresses: ['93.184.216.34'], port: 443 }])
  })

  it('denies a rebinding attempt: the pattern matches the hostname but the resolved address is private', async () => {
    // A naive implementation that compares `hostArg` against the granted
    // pattern's host, and never calls resolve at all, would allow this.
    const resolve = stubResolve({ 'rebind.example': ['127.0.0.1'] })
    const dial = vi.fn(async () => okSocket())
    const broker = createBroker(baseDeps({ resolve, dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['rebind.example:80'] } } }))
    broker.grant(APP, 'tcp.connect', ['rebind.example:80'])

    const error = await rejection(broker.net.connect(APP, { host: 'rebind.example', port: 80 }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
    expect(dial).not.toHaveBeenCalled()
  })
})

describe('a handle is registered under the caller\'s own origin, never another\'s', () => {
  it('is closed by that origin\'s own revoke', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const g = broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const socket = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    await broker.revoke(APP, g.id)

    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })

  it('is left open when an unrelated origin\'s grant of the same capability is revoked', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
    broker.registerApp(OTHER, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const otherGrant = broker.grant(OTHER, 'tcp.connect', ['93.184.216.34:443'])

    const socket = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    await broker.revoke(OTHER, otherGrant.id)

    // If the socket had been registered under the wrong origin -- OTHER's, or
    // a shared constant -- this revoke would have closed it. Assert `closed`
    // has NOT settled, without waiting the test out.
    const settled = await Promise.race([
      socket.closed.then(() => true, () => true),
      nextTick().then(() => false)
    ])
    expect(settled).toBe(false)

    await socket.close()
  })
})

describe('a denial never carries detail it should not (errors.ts on \'denied\')', () => {
  it('a tcp.connect denial has no platformCode, whatever the reason', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.net.connect(APP, { host: 'x.example', port: 443 }))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('an fs denial has no platformCode, whatever the reason', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))
    broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, '../../etc/passwd'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })
})

describe('orivon.app.manifest() and orivon.app.grants() (open-questions.md A13)', () => {
  it('both return real Promises, not plain values', () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    expect(broker.app.manifest(APP)).toBeInstanceOf(Promise)
    expect(broker.app.grants(APP)).toBeInstanceOf(Promise)
  })

  it('manifest() resolves to what registerApp recorded', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })
    broker.registerApp(APP, manifest)

    await expect(broker.app.manifest(APP)).resolves.toBe(manifest)
  })

  it('manifest() is a broker fault for an origin nothing ever registered', async () => {
    const broker = createBroker(baseDeps())

    const error = await rejection(broker.app.manifest(APP))
    expect(error.code).toBe('internal')
  })

  it('grants() answers empty for an origin nothing ever registered', async () => {
    const broker = createBroker(baseDeps())
    await expect(broker.app.grants(APP)).resolves.toEqual([])
  })

  it('grants() reflects what was actually granted, narrower than the declared manifest', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    const g = broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    await expect(broker.app.grants(APP)).resolves.toEqual([g])
  })

  it('re-registering a manifest leaves existing grants untouched', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))
    const g = broker.grant(APP, 'tcp.connect', ['a.example:443'])

    broker.registerApp(APP, manifestWith({})) // e.g. a page reload

    await expect(broker.app.grants(APP)).resolves.toEqual([g])
  })
})

describe('orivon.fs reads and writes, confined via policy/paths.ts (T1/T10)', () => {
  it('denies reads and writes when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const readError = await rejection(broker.fs.readFile(APP, 'a.txt'))
    expect(readError.code).toBe('denied')

    const writeError = await rejection(broker.fs.writeFile(APP, 'a.txt', new Uint8Array()))
    expect(writeError.code).toBe('denied')
  })

  it('confines reads and writes to the app\'s own root', async () => {
    const files = new Map<string, Uint8Array>()
    const broker = createBroker(baseDeps({ fs: stubFs({ root: '/apps/app', files }) }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    broker.grant(APP, 'fs', [])

    await broker.fs.writeFile(APP, 'notes.txt', new TextEncoder().encode('hi'))
    expect(files.get('/apps/app/notes.txt')).toEqual(new TextEncoder().encode('hi'))
    await expect(broker.fs.readFile(APP, 'notes.txt')).resolves.toEqual(new TextEncoder().encode('hi'))
  })

  it('denies a traversal attempt outside the app root', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, '../../etc/passwd'))
    expect(error.code).toBe('denied')
  })

  it('revoking the fs grant denies subsequent reads and writes', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = broker.grant(APP, 'fs', [])
    await broker.revoke(APP, g.id)

    const error = await rejection(broker.fs.readFile(APP, 'a.txt'))
    expect(error.code).toBe('denied')
  })
})

describe('revocation delegates to the handle table\'s cascade (handle-contracts.md SSRevocation)', () => {
  it('closes an open socket the moment its grant is revoked, before the app finishes anything', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const g = broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
    const socket = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })

    await broker.revoke(APP, g.id)

    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })

  it('destroys a socket dialled after its grant was revoked mid-flight, and never registers it', async () => {
    let resolveDial!: (socket: DialedSocket) => void
    const dialed = new Promise<DialedSocket>((resolve) => { resolveDial = resolve })
    const destroySpy = vi.fn()
    const dial: Dial = async () => await dialed
    const broker = createBroker(baseDeps({ dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const g = broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const pending = broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    // Let checkConnect (a literal address, no real DNS) run to completion and
    // reach `dial`, which is now stuck awaiting `dialed`.
    await nextTick()

    await broker.revoke(APP, g.id)
    const error = await rejection(pending)
    expect(error.code).toBe('revoked')

    // The dial "completes" only now -- late, after the grant is gone.
    resolveDial(okSocket({ destroy: destroySpy }))
    await nextTick()

    // A live socket must be torn down as 'revoked', not silently released as
    // 'failed' -- see index.ts's own note on why this check exists.
    expect(destroySpy).toHaveBeenCalledWith('revoked')
    expect(destroySpy).not.toHaveBeenCalledWith('failed')
  })

  it('revoking an id nobody holds is a no-op, not a throw', async () => {
    const broker = createBroker(baseDeps())
    await expect(broker.revoke(APP, 'no-such-grant')).resolves.toBeUndefined()
  })
})

describe('grant() replaces, under a fresh id (open-questions.md A21)', () => {
  it('a second grant of the same capability replaces the first', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const first = broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const second = broker.grant(APP, 'tcp.connect', ['b.example:443'])

    expect(second.id).not.toBe(first.id)
    await expect(broker.app.grants(APP)).resolves.toEqual([second])
  })
})

describe('origin canonicalisation (policy/origin.ts)', () => {
  it('treats an explicit default port the same as no port at all', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(`${APP}:443`, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const socket = await broker.net.connect(`${APP}:443`, { host: '93.184.216.34', port: 443 })
    await socket.close()
  })

  it('reports an internal fault, never a denial, for a string that is not an origin', async () => {
    const broker = createBroker(baseDeps())
    const error = await rejection(broker.net.connect('not a url', { host: 'x', port: 1 }))
    expect(error.code).toBe('internal')
  })
})

