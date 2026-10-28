// Repro for the data-loss bug: a component that writes a response in two
// pieces (headers, body) and then lets its connected socket resource drop
// (no explicit shutdown) can lose the later piece. `net.connect`'s resolved
// TcpSocket here is put through the REAL Worker<->page transfer
// (orivon-client.ts/orivon-server.ts, a real MessageChannel), exactly as it
// is in production for a component running in the app's hidden child host
// (src/shim/worker/host.ts) -- everything past that boundary is real
// (wasi-p2/tcp.ts, wasi-p2/io.ts). Only the broker itself is faked, since it
// needs a real Electron process; the fake's write() delays before landing,
// matching src/broker/transport/relay/port-sink.ts's own async ack round
// trip, and its close() takes effect immediately, matching
// src/broker/adapters/node-adapters.ts's destroySocket + a real
// node:net.Socket refusing a write once end() has already run.

import { describe, expect, it } from 'vitest'
import type { TcpSocket as OrivonTcpSocket } from '../../../contracts/handles.js'
import { createOrivonClient } from '../../worker/orivon-client.js'
import { serveOrivon } from '../../worker/orivon-server.js'
import type { IpSocketAddress, SocketNet } from '../addresses.js'
import type { OutputStream } from '../io.js'
import { socketInterfaces } from '../sockets.js'
import type { TcpSocket } from '../tcp.js'

const v4 = (a: number, b: number, c: number, d: number, port: number): IpSocketAddress => ({ tag: 'ipv4', val: { port, address: [a, b, c, d] } })

/** A broker-shaped TcpSocket: write() lands after a delay (port-sink.ts's own ack round trip); close() ends the real sink immediately, dropping anything not yet landed -- exactly node:net's own "write after end" behaviour. */
function fakeBrokerSocket (writeDelayMs: number, events: string[] = []): { socket: OrivonTcpSocket, received: () => string } {
  let ended = false
  let received = ''
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      await new Promise((resolve) => setTimeout(resolve, writeDelayMs))
      if (ended) return // matches a real net.Socket silently refusing a write past end()
      received += new TextDecoder().decode(chunk)
    }
  })
  const readable = new ReadableStream<Uint8Array>({ start () {}, cancel () { events.push(`read side cancelled after ${received.length} bytes landed`) } })
  const socket: OrivonTcpSocket = {
    id: 'fake-broker-socket',
    closed: new Promise(() => {}),
    close: async () => { ended = true },
    readable,
    writable,
    remoteAddress: '127.0.0.1',
    remotePort: 443,
    localAddress: '127.0.0.1',
    localPort: 55555,
    setNoDelay: async () => {},
    setKeepAlive: async () => {}
  }
  return { socket, received: () => received }
}

function connectClient (brokerSocket: OrivonTcpSocket): SocketNet {
  const channel = new MessageChannel()
  serveOrivon(channel.port1, { net: { connect: async () => brokerSocket } })
  const client = createOrivonClient(channel.port2) as { net: SocketNet }
  return client.net as unknown as SocketNet
}

describe('a component writing a two-piece response then dropping its socket (no explicit shutdown)', () => {
  it('does not lose the later piece to a close that outraces the still-relaying write', async () => {
    const { socket: brokerSocket, received } = fakeBrokerSocket(30)
    const wiredNet: SocketNet = connectClient(brokerSocket)
    const interfaces = socketInterfaces(wiredNet)
    const createTcpSocket = (interfaces['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (family: string) => TcpSocket }).createTcpSocket
    const socket = createTcpSocket('ipv4')

    socket.startConnect({}, v4(93, 184, 216, 34, 443))
    await socket.subscribe().block()
    const [, output]: [unknown, OutputStream] = socket.finishConnect()

    await output.blockingWriteAndFlush(new TextEncoder().encode('HEADERS\r\n\r\n'))
    await output.blockingWriteAndFlush(new TextEncoder().encode('BODYBODYBODY'))

    // The resource drop: no explicit shutdown() call, matching a Rust
    // program that simply lets the connected socket go out of scope.
    socket[Symbol.dispose]()

    // Wait for the fake broker's delayed write to land, not for a fixed time: a dropped
    // piece never lands, so the bug still fails this, at the deadline.
    const expected = 'HEADERS\r\n\r\nBODYBODYBODY'
    const deadline = Date.now() + 2000
    while (received() !== expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))

    expect(received()).toBe(expected)
  })
})

describe('a component writing to a socket whose peer already ended its side, then dropping it', () => {
  it('still lets the write land before the handle is closed', async () => {
    const received: string[] = []
    let ended = false
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (!ended) received.push(new TextDecoder().decode(chunk))
      }
    })
    const readable = new ReadableStream<Uint8Array>({ start (controller) { controller.close() } })
    const brokerSocket: OrivonTcpSocket = {
      id: 'peer-already-ended',
      closed: new Promise(() => {}),
      close: async () => { ended = true },
      readable,
      writable,
      remoteAddress: '127.0.0.1',
      remotePort: 443,
      localAddress: '127.0.0.1',
      localPort: 55555,
      setNoDelay: async () => {},
      setKeepAlive: async () => {}
    }
    const interfaces = socketInterfaces(connectClient(brokerSocket), { dropGraceMs: 1000 })
    const createTcpSocket = (interfaces['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (family: string) => TcpSocket }).createTcpSocket
    const socket = createTcpSocket('ipv4')
    socket.startConnect({}, v4(93, 184, 216, 34, 443))
    await socket.subscribe().block()
    const [, output]: [unknown, OutputStream] = socket.finishConnect()
    await output.blockingWriteAndFlush(new TextEncoder().encode('REQUEST'))

    socket[Symbol.dispose]()

    const deadline = Date.now() + 2000
    while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(received).toEqual(['REQUEST'])
  })
})

describe('a component that wrote to a socket and dropped it without ever reading', () => {
  it('releases the read side too, after what it wrote has landed', async () => {
    const events: string[] = []
    const { socket: brokerSocket, received } = fakeBrokerSocket(30, events)
    const interfaces = socketInterfaces(connectClient(brokerSocket), { dropGraceMs: 200 })
    const createTcpSocket = (interfaces['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (family: string) => TcpSocket }).createTcpSocket
    const socket = createTcpSocket('ipv4')
    socket.startConnect({}, v4(93, 184, 216, 34, 443))
    await socket.subscribe().block()
    const [, output]: [unknown, OutputStream] = socket.finishConnect()
    await output.blockingWriteAndFlush(new TextEncoder().encode('REQUEST'))

    socket[Symbol.dispose]()

    const deadline = Date.now() + 2000
    while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(received()).toBe('REQUEST')
    expect(events).toEqual(['read side cancelled after 7 bytes landed'])
  })

  it('releases the read side of a socket it never wrote to', async () => {
    const events: string[] = []
    const { socket: brokerSocket } = fakeBrokerSocket(0, events)
    const interfaces = socketInterfaces(connectClient(brokerSocket))
    const createTcpSocket = (interfaces['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (family: string) => TcpSocket }).createTcpSocket
    const socket = createTcpSocket('ipv4')
    socket.startConnect({}, v4(93, 184, 216, 34, 443))
    await socket.subscribe().block()
    socket.finishConnect()

    socket[Symbol.dispose]()

    const deadline = Date.now() + 2000
    while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toHaveLength(1)
  })
})
