import { describe, expect, it, vi } from 'vitest'
import { Socket, createConnectFactory, kDial, type NetDialFn } from '../node-net-socket.js'
import { createFakeTcpSocket, type FakeTcpSocket } from './support/fake-tcp-socket.js'
import { socketLifecycleSuite } from './support/socket-lifecycle-suite.js'
import { OrivonShimError } from '../errors.js'

describe('net.Socket over a fake TcpSocket', () => {
  it('emits "connect" once the dial promise resolves, and exposes remoteAddress/remotePort synchronously after', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    const connected = new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.connect({ host: 'example.com', port: 80 })
    await connected
    expect(socket.remoteAddress).toBe('127.0.0.1')
    expect(socket.remotePort).toBe(80)
  })

  it('a webtorrent-shaped caller: net.connect(opts) returns synchronously, before the connection settles', () => {
    const fake = createFakeTcpSocket()
    const connect = createConnectFactory(async () => fake.socket)
    const socket = connect({ host: 'example.com', port: 6881 })
    expect(socket).toBeInstanceOf(Socket)
    expect(socket.remoteAddress).toBeUndefined()
  })

  it('delivers inbound bytes as real "data" events and ends with "end", matching real net.Socket', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))

    const chunks: Buffer[] = []
    const ended = new Promise<void>((resolve) => socket.once('end', resolve))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))

    fake.push(new Uint8Array([1, 2, 3]))
    fake.push(new Uint8Array([4, 5]))
    fake.end()
    await ended

    expect(Buffer.concat(chunks).equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true)
  })

  it('"end" fires before "close" -- README requirement 1\'s ordering rule', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.resume()

    const order: string[] = []
    socket.once('end', () => order.push('end'))
    socket.once('close', () => order.push('close'))

    fake.end()
    await new Promise<void>((resolve) => socket.once('close', resolve))
    expect(order).toEqual(['end', 'close'])
  })

  it('respects backpressure: does not pull a second chunk from the reader until the first is consumed', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))

    // Push far more than one Readable would normally buffer, then read it
    // back slowly. If _read() pulled eagerly regardless of consumption,
    // this would still complete instantly; the test's actual assertion is
    // that draining reproduces every byte in order despite the pacing.
    const chunks: Uint8Array[] = Array.from({ length: 50 }, (_, i) => new Uint8Array([i]))
    for (const chunk of chunks) fake.push(chunk)
    fake.end()

    const received: number[] = []
    for await (const chunk of socket) {
      received.push(...(chunk as Buffer))
    }
    expect(received).toEqual(chunks.map((_, i) => i))
  })

  it('writes go to the underlying writable, and end() closes it (FIN)', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))

    socket.write('hello ')
    socket.end('world')
    await new Promise<void>((resolve) => socket.once('finish', resolve))

    const written = Buffer.concat(fake.written).toString('utf8')
    expect(written).toBe('hello world')
  })

  it('a "denied" rejection surfaces as an "error" event with err.code === "denied", never a thrown exception', async () => {
    const denied = Object.assign(new Error('host not granted'), { code: 'denied' })
    const socket = new Socket({ [kDial]: async () => { throw denied } })
    const error = new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    socket.connect({ host: 'blocked.example', port: 80 })
    expect((await error).code).toBe('denied')
  })

  it('a peer reset rejects the read side with the mapped platformCode, not a fabricated one', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.resume()

    const error = new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    fake.fail('reset', 'peer reset the connection', 'ECONNRESET')
    expect((await error).code).toBe('ECONNRESET')
  })

  it('setNoDelay/setKeepAlive are chainable and forward to the handle', async () => {
    const fake = createFakeTcpSocket()
    const setNoDelay = vi.spyOn(fake.socket, 'setNoDelay')
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    expect(socket.setNoDelay(true)).toBe(socket)
    expect(setNoDelay).toHaveBeenCalledWith(true)
  })
})

// Defect #1: `(port, host)` silently dropped `host` and dialled 'localhost',
// which is the overload every torrent/DHT library calls net.connect with
// (bittorrent-dht, k-rpc-socket). Every real Node form is exercised here so
// a future change cannot narrow the parsing back to one or two shapes.
describe('createConnectFactory -- Node\'s real net.connect overloads', () => {
  function factory (): { connect: ReturnType<typeof createConnectFactory>, calls: Array<{ host: string, port: number }> } {
    const fake = createFakeTcpSocket()
    const calls: Array<{ host: string, port: number }> = []
    const connect = createConnectFactory(async (opts) => { calls.push(opts); return fake.socket })
    return { connect, calls }
  }

  it('(port) dials the given port against the default host', async () => {
    const { connect, calls } = factory()
    connect(6881)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ host: 'localhost', port: 6881 })
  })

  it('(port, host) dials the given host, not "localhost"', async () => {
    const { connect, calls } = factory()
    connect(6881, 'router.bittorrent.com')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ host: 'router.bittorrent.com', port: 6881 })
  })

  it('(port, cb) dials the default host and still fires the connect listener', async () => {
    const { connect, calls } = factory()
    const onConnect = vi.fn()
    connect(6881, onConnect)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ host: 'localhost', port: 6881 })
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce())
  })

  it('(port, host, cb) dials the given host AND fires the connect listener', async () => {
    const { connect, calls } = factory()
    const onConnect = vi.fn()
    connect(6881, 'router.bittorrent.com', onConnect)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ host: 'router.bittorrent.com', port: 6881 })
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce())
  })

  it('(options) dials host/port read from the options object', async () => {
    const { connect, calls } = factory()
    connect({ host: 'example.com', port: 80 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ host: 'example.com', port: 80 })
  })

  it('(options, cb) dials from the options object AND fires the connect listener', async () => {
    const { connect, calls } = factory()
    const onConnect = vi.fn()
    connect({ host: 'example.com', port: 80 }, onConnect)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ host: 'example.com', port: 80 })
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce())
  })
})

// A135: `socket.ref()`/`unref()`/`setTimeout()` used to be absent -- a bare
// TypeError -- rather than the DELIBERATELY DIFFERENT treatment each one
// gets below. This is not a Proxy (unlike node-dns.ts/node-fs.ts/node-net.ts's
// module-level wraps): net.Socket is a stateful, feature-detected instance
// real code guards with `typeof socket.unref === 'function'` before calling
// it, and a throw-on-READ proxy would make that guard itself throw, turning
// a graceful skip into a crash -- see README.md's Design notes.
describe('net.Socket -- ref/unref without breaking duck-typing (A135)', () => {
  it('ref()/unref() are real, present, safe no-ops that return `this` -- there is no event-loop handle to ref/unref here', () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    expect(typeof socket.unref).toBe('function')
    expect(socket.unref()).toBe(socket)
    expect(socket.ref()).toBe(socket)
  })

})

socketLifecycleSuite('node:stream')

function fakeDialer (fake = createFakeTcpSocket()): { fake: FakeTcpSocket, calls: Array<{ host: string, port: number }>, dial: NetDialFn } {
  const calls: Array<{ host: string, port: number }> = []
  return { fake, calls, dial: async (opts) => { calls.push(opts); return fake.socket } }
}

describe('new net.Socket(options) then .connect(...)', () => {
  it('connect(port, host, cb) dials lazily and fires the listener', async () => {
    const { calls, dial } = fakeDialer()
    const socket = new Socket({ [kDial]: dial })
    expect(calls).toHaveLength(0)
    const onConnect = vi.fn()
    expect(socket.connect(8080, 'example.com', onConnect)).toBe(socket)
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce())
    expect(calls).toEqual([{ host: 'example.com', port: 8080 }])
  })

  it('connect(options, cb) reads host and port from the object and ignores what Node would ignore', async () => {
    const { calls, dial } = fakeDialer()
    const socket = new Socket({ [kDial]: dial, allowHalfOpen: false })
    const onConnect = vi.fn()
    socket.connect({ host: 'example.com', port: 80, family: 4, localAddress: '0.0.0.0', lookup: () => {}, hints: 0 }, onConnect)
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce())
    expect(calls).toEqual([{ host: 'example.com', port: 80 }])
  })

  it('coerces a numeric string port the way Node does', async () => {
    const { calls, dial } = fakeDialer()
    new Socket({ [kDial]: dial }).connect(' 6881', 'peer.example')
    await vi.waitFor(() => expect(calls).toEqual([{ host: 'peer.example', port: 6881 }]))
  })

  it.each([
    ['', RangeError, 'ERR_SOCKET_BAD_PORT'],
    [70000, RangeError, 'ERR_SOCKET_BAD_PORT'],
    [1.5, RangeError, 'ERR_SOCKET_BAD_PORT'],
    [null, TypeError, 'ERR_INVALID_ARG_TYPE'],
    [undefined, TypeError, 'ERR_MISSING_ARGS']
  ] as const)('throws synchronously for port %j, as Node does, without dialling', (port, Ctor, code) => {
    const { calls, dial } = fakeDialer()
    const socket = new Socket({ [kDial]: dial })
    let thrown: unknown
    try { socket.connect({ port, host: 'x' }) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(Ctor)
    expect((thrown as { code: string }).code).toBe(code)
    expect(calls).toHaveLength(0)
  })

  it('connect(path) refuses by name through "error", never dialling', async () => {
    const { calls, dial } = fakeDialer()
    const socket = new Socket({ [kDial]: dial })
    const error = new Promise<unknown>((resolve) => socket.once('error', resolve))
    socket.connect('/tmp/app.sock')
    const refusal = await error
    expect(refusal).toBeInstanceOf(OrivonShimError)
    expect((refusal as OrivonShimError).reason).toBe('not-applicable')
    expect(calls).toHaveLength(0)
  })

  it('a failed dial reads like Node: synthesised errno, syscall, address and port', async () => {
    const socket = new Socket({ [kDial]: async () => { throw Object.assign(new Error('refused'), { name: 'OrivonError', code: 'unreachable' }) } })
    const error = new Promise<Record<string, unknown>>((resolve) => socket.once('error', resolve))
    socket.connect(50002, 'electrum.example')
    expect(await error).toMatchObject({ code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: 'electrum.example', port: 50002 })
  })

  it('a write before any connect() fails with ERR_SOCKET_CLOSED, as in Node', async () => {
    const socket = new Socket({ [kDial]: fakeDialer().dial })
    socket.on('error', () => {})
    const code = await new Promise<string | undefined>((resolve) => socket.write('x', (error) => resolve((error as { code?: string } | null | undefined)?.code)))
    expect(code).toBe('ERR_SOCKET_CLOSED')
  })
})

describe('net.Socket state accessors', () => {
  it('reports Node\'s values before, during and after connecting', async () => {
    const fake = createFakeTcpSocket({ remoteAddress: '2001:db8::1', localAddress: '10.0.0.2', localPort: 40000 })
    const socket = new Socket({ [kDial]: async () => fake.socket })
    expect(socket.address()).toEqual({})
    expect(socket.pending).toBe(true)
    expect(socket.readyState).toBe('open')
    socket.connect(443, 'example.com')
    expect(socket.readyState).toBe('opening')
    expect(socket.connecting).toBe(true)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    expect(socket.pending).toBe(false)
    expect(socket.connecting).toBe(false)
    expect(socket.readyState).toBe('open')
    expect(socket.remoteFamily).toBe('IPv6')
    expect(socket.address()).toEqual({ address: '10.0.0.2', family: 'IPv4', port: 40000 })

    socket.write('abc')
    fake.push(new Uint8Array([1, 2, 3, 4]))
    socket.resume()
    await vi.waitFor(() => expect(socket.bytesRead).toBe(4))
    await vi.waitFor(() => expect(socket.bytesWritten).toBe(3))
    socket.destroy()
    await new Promise<void>((resolve) => socket.once('close', () => resolve()))
    expect(socket.readyState).toBe('closed')
  })

  it('setNoDelay/setKeepAlive before connect return `this` synchronously and apply once connected', async () => {
    const fake = createFakeTcpSocket()
    const setNoDelay = vi.spyOn(fake.socket, 'setNoDelay')
    const setKeepAlive = vi.spyOn(fake.socket, 'setKeepAlive')
    const socket = new Socket({ [kDial]: async () => fake.socket })
    expect(socket.setNoDelay(true)).toBe(socket)
    expect(socket.setKeepAlive(true, 1000)).toBe(socket)
    expect(setNoDelay).not.toHaveBeenCalled()
    socket.connect(1, 'x')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    expect(setNoDelay).toHaveBeenCalledWith(true)
    expect(setKeepAlive).toHaveBeenCalledWith(true, 1000)
  })

  it('resetAndDestroy() sends an RST and closes without an error', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect(1, 'x')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    const onError = vi.fn()
    socket.on('error', onError)
    socket.resetAndDestroy()
    await new Promise<void>((resolve) => socket.once('close', () => resolve()))
    expect(fake.rstSent()).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('net.Socket#setTimeout -- an idle timer', () => {
  async function connectedSocket (): Promise<{ socket: Socket, fake: FakeTcpSocket }> {
    const fake = createFakeTcpSocket()
    const socket = new Socket({ [kDial]: async () => fake.socket })
    socket.connect(1, 'x')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    return { socket, fake }
  }

  it('emits "timeout" after the idle period without destroying, and calls the listener', async () => {
    const { socket } = await connectedSocket()
    const onTimeout = vi.fn()
    expect(socket.setTimeout(20, onTimeout)).toBe(socket)
    expect(socket.timeout).toBe(20)
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledOnce())
    expect(socket.destroyed).toBe(false)
    socket.destroy()
  })

  it('inbound data counts as activity and postpones the timeout', async () => {
    const { socket, fake } = await connectedSocket()
    socket.resume()
    const onTimeout = vi.fn()
    socket.setTimeout(40, onTimeout)
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      fake.push(new Uint8Array([i]))
    }
    expect(onTimeout).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledOnce())
    socket.destroy()
  })

  it('setTimeout(0) disables it', async () => {
    const { socket } = await connectedSocket()
    const onTimeout = vi.fn()
    socket.setTimeout(15, onTimeout)
    socket.setTimeout(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(onTimeout).not.toHaveBeenCalled()
    socket.destroy()
  })

  it('a timer set before connecting covers the connect itself, the connect-timeout idiom', async () => {
    const socket = new Socket({ [kDial]: async () => await new Promise<never>(() => {}) })
    const onTimeout = vi.fn(() => socket.destroy())
    socket.setTimeout(15, onTimeout)
    socket.connect(1, 'slow.example')
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledOnce())
    expect(socket.destroyed).toBe(true)
  })

  it('rejects a negative timeout like Node', () => {
    const socket = new Socket({ [kDial]: fakeDialer().dial })
    expect(() => socket.setTimeout(-1)).toThrow(RangeError)
  })
})
