import { describe, expect, it, vi } from 'vitest'
import { Server, createServerFactory } from '../node-net-server.js'
import { Socket } from '../node-net-socket.js'
import { createFakeTcpServer } from './support/fake-tcp-server.js'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'
import { OrivonShimError } from '../errors.js'

describe('net.Server -- the accept-demand property this lane exists to preserve', () => {
  it('listening triggers exactly one pull -- one unit of accept demand, not a burst', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    server.listen(6881)
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))
    // Give any eager/looping implementation a chance to over-read before
    // asserting it did not: this is the assertion a naive `while (true)`
    // drain would still pass on the FIRST pull but fail here.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.pullCount()).toBe(1)
  })

  it('never issues a second read before the first delivered connection has been emitted', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    const received: Socket[] = []
    server.on('connection', (socket) => received.push(socket))
    server.listen(6881)
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))

    fake.deliver(createFakeTcpSocket().socket)
    await vi.waitFor(() => expect(received).toHaveLength(1))
    // Exactly one connection delivered re-arms exactly one more read --
    // never two, never zero.
    await vi.waitFor(() => expect(fake.pullCount()).toBe(2))
  })

  it('delivers accepted sockets as real net.Socket instances, carrying the accepted handle\'s own fields', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    const receivedOnce = new Promise<Socket>((resolve) => server.once('connection', resolve))
    server.listen(6881)
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))

    fake.deliver(createFakeTcpSocket({ remotePort: 1 }).socket)
    const socket = await receivedOnce
    expect(socket).toBeInstanceOf(Socket)
    expect(socket.remotePort).toBe(1)
  })

  it('an accepted socket never fires \'connect\' -- only client-initiated connect() does in real Node', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    const receivedOnce = new Promise<Socket>((resolve) => server.once('connection', resolve))
    server.listen(6881)
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))
    fake.deliver(createFakeTcpSocket().socket)
    const socket = await receivedOnce

    const sawConnect = vi.fn()
    socket.on('connect', sawConnect)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sawConnect).not.toHaveBeenCalled()
    expect(socket.connecting).toBe(false)
  })
})

describe('net.Server -- listening/error/address/close', () => {
  it('emits \'listening\' and fires the listen callback once bound', async () => {
    const fake = createFakeTcpServer({ localPort: 6881 })
    const server = new Server(async () => fake.server)
    const onListening = vi.fn()
    server.on('listening', onListening)
    await new Promise<void>((resolve) => { server.listen(6881, resolve) })
    expect(onListening).toHaveBeenCalledOnce()
  })

  it('address() is null before listening, then reflects the bound handle', async () => {
    const fake = createFakeTcpServer({ localAddress: '0.0.0.0', localPort: 6881 })
    const server = new Server(async () => fake.server)
    expect(server.address()).toBeNull()
    await new Promise<void>((resolve) => { server.listen(6881, resolve) })
    expect(server.address()).toEqual({ address: '0.0.0.0', port: 6881, family: 'IPv4' })
  })

  it('a denied listen rejection surfaces as an \'error\' event with err.code === \'denied\', never a thrown exception', async () => {
    const denied = Object.assign(new Error('tcp.listen is not granted'), { code: 'denied' })
    const server = new Server(async () => { throw denied })
    const error = new Promise<Error & { code?: string }>((resolve) => server.once('error', resolve))
    server.listen(6881)
    expect((await error).code).toBe('denied')
  })

  it('close() closes the underlying TcpServer handle -- the broker tears every derived accepted socket down from there (handle-contracts.md\'s TcpServer section), not from this wrapper', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    await new Promise<void>((resolve) => { server.listen(6881, resolve) })
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(fake.closed()).toBe(true)
  })

  it('close() fires the \'close\' event and stops pumping for further connections', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    await new Promise<void>((resolve) => { server.listen(6881, resolve) })
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))

    const onClose = vi.fn()
    server.on('close', onClose)
    server.close()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())

    // The read that was already outstanding when close() was called may
    // still resolve (a connection that had already been accepted) -- but no
    // FURTHER read may follow it once closing.
    const before = fake.pullCount()
    fake.deliver(createFakeTcpSocket().socket)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.pullCount()).toBe(before)
  })

  it('close() with no successful listen still calls back, without throwing', async () => {
    const server = new Server(async () => { throw new Error('never resolves before close') })
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error !== undefined ? reject(error) : resolve()))
    })
  })
})

describe('net.Server#listen -- host handling', () => {
  it('accepts an explicit \'0.0.0.0\' host -- the broker\'s own actual bind target', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    await new Promise<void>((resolve) => { server.listen(6881, '0.0.0.0', resolve) })
    expect(fake.pullCount()).toBe(1)
  })

  it('refuses a host it cannot honour (e.g. loopback-only) rather than silently binding wider than asked', async () => {
    const fake = createFakeTcpServer()
    const server = new Server(async () => fake.server)
    expect(() => server.listen(6881, '127.0.0.1')).toThrow(OrivonShimError)
    try {
      server.listen(6881, '127.0.0.1')
    } catch (error) {
      expect((error as OrivonShimError).reason).toBe('unimplemented')
    }
  })
})

describe('createServerFactory', () => {
  it('createServer(connectionListener) attaches it as a real \'connection\' listener', async () => {
    const fake = createFakeTcpServer()
    const createServer = createServerFactory(async () => fake.server)
    const onConnection = vi.fn()
    const server = createServer(onConnection)
    server.listen(6881)
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))
    fake.deliver(createFakeTcpSocket().socket)
    await vi.waitFor(() => expect(onConnection).toHaveBeenCalledOnce())
  })

  it('createServer(options, connectionListener) threads options through to accepted sockets', async () => {
    const fake = createFakeTcpServer()
    const createServer = createServerFactory(async () => fake.server)
    let seen: Socket | undefined
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => { seen = socket })
    server.listen(6881)
    await vi.waitFor(() => expect(fake.pullCount()).toBe(1))
    fake.deliver(createFakeTcpSocket().socket)
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(seen?.allowHalfOpen).toBe(true)
  })
})
