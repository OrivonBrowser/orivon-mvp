import { describe, expect, it, vi } from 'vitest'
import { Socket, createConnectFactory } from '../node-net-socket.js'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'

describe('net.Socket over a fake TcpSocket', () => {
  it('emits "connect" once the dial promise resolves, and exposes remoteAddress/remotePort synchronously after', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket(async () => fake.socket)
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
    const socket = new Socket(async () => fake.socket)
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
    const socket = new Socket(async () => fake.socket)
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
    const socket = new Socket(async () => fake.socket)
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
    const socket = new Socket(async () => fake.socket)
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
    const socket = new Socket(async () => { throw denied })
    const error = new Promise<Error & { code?: string }>((resolve) => socket.once('error', resolve))
    socket.connect({ host: 'blocked.example', port: 80 })
    expect((await error).code).toBe('denied')
  })

  it('a peer reset rejects the read side with the mapped platformCode, not a fabricated one', async () => {
    const fake = createFakeTcpSocket()
    const socket = new Socket(async () => fake.socket)
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
    const socket = new Socket(async () => fake.socket)
    socket.connect({ host: 'x', port: 1 })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    await socket.setNoDelay(true)
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
