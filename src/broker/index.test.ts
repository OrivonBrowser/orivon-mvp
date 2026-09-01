import { describe, expect, it, vi } from 'vitest'
import { never, outcomeNow, rejection } from './handles.test-helpers.js'
import { createBroker } from './index.js'
import type { CreateBrokerOptions, Dial, DialedSocket } from './index.js'
import type { Capabilities, Manifest } from '../contracts/index.js'
import { LIMITS } from '../contracts/index.js'

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
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

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
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

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
    await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

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
    await broker.grant(APP, 'tcp.connect', ['rebind.example:80'])

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
    const g = await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const socket = await broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    await broker.revoke(APP, g.id)

    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })

  it('is left open when an unrelated origin\'s grant of the same capability is revoked', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
    broker.registerApp(OTHER, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const otherGrant = await broker.grant(OTHER, 'tcp.connect', ['93.184.216.34:443'])

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
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, '../../etc/passwd'))
    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })
})

describe('raw I/O errors are mapped onto the closed OrivonErrorCode enum (MAJOR)', () => {
  // contracts/errors.ts: "An app may switch on this exhaustively and treat
  // an unrecognised value as a bug." stubResolve and the default stubFs
  // above can never reject, so none of the suite above can catch this --
  // these stubs reject on purpose, the way a real DNS failure or a real
  // ENOENT would.

  it('maps a dial ECONNREFUSED to unreachable, carrying the errno as platformCode', async () => {
    const dial: Dial = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), { code: 'ECONNREFUSED' })
    }
    const broker = createBroker(baseDeps({ dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const error = await rejection(broker.net.connect(APP, { host: '93.184.216.34', port: 443 }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ECONNREFUSED')
    // The original message is never forwarded -- only the Node convention
    // (`err.code`) survives, via platformCode.
    expect(error.message).not.toContain('ECONNREFUSED')
  })

  it('maps a resolve ENOTFOUND to unreachable', async () => {
    const resolve = async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' })
    }
    const broker = createBroker(baseDeps({ resolve }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['example.com:443'])

    const error = await rejection(broker.net.connect(APP, { host: 'example.com', port: 443 }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ENOTFOUND')
  })

  it('maps an fs.readFile ENOENT to notFound, and never forwards the confined path (info leak)', async () => {
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, open '/apps/app/missing.txt'"), { code: 'ENOENT' })
      },
      writeFile: async () => {}
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, 'missing.txt'))

    expect(error.code).toBe('notFound')
    expect(error.platformCode).toBe('ENOENT')
    // security-model.md T13b: the confinement root is sha256(canonical
    // origin) under the app data directory. Handing the app its own full
    // on-disk path tells it exactly where that boundary sits.
    expect(error.message).not.toContain('/apps/app')
    expect(error.message).not.toContain('missing.txt')
  })

  it('maps an fs EACCES to denied, which never carries a platformCode', async () => {
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
      writeFile: async () => {}
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, 'secret.txt'))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('maps an unrecognised errno to internal, fail-closed', async () => {
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => {
        throw Object.assign(new Error('EWEIRD: not in the mapping table'), { code: 'EWEIRD' })
      },
      writeFile: async () => {}
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, 'a.txt'))

    expect(error.code).toBe('internal')
    expect(error.platformCode).toBe('EWEIRD')
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
    const g = await broker.grant(APP, 'tcp.connect', ['api.example.com:443'])

    await expect(broker.app.grants(APP)).resolves.toEqual([g])
  })

  it('re-registering a manifest leaves existing grants untouched', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))
    const g = await broker.grant(APP, 'tcp.connect', ['a.example:443'])

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
    await broker.grant(APP, 'fs', [])

    await broker.fs.writeFile(APP, 'notes.txt', new TextEncoder().encode('hi'))
    expect(files.get('/apps/app/notes.txt')).toEqual(new TextEncoder().encode('hi'))
    await expect(broker.fs.readFile(APP, 'notes.txt')).resolves.toEqual(new TextEncoder().encode('hi'))
  })

  it('denies a traversal attempt outside the app root', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, '../../etc/passwd'))
    expect(error.code).toBe('denied')
  })

  it('revoking the fs grant denies subsequent reads and writes', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])
    await broker.revoke(APP, g.id)

    const error = await rejection(broker.fs.readFile(APP, 'a.txt'))
    expect(error.code).toBe('denied')
  })
})

describe('fs.writeFile enforces manifest.capabilities.fs.quotaBytes (MAJOR)', () => {
  // contracts/manifest.ts: "ENFORCED, not advisory ... The broker maintains
  // a running per-origin byte counter, checks it on write, and yields
  // 'limit' when exceeded." Only the running-counter half is implemented
  // here -- reconciling against the directory on startup needs a persisted
  // counter that does not exist yet, filed as A29 (cross-cutting.md) rather
  // than built into this PR.

  it('allows a write that fits within the declared quota', async () => {
    const files = new Map<string, Uint8Array>()
    const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])

    await broker.fs.writeFile(APP, 'a.bin', new Uint8Array(1000))

    expect(files.get('/apps/app/a.bin')).toHaveLength(1000)
  })

  it('rejects a single write that would exceed the declared quota, without calling deps.fs.writeFile', async () => {
    const writeFile = vi.fn(async () => {})
    const fs: CreateBrokerOptions['fs'] = { ...stubFs(), writeFile }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.writeFile(APP, 'big.bin', new Uint8Array(2000)))

    expect(error.code).toBe('limit')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('accumulates across writes and rejects once the running total would exceed the quota', async () => {
    // Five 1MB writes against a 1KB quota, exactly pr-31.md's failing
    // scenario: before this fix, all five were accepted.
    const files = new Map<string, Uint8Array>()
    const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1024 } }))
    await broker.grant(APP, 'fs', [])

    for (let i = 0; i < 5; i += 1) {
      const error = await rejection(broker.fs.writeFile(APP, `blob${String(i)}.bin`, new Uint8Array(1_000_000)))
      expect(error.code).toBe('limit')
    }

    expect(files.size).toBe(0)
  })

  it('lets a second write land once it fits under what remains of the quota', async () => {
    const files = new Map<string, Uint8Array>()
    const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1500 } }))
    await broker.grant(APP, 'fs', [])

    await broker.fs.writeFile(APP, 'a.bin', new Uint8Array(1000))
    const error = await rejection(broker.fs.writeFile(APP, 'b.bin', new Uint8Array(1000)))

    expect(error.code).toBe('limit')
    expect(files.has('/apps/app/b.bin')).toBe(false)
    expect(files.get('/apps/app/a.bin')).toHaveLength(1000)
  })

  it('writes freely when the manifest declares no quota at all', async () => {
    const files = new Map<string, Uint8Array>()
    const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    await broker.fs.writeFile(APP, 'huge.bin', new Uint8Array(10_000_000))

    expect(files.get('/apps/app/huge.bin')).toHaveLength(10_000_000)
  })
})

describe('fs reads and writes share the per-origin in-flight cap (CRITICAL, T11b)', () => {
  /** Both I/O methods stall forever -- for proving the shared budget and abort-signal cancellation, never their result. */
  function stallingFs (): CreateBrokerOptions['fs'] {
    return {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => await never<Uint8Array>(),
      writeFile: async () => { await never<void>() }
    }
  }

  it('rejects a read past LIMITS.inFlightOperations immediately, without queueing', async () => {
    const broker = createBroker(baseDeps({ fs: stallingFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    for (let i = 0; i < LIMITS.inFlightOperations; i += 1) {
      void broker.fs.readFile(APP, `f${String(i)}.txt`).catch(() => {})
    }

    // Before this fix, fs.readFile called deps.fs.readFile directly --
    // outside handleTable.run -- so LIMITS.inFlightOperations (256) simply
    // did not apply to it at all: a loop of reads could hang the whole
    // broker, which is security-model.md's own named threat T11b.
    const outcome = await outcomeNow(broker.fs.readFile(APP, 'one-too-many.txt'))
    expect(outcome.state).toBe('rejected')
    expect(outcome.state === 'rejected' ? outcome.error.code : null).toBe('limit')
  })

  it('revoking the fs grant mid-read makes the pending call reject with revoked', async () => {
    const broker = createBroker(baseDeps({ fs: stallingFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])

    const pending = broker.fs.readFile(APP, 'a.txt')
    await broker.revoke(APP, g.id)

    // outcomeNow, not rejection: an unfixed broker calls deps.fs.readFile
    // directly, outside handleTable.run, so revoke() has nothing to cancel
    // and this promise would otherwise hang until the stalling stub's
    // never-settling read is garbage collected -- i.e. the whole test.
    const outcome = await outcomeNow(pending)
    expect(outcome.state).toBe('rejected')
    expect(outcome.state === 'rejected' ? outcome.error.code : null).toBe('revoked')
  })

  it('revoking the fs grant mid-write rejects the call, even though the write itself later completes', async () => {
    // The write reaching disk cannot be undone, but the app must never be
    // told it succeeded for a grant it no longer holds -- pr-31.md's
    // aggravating factor (b): "the write silently completes and the app
    // receives confirmation for an operation performed after its grant was
    // withdrawn."
    let resolveWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { resolveWrite = resolve })
    const written: Array<{ path: string, data: Uint8Array }> = []
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => await never<Uint8Array>(),
      writeFile: async (path, data) => {
        written.push({ path, data })
        await writeGate
      }
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])

    const pending = broker.fs.writeFile(APP, 'a.txt', new Uint8Array([1]))
    await broker.revoke(APP, g.id)
    resolveWrite()

    const error = await rejection(pending)
    expect(error.code).toBe('revoked')
    expect(written).toEqual([{ path: '/apps/app/a.txt', data: new Uint8Array([1]) }])
  })
})

describe('revocation delegates to the handle table\'s cascade (handle-contracts.md SSRevocation)', () => {
  it('closes an open socket the moment its grant is revoked, before the app finishes anything', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    const g = await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])
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
    const g = await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

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

describe('signal.aborted is checked before dial(), not only after (MINOR)', () => {
  it('never calls dial when the grant is revoked while resolve is still pending', async () => {
    // Without this check, correctness depends entirely on the INJECTED dial
    // implementation independently honouring an already-aborted signal --
    // this proves the broker itself does not rely on that.
    let resolveDns!: (addresses: readonly string[]) => void
    const dnsPending = new Promise<readonly string[]>((resolve) => { resolveDns = resolve })
    const resolve = async (): Promise<readonly string[]> => await dnsPending
    const dial = vi.fn(async () => okSocket())
    const broker = createBroker(baseDeps({ resolve, dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['example.com:443'] } } }))
    const g = await broker.grant(APP, 'tcp.connect', ['example.com:443'])

    const pending = broker.net.connect(APP, { host: 'example.com', port: 443 })
    await nextTick()

    await broker.revoke(APP, g.id)
    // The DNS answer "arrives" only now -- late, after the grant is gone.
    resolveDns(['93.184.216.34'])

    const error = await rejection(pending)
    expect(error.code).toBe('revoked')

    await nextTick()
    expect(dial).not.toHaveBeenCalled()
  })
})

describe('grant() replaces, under a fresh id (open-questions.md A21)', () => {
  it('a second grant of the same capability replaces the first', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const first = await broker.grant(APP, 'tcp.connect', ['a.example:443'])
    const second = await broker.grant(APP, 'tcp.connect', ['b.example:443'])

    expect(second.id).not.toBe(first.id)
    await expect(broker.app.grants(APP)).resolves.toEqual([second])
  })
})

describe('a superseded grant is revoked, not just dropped from the ledger (CRITICAL)', () => {
  it('closes a handle already authorised by the replaced grant the moment the new grant lands', async () => {
    const resolve = stubResolve({ 'example.com': ['93.184.216.34'] })
    const broker = createBroker(baseDeps({ resolve }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['*:*'] } } }))
    const g1 = await broker.grant(APP, 'tcp.connect', ['example.com:443'])
    const socket = await broker.net.connect(APP, { host: 'example.com', port: 443 })

    // g2 replaces g1 in the ledger. Before the fix, g1's socket stays open
    // forever: app.grants() drops g1 instantly and there is no code path
    // back to its id from anywhere -- not the app, not the permission UI.
    const g2 = await broker.grant(APP, 'tcp.connect', ['other.example:443'])
    expect(g2.id).not.toBe(g1.id)

    // outcomeNow, not rejection: an unfixed broker never settles this
    // promise at all, and this must fail fast rather than hang the suite.
    const outcome = await outcomeNow(socket.closed)
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') expect(outcome.error.code).toBe('revoked')

    await expect(broker.app.grants(APP)).resolves.toEqual([g2])
  })

  it('destroys a socket dialled after its grant was superseded mid-flight, and never registers it under the stale id', async () => {
    // Mirrors the explicit-revoke() race test above, but the trigger is a
    // supersession instead. Reproduces the race pr-31.md documents:
    // connect() captures `current` once, before two await points, and a
    // grant() landing in between must still close what gets dialled late.
    let resolveDial!: (socket: DialedSocket) => void
    const dialed = new Promise<DialedSocket>((resolve) => { resolveDial = resolve })
    const destroySpy = vi.fn()
    const dial: Dial = async () => await dialed
    const broker = createBroker(baseDeps({ dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const pending = broker.net.connect(APP, { host: '93.184.216.34', port: 443 })
    // Let checkConnect (a literal address, no real DNS) run to completion and
    // reach `dial`, which is now stuck awaiting `dialed`.
    await nextTick()

    await broker.grant(APP, 'tcp.connect', ['other.example:443'])

    // outcomeNow, not rejection: an unfixed broker leaves `pending` sitting
    // there until `dial` eventually resolves (below), which would hang this
    // test for its full timeout instead of failing cleanly.
    const outcome = await outcomeNow(pending)
    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') expect(outcome.error.code).toBe('revoked')

    // The dial "completes" only now -- late, after the superseding grant landed.
    resolveDial(okSocket({ destroy: destroySpy }))
    await nextTick()

    expect(destroySpy).toHaveBeenCalledWith('revoked')
    expect(destroySpy).not.toHaveBeenCalledWith('failed')
  })
})

describe('origin canonicalisation (policy/origin.ts)', () => {
  it('treats an explicit default port the same as no port at all', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(`${APP}:443`, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const socket = await broker.net.connect(`${APP}:443`, { host: '93.184.216.34', port: 443 })
    await socket.close()
  })

  it('reports an internal fault, never a denial, for a string that is not an origin', async () => {
    const broker = createBroker(baseDeps())
    const error = await rejection(broker.net.connect('not a url', { host: 'x', port: 1 }))
    expect(error.code).toBe('internal')
  })
})

