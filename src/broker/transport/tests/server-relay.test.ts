import { describe, expect, it, vi } from 'vitest'
import { createServerRelay } from '../server-relay.js'
import { fakeMultiTransport, fakePort, fakeTcpServer, fakeTcpSocket, tick } from './ipc.test-helpers.js'
import type { AcceptedMessage } from '../../../contracts/ipc.js'
import type { RegisteredSocket } from '../port-transport.js'

const ORIGIN = 'https://app.example'

function credit (units: number, handleId = 'handle-server-1'): { kind: 'credit', handleId: string, bytesConsumed: number } {
  return { kind: 'credit', handleId, bytesConsumed: units }
}

function accepted (port: ReturnType<typeof fakePort>['sent']): AcceptedMessage[] {
  return port.filter((m): m is AcceptedMessage => (m as { kind?: string }).kind === 'accepted')
}

describe('createServerRelay -- backpressure survives the trip (the property this whole lane exists to prove)', () => {
  it('an unread server accepts none -- no demand message, no accept', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const accept = vi.spyOn(fake, 'acceptOne')

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    await tick()

    expect(accept).not.toHaveBeenCalled()
    expect(accepted(port.sent)).toEqual([])
  })

  it('N demand messages accept exactly N connections, not one more', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })

    port.emit(credit(1))
    await tick()
    fake.acceptOne(fakeTcpSocket().socket)
    await tick()
    expect(accepted(port.sent)).toHaveLength(1)

    port.emit(credit(1))
    await tick()
    fake.acceptOne(fakeTcpSocket().socket)
    await tick()
    expect(accepted(port.sent)).toHaveLength(2)

    // No third demand message -- a third connection sitting ready in the
    // broker must not be accepted or delivered.
    fake.acceptOne(fakeTcpSocket().socket)
    await tick()
    expect(accepted(port.sent)).toHaveLength(2)
  })
})

describe('createServerRelay -- delivering an accepted connection', () => {
  it('sends an AcceptedMessage tagged with the SERVER\'s handleId, carrying the accepted socket\'s own descriptor fields', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const { socket } = fakeTcpSocket()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit(credit(1))
    await tick()
    fake.acceptOne(socket)
    await tick()

    expect(accepted(port.sent)).toEqual([{
      kind: 'accepted',
      handleId: 'handle-server-1',
      socketId: socket.id,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      port: transport.pairs[0]?.pair.port2
    }])
  })

  it('names the accepted connection\'s port2 in an explicit transfer list -- AcceptedMessage.port is the one transferable this file ever sends', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit(credit(1))
    await tick()
    fake.acceptOne(fakeTcpSocket().socket)
    await tick()

    const index = port.sent.findIndex((m) => (m as { kind?: string }).kind === 'accepted')
    expect(port.transfers[index]).toEqual([transport.pairs[0]?.pair.port2])
  })

  it('registers the accepted socket under its OWN id via the SAME createSocketRelay a dialled connection uses -- net.close reaches it', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const { socket, closeSpy } = fakeTcpSocket()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit(credit(1))
    await tick()
    fake.acceptOne(socket)
    await tick()

    const entry = transport.registry.get(ORIGIN, socket.id)
    expect(entry).toBeDefined()
    await entry?.close()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('an accepted connection carries bytes both directions over its own port, exactly as a dialled one does', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const chunk = new Uint8Array([1, 2, 3])
    const readable = new ReadableStream<Uint8Array>({ start (c) { c.enqueue(chunk); c.close() } })
    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({ write (c) { written.push(c) } })
    const { socket } = fakeTcpSocket(readable, writable)

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit(credit(1))
    await tick()
    fake.acceptOne(socket)
    await tick()

    const connectionPort = transport.pairs[0]?.port1
    expect(connectionPort?.sent).toContainEqual({ kind: 'data', handleId: socket.id, chunk })

    connectionPort?.emit({ kind: 'write', handleId: socket.id, chunk: new Uint8Array([9, 9]) })
    await tick()
    expect(written).toEqual([new Uint8Array([9, 9])])
  })
})

describe('createServerRelay -- teardown', () => {
  it('registers the server under (origin, id) at construction, and removes it on stop()', () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    const relay = createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeDefined()

    relay.stop()
    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeUndefined()
  })

  it('closing the server closes every accepted socket\'s own relay too -- reused createSocketRelay\'s own onUnlink cascade, not new plumbing', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const { socket, unlink: unlinkSocket } = fakeTcpSocket(new ReadableStream())

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit(credit(1))
    await tick()
    fake.acceptOne(socket)
    await tick()
    expect(transport.registry.get(ORIGIN, socket.id)).toBeDefined()

    // The handle-table cascade (already true at the broker layer, per this
    // lane's own brief) unlinks a derived handle the same way it would any
    // other -- this proves the TRANSPORT plumbing this lane built reacts
    // correctly, not that the cascade itself exists.
    unlinkSocket('revoked', 'revoked')

    expect(transport.registry.get(ORIGIN, socket.id)).toBeUndefined()
  })

  it('revoking the server\'s own grant (onUnlink) tears down the server AND every accepted socket', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const { socket, unlink: unlinkSocket } = fakeTcpSocket(new ReadableStream())

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit(credit(1))
    await tick()
    fake.acceptOne(socket)
    await tick()

    fake.unlink('revoked', 'revoked')
    // The server's own onUnlink does not itself reach into HandleTable's
    // child cascade (that is the broker's job, already proven at that
    // layer) -- simulate the same unlink the cascade would fire on the
    // accepted socket's own handle, and prove THIS relay's own reaction to
    // it releases the connection's registry slot too.
    unlinkSocket('revoked', 'revoked')

    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeUndefined()
    expect(transport.registry.get(ORIGIN, socket.id)).toBeUndefined()
  })

  it('is UNCONDITIONAL on unlink reason, unlike socket-relay.ts -- a TcpServer has no write queue to truncate', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    fake.unlink('closed', undefined)

    // socket-relay.ts's own 'closed'/'sessionEnded' branch is LEFT ALONE --
    // this file's own header says a server has nothing to truncate, so it
    // must tear down immediately regardless.
    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeUndefined()
    expect(port.isClosed()).toBe(true)
  })

  it('sends a terminal end message on the server\'s own port when unlinked', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    fake.unlink('revoked', 'revoked')
    await tick()

    expect(port.sent).toContainEqual({ kind: 'end', handleId: fake.server.id, code: 'revoked' })
  })

  it('the renderer-side port closing frees the server\'s registry slot AND actually releases the underlying handle -- fails against the unfixed code, which only cleared the registry', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeDefined()

    port.simulateClose()
    await tick()

    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeUndefined()
    // THE ACTUAL LEAK: `fake.closeSpy` is `FailableTcpServer.close`, the one
    // route to `handleTable.release` -> `ListenedServer.destroy` -> the real
    // OS listening socket closing (server-relay.ts's own fix comment). The
    // unfixed `cleanup()` only ever called `transport.registry.remove` and
    // `port.close()` -- this spy is what proves the handle itself, not just
    // this relay's own bookkeeping, was actually torn down.
    expect(fake.closeSpy).toHaveBeenCalledTimes(1)
    expect(fake.failSpy).not.toHaveBeenCalled()
  })

  it('an abandoned port closes the server handle exactly once even if the handle then also unlinks on its own -- idempotent, not a double teardown', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })

    port.simulateClose()
    await tick()
    // Simulates the handle table's own unlink pass reaching this handle
    // AFTER the abandoned-port teardown already closed it -- e.g. a grant
    // revocation racing the port closing. Must not throw, and must not
    // attempt a second real close.
    fake.unlink('closed', undefined)
    await tick()

    expect(fake.closeSpy).toHaveBeenCalledTimes(1)
  })

  it('a clean server.closed resolution unregisters the server and closes its port', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    fake.settleClosed()
    await tick()

    expect(transport.registry.get(ORIGIN, fake.server.id)).toBeUndefined()
    expect(port.isClosed()).toBe(true)
  })
})

describe('createServerRelay -- untrusted messages on the server\'s own port', () => {
  it('ignores every RendererToBrokerMessage kind but credit -- a renderer confusing its own handles corrupts nothing', async () => {
    const fake = fakeTcpServer()
    const port = fakePort()
    const transport = fakeMultiTransport()
    const acceptOne = vi.spyOn(fake, 'acceptOne')

    createServerRelay({ origin: ORIGIN, server: fake.server, port, transport, readWindowBytes: 1_000, writeWindowBytes: 1_000 })

    expect(() => {
      port.emit({ kind: 'write', handleId: fake.server.id, chunk: new Uint8Array([1]) })
      port.emit({ kind: 'write-end', handleId: fake.server.id })
      port.emit({ kind: 'write-abort', handleId: fake.server.id })
      port.emit({ kind: 'send', handleId: fake.server.id, data: new Uint8Array([1]), address: '1.2.3.4', port: 80 })
      port.emit({ kind: 'datagram-credit', handleId: fake.server.id, datagramsConsumed: 1, bytesConsumed: 1 })
    }).not.toThrow()
    await tick()

    expect(acceptOne).not.toHaveBeenCalled()
  })
})

// Compile-time only: RegisteredSocket's own 'server' kind exists so net.close
// answers a TcpServer's id exactly the way it answers a socket's.
const _typeCheck: RegisteredSocket = { kind: 'server', close: async () => {} }
void _typeCheck
