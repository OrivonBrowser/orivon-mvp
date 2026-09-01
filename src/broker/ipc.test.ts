import { createHash } from 'node:crypto'
import { mkdtemp, readFile as fsReadFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleControlRequest, nodeFs, registerBrokerIpc } from './ipc.js'
import type { ControlEvent, IpcMainLike } from './ipc.js'
import type { Broker } from './index.js'
import type { Grant, Manifest, OrivonError, TcpSocket } from '../contracts/index.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'

// This suite is what proves handleControlRequest is the thing DoD rule 1
// describes -- origin from the SENDER FRAME, never from the payload -- and
// that a failure always crosses the boundary as the closed enum (rule 4),
// not as whatever the broker or Node happened to throw. Every test below was
// checked against a broken implementation while writing it (see the PR
// body): the origin check skipped in favour of trusting payload.origin, the
// timeout wrapper removed, a denial forwarding its platformCode, and
// net.connect's response carrying the raw socket. Each was watched to fail
// before being fixed back.

const APP = 'https://app.example'
const OTHER = 'https://other.example'

/** A ControlEvent whose senderFrame resolves to `origin` via originFromSenderFrame. */
function frameFor (origin: string): ControlEvent {
  return { senderFrame: { url: `${origin}/index.html`, origin } }
}

const NO_FRAME: ControlEvent = { senderFrame: null }

function envelope (method: string, payload: unknown, timeoutMs = 1_000): RequestEnvelope<unknown> {
  return { id: 'req-1', method, payload, timeoutMs }
}

/** A promise that never settles -- models a broker call still in flight when a timeout fires. */
function never<T> (): Promise<T> {
  return new Promise<T>(() => {})
}

interface BrokerCall { readonly method: string, readonly origin: string, readonly args: unknown }

/**
 * A full `Broker`, every method recording its call into `calls` before
 * deferring to `overrides` (or rejecting "not stubbed" if the test never
 * asked for that method to succeed). `registerApp`/`grant`/`revoke` are
 * unused by ipc.ts -- see broker/index.ts's own doc on why they have no
 * orivon.* counterpart -- and are never expected to be called here.
 */
function stubBroker (
  calls: BrokerCall[],
  overrides: Partial<{
    manifest: (origin: string) => Promise<Manifest>
    grants: (origin: string) => Promise<readonly Grant[]>
    connect: (origin: string, opts: { host: string, port: number }) => Promise<TcpSocket>
    readFile: (origin: string, path: string) => Promise<Uint8Array>
    writeFile: (origin: string, path: string, data: Uint8Array) => Promise<void>
  }> = {}
): Broker {
  const notStubbed = async (): Promise<never> => { throw new Error('this stub method was not configured for this test') }
  return {
    app: {
      manifest: async (origin) => {
        calls.push({ method: 'app.manifest', origin, args: undefined })
        return await (overrides.manifest?.(origin) ?? notStubbed())
      },
      grants: async (origin) => {
        calls.push({ method: 'app.grants', origin, args: undefined })
        return await (overrides.grants?.(origin) ?? notStubbed())
      }
    },
    net: {
      connect: async (origin, opts) => {
        calls.push({ method: 'net.connect', origin, args: opts })
        return await (overrides.connect?.(origin, opts) ?? notStubbed())
      }
    },
    fs: {
      readFile: async (origin, path) => {
        calls.push({ method: 'fs.readFile', origin, args: path })
        return await (overrides.readFile?.(origin, path) ?? notStubbed())
      },
      writeFile: async (origin, path, data) => {
        calls.push({ method: 'fs.writeFile', origin, args: { path, data } })
        await (overrides.writeFile?.(origin, path, data) ?? notStubbed())
      }
    },
    registerApp: () => { throw new Error('registerApp is not reachable via orivon.* and should never be called here') },
    grant: () => { throw new Error('grant is not reachable via orivon.* and should never be called here') },
    revoke: async () => { throw new Error('revoke is not reachable via orivon.* and should never be called here') }
  }
}

function fakeTcpSocket (overrides: Partial<TcpSocket> = {}): TcpSocket {
  return {
    id: 'handle-1',
    closed: new Promise(() => {}),
    close: async () => {},
    readable: new ReadableStream(),
    writable: new WritableStream(),
    remoteAddress: '93.184.216.34',
    remotePort: 443,
    localAddress: '10.0.0.5',
    localPort: 54321,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    ...overrides
  }
}

describe('origin derivation (DoD rule 1 -- never the payload)', () => {
  it('denies with no authenticated origin when senderFrame is null', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), NO_FRAME, envelope('app.manifest', undefined))
    expect(response).toEqual({ id: 'req-1', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('denies when the frame is opaque (url and claimed origin disagree)', async () => {
    const calls: BrokerCall[] = []
    const event: ControlEvent = { senderFrame: { url: `${APP}/sandboxed`, origin: 'null' } }
    const response = await handleControlRequest(stubBroker(calls), event, envelope('app.manifest', undefined))
    expect(response.ok).toBe(false)
    expect(calls).toEqual([])
  })

  // MUTATION TEST: an implementation that read `payload.origin` instead of
  // (or in addition to) the sender frame would call the broker with the
  // attacker-chosen origin below rather than APP. Asserting the exact
  // recorded call catches that regardless of which origin such a bug used.
  it('uses the sender frame origin, never one embedded in the payload', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { readFile: async () => new Uint8Array([1, 2, 3]) })
    const hostilePayload = { path: '/f.txt', origin: 'https://attacker.example' }

    await handleControlRequest(broker, frameFor(APP), envelope('fs.readFile', hostilePayload))

    expect(calls).toEqual([{ method: 'fs.readFile', origin: APP, args: '/f.txt' }])
  })
})

describe('the five wired control operations', () => {
  it('app.manifest calls broker.app.manifest with the derived origin', async () => {
    const calls: BrokerCall[] = []
    const manifest: Manifest = { orivonApiVersion: 0, id: 'org.orivon.test', name: 'Test', version: '1.0.0', entry: '/index.html', capabilities: {} }
    const broker = stubBroker(calls, { manifest: async () => manifest })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.manifest', undefined))

    expect(response).toEqual({ id: 'req-1', ok: true, result: manifest })
    expect(calls).toEqual([{ method: 'app.manifest', origin: APP, args: undefined }])
  })

  it('app.grants calls broker.app.grants with the derived origin', async () => {
    const calls: BrokerCall[] = []
    const grants: Grant[] = [{ id: 'g1', origin: APP, capability: 'fs', patterns: [], grantedAt: 0 }]
    const broker = stubBroker(calls, { grants: async () => grants })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.grants', undefined))

    expect(response).toEqual({ id: 'req-1', ok: true, result: grants })
    expect(calls).toEqual([{ method: 'app.grants', origin: APP, args: undefined }])
  })

  it('net.connect passes { host, port } through and returns a plain descriptor', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { connect: async () => fakeTcpSocket() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }))

    expect(response).toEqual({
      id: 'req-1',
      ok: true,
      result: { id: 'handle-1', remoteAddress: '93.184.216.34', remotePort: 443, localAddress: '10.0.0.5', localPort: 54321 }
    })
    expect(calls).toEqual([{ method: 'net.connect', origin: APP, args: { host: 'x.example', port: 443 } }])
  })

  // MUTATION TEST: the broker's TcpSocket carries readable/writable/close/
  // closed -- the raw handle -- and none of it may reach the response.
  // ../broker/README.md's own rule, checked at the one seam where it would
  // actually leak.
  it('net.connect never forwards the socket streams, close, or closed', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { connect: async () => fakeTcpSocket() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }))

    expect(response.ok).toBe(true)
    const result = response.ok ? response.result as Record<string, unknown> : {}
    expect(Object.keys(result).sort()).toEqual(['id', 'localAddress', 'localPort', 'remoteAddress', 'remotePort'])
  })

  it('fs.readFile passes path through and returns the bytes', async () => {
    const calls: BrokerCall[] = []
    const bytes = new Uint8Array([9, 8, 7])
    const broker = stubBroker(calls, { readFile: async () => bytes })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.readFile', { path: '/a/b.txt' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: bytes })
    expect(calls).toEqual([{ method: 'fs.readFile', origin: APP, args: '/a/b.txt' }])
  })

  it('fs.writeFile passes path and data through and resolves undefined', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { writeFile: async () => {} })
    const data = new Uint8Array([1, 2, 3])

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.writeFile', { path: '/a/b.txt', data }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'fs.writeFile', origin: APP, args: { path: '/a/b.txt', data } }])
  })
})

describe('defensive payload validation (a compromised renderer can bypass contextBridge entirely)', () => {
  it.each<[string, unknown]>([
    ['net.connect', {}],
    ['net.connect', { host: 'x.example' }],
    ['net.connect', { host: 123, port: 443 }],
    ['fs.readFile', {}],
    ['fs.readFile', { path: 42 }],
    ['fs.writeFile', { path: '/a' }],
    ['fs.writeFile', { path: '/a', data: 'not bytes' }]
  ])('%s rejects a malformed payload as invalid, without calling the broker', async (method, payload) => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope(method, payload))
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toEqual([])
  })

  it('an unrecognised method is invalid, without calling the broker', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope('app.requestGrant', {}))
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toEqual([])
  })
})

describe('every reply carries an explicit timeout (spike gate 0 rule 2)', () => {
  // MUTATION TEST: removing withTimeout's race leaves this awaiting the
  // broker's promise forever, and the test times out instead of asserting.
  it('a broker call that never resolves still produces a timely timeout response', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => await never() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.manifest', undefined, 20))

    expect(response).toMatchObject({ id: 'req-1', ok: false, code: 'timeout' })
  })

  it('a call that settles well within its budget is unaffected', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.grants', undefined, 5_000))

    expect(response).toEqual({ id: 'req-1', ok: true, result: [] })
  })
})

describe('errors cross the boundary as the closed enum (DoD rule 4)', () => {
  function orivonErrorLike (code: string, message: string, platformCode?: string): OrivonError {
    const error = new Error(message) as Error & { code: string, platformCode?: string }
    error.code = code
    if (platformCode !== undefined) error.platformCode = platformCode
    return error as unknown as OrivonError
  }

  // MUTATION TEST: constructs the offending object directly rather than via
  // ./errors.ts's fail() (which already refuses to set platformCode on a
  // 'denied'), so this catches a regression in handleControlRequest's OWN
  // stripping, not just in fail()'s.
  it('strips platformCode from a denied error even if the thrown object carries one', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => { throw orivonErrorLike('denied', 'no manifest for you', 'EACCES') } })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.manifest', undefined))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'denied', message: 'no manifest for you' })
    expect(response).not.toHaveProperty('platformCode')
  })

  it('forwards platformCode for a non-denied OrivonError', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { readFile: async () => { throw orivonErrorLike('notFound', 'ENOENT', 'ENOENT') } })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.readFile', { path: '/x' }))

    expect(response).toEqual({ id: 'req-1', ok: false, code: 'notFound', message: 'ENOENT', platformCode: 'ENOENT' })
  })

  it('collapses an unrecognised thrown error to internal, without leaking its message', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => { throw new Error('/etc/shadow: permission denied at line 42') } })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.manifest', undefined))

    expect(response.ok).toBe(false)
    expect(response).toMatchObject({ code: 'internal' })
    const message = response.ok ? '' : response.message
    expect(message).not.toContain('/etc/shadow')
  })

  it('collapses a non-Error throw to internal', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { manifest: async () => { throw 'a plain string, not an Error' } }) // eslint-disable-line @typescript-eslint/only-throw-error

    const response = await handleControlRequest(broker, frameFor(APP), envelope('app.manifest', undefined))

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })
})

describe('registerBrokerIpc', () => {
  it('registers exactly one handler, on CONTROL_CHANNEL, that answers via the broker', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { grants: async () => [] })
    const registered = new Map<string, (event: ControlEvent, envelope: RequestEnvelope<unknown>) => Promise<ResponseEnvelope<unknown>>>()
    const fakeIpcMain: IpcMainLike = { handle: (channel, listener) => { registered.set(channel, listener) } }

    registerBrokerIpc(fakeIpcMain, broker)

    expect([...registered.keys()]).toEqual(['orivon:control'])
    const listener = registered.get('orivon:control')
    expect(listener).toBeDefined()
    const response = await listener?.(frameFor(APP), envelope('app.grants', undefined))
    expect(response).toEqual({ id: 'req-1', ok: true, result: [] })
  })
})

describe('nodeFs (the real filesystem adapter)', () => {
  async function tempRoot (): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'orivon-ipc-test-'))
  }

  it('rootFor is sha256(origin), never the origin string (T13b)', async () => {
    const userData = await tempRoot()
    const fs = nodeFs(userData)

    const expectedHash = createHash('sha256').update(OTHER, 'utf8').digest('hex')
    expect(fs.rootFor(OTHER)).toBe(join(userData, 'apps', expectedHash, 'files'))
    expect(fs.rootFor(OTHER)).not.toContain(OTHER)
  })

  it('writeFile then readFile round-trips, creating parent directories', async () => {
    const userData = await tempRoot()
    const fs = nodeFs(userData)
    const path = join(fs.rootFor(APP), 'nested', 'dir', 'file.bin')
    const data = new Uint8Array([1, 2, 3, 4])

    await fs.writeFile(path, data)
    const readBack = await fs.readFile(path)

    expect(readBack).toEqual(data)
    // Confirms writeFile actually touched disk, not just this adapter's view of it.
    expect(await fsReadFile(path)).toEqual(Buffer.from(data))
  })

  it('readFile of a missing file rejects with notFound, not a raw ENOENT', async () => {
    const userData = await tempRoot()
    const fs = nodeFs(userData)

    await expect(fs.readFile(join(fs.rootFor(APP), 'missing.txt'))).rejects.toMatchObject({ code: 'notFound' })
  })
})
