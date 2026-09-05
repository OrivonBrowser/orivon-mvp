import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest, registerBrokerIpc } from './ipc.js'
import type { ControlEvent, IpcMainLike } from './ipc.js'
import type { Grant, Manifest, OrivonError } from '../contracts/index.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'
import {
  APP, type BrokerCall, envelope, fakePort, fakePortPair, fakeTcpSocket, fakeTransport,
  frameFor, NO_FRAME, never, OTHER, stubBroker, tick
} from './ipc.test-helpers.js'

// This suite is what proves handleControlRequest is the thing DoD rule 1
// describes -- origin from the SENDER FRAME, never from the payload -- and
// that a failure always crosses the boundary as the closed enum (rule 4),
// not as whatever the broker or Node happened to throw. Every test below was
// checked against a broken implementation while writing it (see the PR
// body): the origin check skipped in favour of trusting payload.origin, the
// timeout wrapper removed, and a denial forwarding its platformCode. Each
// was watched to fail before being fixed back.

describe('origin derivation (DoD rule 1 -- never the payload)', () => {
  it('denies with no authenticated origin when senderFrame is null', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), NO_FRAME, envelope('app.manifest', undefined))
    expect(response).toEqual({ id: 'req-1', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('denies when the frame is opaque (url and claimed origin disagree)', async () => {
    const calls: BrokerCall[] = []
    const event: ControlEvent = { senderFrame: { url: `${APP}/sandboxed`, origin: 'null', postMessage: vi.fn() } }
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

describe('the four wired control operations', () => {
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

describe("net.connect / net.close (the byte pump's control-channel wiring)", () => {
  it('returns a plain descriptor -- never the socket, its streams, or its close function', async () => {
    const calls: BrokerCall[] = []
    const { socket } = fakeTcpSocket()
    const broker = stubBroker(calls, { connect: async () => socket })
    const { pair } = fakePortPair()

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair)
    )

    expect(response).toEqual({
      id: 'req-1',
      ok: true,
      result: { id: 'handle-1', remoteAddress: '93.184.216.34', remotePort: 443, localAddress: '10.0.0.5', localPort: 54321 }
    })
    expect(calls).toEqual([{ method: 'net.connect', origin: APP, args: { host: 'x.example', port: 443 } }])
  })

  it('delivers a port to the CALLING FRAME, tagged with the handle id, over the delivery channel', async () => {
    const calls: BrokerCall[] = []
    const { socket } = fakeTcpSocket()
    const broker = stubBroker(calls, { connect: async () => socket })
    const { pair } = fakePortPair()
    const frame = frameFor(APP)

    await handleControlRequest(broker, frame, envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair))

    expect(frame.senderFrame?.postMessage).toHaveBeenCalledWith(
      expect.any(String), { handleId: 'handle-1' }, [pair.port2]
    )
  })

  it("relays the socket's bytes to the delivered port as DataMessages, then a clean end", async () => {
    const calls: BrokerCall[] = []
    const chunk = new Uint8Array([1, 2, 3])
    const readable = new ReadableStream<Uint8Array>({
      start (controller) { controller.enqueue(chunk); controller.close() }
    })
    const { socket } = fakeTcpSocket(readable)
    const broker = stubBroker(calls, { connect: async () => socket })
    const { pair, port1 } = fakePortPair()

    await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair))
    await tick(10)

    expect(port1.sent).toEqual([
      { kind: 'data', handleId: 'handle-1', chunk },
      { kind: 'end', handleId: 'handle-1' }
    ])
  })

  it("a credit message arriving on the port does not throw, and is threaded to the pump", async () => {
    const calls: BrokerCall[] = []
    const { socket } = fakeTcpSocket()
    const broker = stubBroker(calls, { connect: async () => socket })
    const { pair, port1 } = fakePortPair()

    await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair))
    await tick()

    expect(() => { port1.emit({ kind: 'credit', handleId: 'handle-1', bytesConsumed: 100 }) }).not.toThrow()
  })

  it("closing the socket (a revoke, or the app's own close) sends a terminal end message tagged with the reason", async () => {
    const calls: BrokerCall[] = []
    const { socket, settleClosed } = fakeTcpSocket(new ReadableStream())
    const broker = stubBroker(calls, { connect: async () => socket })
    const { pair, port1 } = fakePortPair()
    const revoked = Object.assign(new Error('the grant authorising this connection was withdrawn'), {
      name: 'OrivonError',
      code: 'revoked'
    }) as OrivonError

    await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair))
    settleClosed(revoked)
    await tick()

    expect(port1.sent).toEqual([{ kind: 'end', handleId: 'handle-1', code: 'revoked' }])
  })

  it('a clean app-initiated close (socket.closed resolves) sends a terminal end message with no code', async () => {
    const calls: BrokerCall[] = []
    const { socket, settleClosed } = fakeTcpSocket(new ReadableStream())
    const broker = stubBroker(calls, { connect: async () => socket })
    const { pair, port1 } = fakePortPair()

    await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair))
    settleClosed()
    await tick()

    expect(port1.sent).toEqual([{ kind: 'end', handleId: 'handle-1' }])
  })

  it('net.close closes the registered socket for the origin that opened it', async () => {
    const calls: BrokerCall[] = []
    const { socket, closeSpy } = fakeTcpSocket()
    const broker = stubBroker(calls, { connect: async () => socket })
    const transport = fakeTransport(fakePortPair().pair)

    const connectResponse = await handleControlRequest(
      broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), transport
    )
    const id = connectResponse.ok ? (connectResponse.result as { id: string }).id : ''

    await handleControlRequest(broker, frameFor(APP), envelope('net.close', { id }), transport)

    expect(closeSpy).toHaveBeenCalledOnce()
  })

  it('net.close for an id belonging to a DIFFERENT origin is a silent no-op (T11c: no cross-origin reach)', async () => {
    const calls: BrokerCall[] = []
    const { socket, closeSpy } = fakeTcpSocket()
    const broker = stubBroker(calls, { connect: async () => socket })
    const transport = fakeTransport(fakePortPair().pair)

    const connectResponse = await handleControlRequest(
      broker, frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), transport
    )
    const id = connectResponse.ok ? (connectResponse.result as { id: string }).id : ''

    const response = await handleControlRequest(broker, frameFor(OTHER), envelope('net.close', { id }), transport)

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('net.close for an id nothing ever registered is a silent no-op', async () => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(
      stubBroker(calls), frameFor(APP), envelope('net.close', { id: 'never-registered' }), fakeTransport(fakePortPair().pair)
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
  })
})

describe('a socket whose port never reaches its frame is released, not leaked', () => {
  // handle-contracts.ts's destroy rule: released exactly once, ALWAYS,
  // "including when the acquisition that would have registered the handle is
  // itself refused... otherwise one fd leaks per attempt against a limit an
  // attacker can hit in a loop". A frame that navigated or was disposed
  // between the request and the port delivery is ordinary, not adversarial --
  // and because the descriptor is never returned, the app never learns the id
  // it would need to call net.close with.
  function disposedFrame (origin: string): ControlEvent {
    return {
      senderFrame: {
        url: `${origin}/index.html`,
        origin,
        postMessage: () => { throw new Error('Render frame was disposed before WebFrameMain could be accessed') }
      }
    }
  }

  it('closes the socket and unregisters it when postMessage throws', async () => {
    const calls: BrokerCall[] = []
    const { socket, closeSpy } = fakeTcpSocket()
    const transport = fakeTransport(fakePortPair().pair)

    const response = await handleControlRequest(
      stubBroker(calls, { connect: async () => socket }),
      disposedFrame(APP),
      envelope('net.connect', { host: 'x.example', port: 443 }),
      transport
    )
    await tick(10)

    expect(response.ok).toBe(false)
    expect((response as { code: string }).code).toBe('internal')
    expect(closeSpy).toHaveBeenCalledOnce()
    expect(transport.registry.get(APP, 'handle-1')).toBeUndefined()
  })

  it('closes the port it minted, so the pump cannot go on writing into a port nobody holds', async () => {
    const calls: BrokerCall[] = []
    const { socket } = fakeTcpSocket()
    const { pair, port1 } = fakePortPair()
    const closePort = vi.spyOn(port1, 'close')

    await handleControlRequest(
      stubBroker(calls, { connect: async () => socket }),
      disposedFrame(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair)
    )
    await tick(10)

    expect(closePort).toHaveBeenCalled()
  })

  it('closes the port exactly once even though abandon and the closed handler both release', async () => {
    const calls: BrokerCall[] = []
    const { socket } = fakeTcpSocket()
    const { pair, port1 } = fakePortPair()
    const closePort = vi.spyOn(port1, 'close')

    await handleControlRequest(
      stubBroker(calls, { connect: async () => socket }),
      disposedFrame(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair)
    )
    await tick(10)

    // A real MessagePortMain would otherwise be closed twice: once by
    // abandon(), once by the socket.closed handler abandon's own close()
    // triggers.
    expect(closePort).toHaveBeenCalledTimes(1)
  })

  it('a throwing teardown is logged, never left as an unhandled rejection (it would kill the main process)', async () => {
    const calls: BrokerCall[] = []
    const { socket, settleClosed } = fakeTcpSocket()
    const { pair, port1 } = fakePortPair()
    port1.close = () => { throw new Error('port already gone') }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    await handleControlRequest(
      stubBroker(calls, { connect: async () => socket }),
      frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), fakeTransport(pair)
    )
    settleClosed()
    await tick(20)
    process.off('unhandledRejection', unhandled)
    // Read the call count BEFORE restoring -- mockRestore() clears the
    // recorded calls along with the stub.
    const logCalls = logged.mock.calls.length
    logged.mockRestore()

    expect(unhandled).not.toHaveBeenCalled()
    expect(logCalls).toBeGreaterThan(0)
  })

  it('releases the socket if the frame changed origin between the request and the delivery (T17)', async () => {
    const calls: BrokerCall[] = []
    const { socket, closeSpy } = fakeTcpSocket()
    const transport = fakeTransport(fakePortPair().pair)
    // A frame whose origin moves while broker.net.connect is in flight --
    // the port would otherwise be delivered to a page that never asked for
    // it and holds no grant, as a bearer capability it cannot be asked for.
    const frame = { url: `${APP}/index.html`, origin: APP, postMessage: vi.fn() }
    const event: ControlEvent = { senderFrame: frame }

    const response = await handleControlRequest(
      stubBroker(calls, {
        connect: async () => {
          frame.url = `${OTHER}/index.html`
          frame.origin = OTHER
          return socket
        }
      }),
      event, envelope('net.connect', { host: 'x.example', port: 443 }), transport
    )
    await tick(10)

    expect(response.ok).toBe(false)
    expect(frame.postMessage).not.toHaveBeenCalled()
    expect(closeSpy).toHaveBeenCalledOnce()
    expect(transport.registry.get(APP, 'handle-1')).toBeUndefined()
  })
})

describe('the request envelope itself is untrusted (a compromised renderer reaches this channel directly)', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'pwned'],
    ['a number', 7],
    ['no method', { id: 'req-1', payload: undefined, timeoutMs: 1_000 }],
    ['a non-string method', { id: 'req-1', method: 42, payload: undefined, timeoutMs: 1_000 }],
    ['a non-string id', { id: 42, method: 'app.grants', payload: undefined, timeoutMs: 1_000 }],
    ['no timeoutMs', { id: 'req-1', method: 'app.grants', payload: undefined }],
    ['a NaN timeoutMs', { id: 'req-1', method: 'app.grants', payload: undefined, timeoutMs: Number.NaN }],
    ['a zero timeoutMs', { id: 'req-1', method: 'app.grants', payload: undefined, timeoutMs: 0 }],
    ['a negative timeoutMs', { id: 'req-1', method: 'app.grants', payload: undefined, timeoutMs: -1 }],
    // Above setTimeout's ceiling Node clamps the delay to 1ms and warns, so
    // this would otherwise be answered 'timeout' almost instantly.
    ['a timeoutMs past setTimeout\'s ceiling', { id: 'req-1', method: 'app.grants', payload: undefined, timeoutMs: 2 ** 40 }]
  ])('returns a ResponseEnvelope rather than throwing, for %s', async (_label, malformed) => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(
      stubBroker(calls), frameFor(APP), malformed as RequestEnvelope<unknown>
    )

    expect(response.ok).toBe(false)
    expect((response as { code: string }).code).toBe('invalid')
    expect(calls).toEqual([]) // never reached the broker
  })

  it('correlates the rejection with the id when the envelope carried a usable one', async () => {
    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP),
      { id: 'req-9', method: 'app.grants', payload: undefined, timeoutMs: Number.NaN } as RequestEnvelope<unknown>
    )

    expect(response.id).toBe('req-9')
  })
})

describe('defensive payload validation (a compromised renderer can bypass contextBridge entirely)', () => {
  it.each<[string, unknown]>([
    ['fs.readFile', {}],
    ['fs.readFile', { path: 42 }],
    ['fs.writeFile', { path: '/a' }],
    ['fs.writeFile', { path: '/a', data: 'not bytes' }],
    ['net.connect', {}],
    ['net.connect', { host: 'x.example' }],
    ['net.connect', { host: 123, port: 443 }],
    ['net.close', {}],
    ['net.close', { id: 42 }]
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

    registerBrokerIpc(fakeIpcMain, broker, fakeTransport(fakePortPair().pair))

    expect([...registered.keys()]).toEqual(['orivon:control'])
    const listener = registered.get('orivon:control')
    expect(listener).toBeDefined()
    const response = await listener?.(frameFor(APP), envelope('app.grants', undefined))
    expect(response).toEqual({ id: 'req-1', ok: true, result: [] })
  })
})

// nodeFs/resolveHost/dialTcp moved to ./node-adapters.ts and their tests
// with them (docs/development/code-guidelines.md Rule 2 -- this file's own
// net.connect/net.close wiring pushed it over budget). See
// node-adapters.test.ts.

describe('a socket that dies underneath the broker fails its handle for real', () => {
  // handle-contracts.md: without an entry point for "this resource died
  // underneath us", a peer RST "is reported as a clean successful close,
  // which is the COMMON way a socket ends" -- and conformance item 12 wants
  // a peer reset to REJECT closed with the real platformCode, not resolve
  // it. FailableTcpSocket.fail (index.ts) is that entry point; this proves
  // ipc.ts's net.connect wiring actually reaches it.
  it("calls the socket's fail(), not close(), when its readable errors", async () => {
    const calls: BrokerCall[] = []
    const rawError = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const readable = new ReadableStream<Uint8Array>({ pull (c) { c.error(rawError) } })
    const { socket, closeSpy, failSpy } = fakeTcpSocket(readable)
    const transport = fakeTransport(fakePortPair().pair)

    await handleControlRequest(
      stubBroker(calls, { connect: async () => socket }),
      frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), transport
    )
    await tick(20)

    expect(failSpy).toHaveBeenCalledWith('reset', 'ECONNRESET')
    expect(closeSpy).not.toHaveBeenCalled()
    expect(transport.registry.get(APP, 'handle-1')).toBeUndefined()
  })

  it('does not call fail() on a clean EOF -- readable ending is half-close, not death', async () => {
    const calls: BrokerCall[] = []
    const { socket, failSpy } = fakeTcpSocket() // default readable closes immediately
    const transport = fakeTransport(fakePortPair().pair)

    await handleControlRequest(
      stubBroker(calls, { connect: async () => socket }),
      frameFor(APP), envelope('net.connect', { host: 'x.example', port: 443 }), transport
    )
    await tick(20)

    expect(failSpy).not.toHaveBeenCalled()
    expect(transport.registry.get(APP, 'handle-1')).toBeDefined()
  })
})
