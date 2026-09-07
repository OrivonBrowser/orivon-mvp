import { afterEach, describe, expect, it } from 'vitest'
import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { bindUdp, readableOf } from '../udp-adapter.js'
import type { BoundUdpSocket } from '../../broker-contracts.js'
import { LIMITS } from '../../../contracts/index.js'

// Against REAL UDP sockets on loopback, not mocks -- the same stance
// node-adapters.test.ts takes for TCP. What is being checked here is the part
// a mock would happily lie about: that a bind actually lands inside the range
// checkBind returned, and that an overrun drops rather than grows.

const opened: Array<BoundUdpSocket | DgramSocket> = []

afterEach(async () => {
  for (const socket of opened.splice(0)) {
    if ('destroy' in socket) await socket.destroy('closed')
    else socket.close()
  }
})

async function bindIn (lo: number, hi: number): Promise<BoundUdpSocket> {
  const socket = await bindUdp([{ lo, hi }], new AbortController().signal)
  opened.push(socket)
  return socket
}

/** A real peer that echoes one datagram back to wherever it came from. */
async function echoPeer (): Promise<{ port: number }> {
  const peer = createSocket('udp4')
  opened.push(peer)
  peer.on('message', (data, rinfo) => { peer.send(data, rinfo.port, rinfo.address) })
  await new Promise<void>((resolve) => { peer.bind(0, '127.0.0.1', resolve) })
  return { port: peer.address().port }
}

describe('bindUdp -- where it lands', () => {
  it('binds inside the range it was given', async () => {
    const socket = await bindIn(41000, 41010)
    expect(socket.localPort).toBeGreaterThanOrEqual(41000)
    expect(socket.localPort).toBeLessThanOrEqual(41010)
  })

  it('binds the exact port when the range is one port wide', async () => {
    const socket = await bindIn(41100, 41100)
    expect(socket.localPort).toBe(41100)
  })

  it('reports a real bound address, not a placeholder', async () => {
    const socket = await bindIn(41200, 41210)
    expect(socket.localAddress).toBe('0.0.0.0')
  })

  // The property A88 turns on: localPort is populated BEFORE the caller sees
  // the socket, which is what removes the synchronous address() problem the
  // spike shim had to cache around.
  it('has its port resolved by the time it resolves', async () => {
    const socket = await bindIn(41300, 41310)
    expect(Number.isInteger(socket.localPort)).toBe(true)
    expect(socket.localPort).toBeGreaterThan(0)
  })

  it('fails rather than escaping the range when every port in it is taken', async () => {
    const blocker = createSocket('udp4')
    opened.push(blocker)
    await new Promise<void>((resolve) => { blocker.bind(41400, '0.0.0.0', resolve) })
    await expect(bindUdp([{ lo: 41400, hi: 41400 }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'limit' })
  })

  it('tries other ports in the range before giving up', async () => {
    const blocker = createSocket('udp4')
    opened.push(blocker)
    await new Promise<void>((resolve) => { blocker.bind(41500, '0.0.0.0', resolve) })
    const socket = await bindIn(41500, 41501)
    expect(socket.localPort).toBe(41501)
  })

  // D4 regression: a real occupied port sits inside a wider range of free
  // ones, so this only passes if the retry loop actually moves past a real
  // EADDRINUSE from a real socket -- a mock would happily lie about it.
  it('lands on a real free port when a real port in the range is occupied', async () => {
    const occupiedPort = 41520
    const blocker = createSocket('udp4')
    opened.push(blocker)
    await new Promise<void>((resolve) => { blocker.bind(occupiedPort, '0.0.0.0', resolve) })

    const socket = await bindIn(41518, 41524)
    expect(socket.localPort).not.toBe(occupiedPort)
    expect(socket.localPort).toBeGreaterThanOrEqual(41518)
    expect(socket.localPort).toBeLessThanOrEqual(41524)
  })

  it('refuses a bind whose grant was withdrawn before it started', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(bindUdp([{ lo: 41600, hi: 41600 }], controller.signal))
      .rejects.toMatchObject({ code: 'revoked' })
  })
})

describe('bindUdp -- moving real datagrams', () => {
  it('sends a datagram and reads the reply back off the readable', async () => {
    const peer = await echoPeer()
    const socket = await bindIn(41700, 41710)

    const outcome = await socket.send({
      data: new Uint8Array([1, 2, 3, 4]), address: '127.0.0.1', port: peer.port, family: 'IPv4'
    })
    expect(outcome.sent).toBe(true)

    const reader = socket.readable.getReader()
    const { value } = await reader.read()
    expect(value?.data).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(value?.address).toBe('127.0.0.1')
    expect(value?.port).toBe(peer.port)
    expect(value?.family).toBe('IPv4')
    reader.releaseLock()
  })

  it('reports an oversized send as a refusal rather than throwing', async () => {
    const peer = await echoPeer()
    const socket = await bindIn(41800, 41810)
    const outcome = await socket.send({
      data: new Uint8Array(LIMITS.maxDatagramBytes + 1),
      address: '127.0.0.1',
      port: peer.port,
      family: 'IPv4'
    })
    expect(outcome).toMatchObject({ sent: false, code: 'invalid' })
  })

  // A87: a failed send must never reject, because the caller's only way to
  // report a rejection is to error a WritableStream, and that kills the socket.
  it('never rejects on a send that could not be delivered', async () => {
    const socket = await bindIn(41900, 41910)
    await expect(socket.send({
      data: new Uint8Array([1]), address: '127.0.0.1', port: 1, family: 'IPv4'
    })).resolves.toBeDefined()
  })
})

describe('bindUdp -- the inbound window drops rather than grows', () => {
  // THE WINDOW IS INJECTED HERE, AND IT HAS TO BE. Filling the production
  // window (1 MiB) over loopback is not something a test can do reliably:
  // measured on this machine, 288 rapid 8-byte sends delivered 221 -- the
  // KERNEL drops before the window is ever reached, so the assertion would be
  // testing the receive buffer rather than this file. Two 512-byte datagrams
  // fill the window below, which no receive buffer will interfere with. Same
  // reason ../../transport/port-pump.ts takes `initialCredit` as an option.
  const TINY_WINDOW = 1024
  const PAYLOAD = new Uint8Array(512)

  async function bindTiny (lo: number, hi: number): Promise<BoundUdpSocket> {
    const socket = await bindUdp([{ lo, hi }], new AbortController().signal, TINY_WINDOW)
    opened.push(socket)
    return socket
  }

  async function sendMany (to: number, count: number): Promise<void> {
    const sender = createSocket('udp4')
    opened.push(sender)
    for (let i = 0; i < count; i += 1) {
      sender.send(PAYLOAD, to, '127.0.0.1')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  it('counts a datagram it discarded instead of queueing it', async () => {
    // Nothing reads `socket.readable`, so the queue fills after two and every
    // datagram past that is discarded rather than buffered.
    const socket = await bindTiny(42000, 42010)
    await sendMany(socket.localPort, 8)
    expect(socket.droppedInbound).toBeGreaterThan(0)
  })

  it('reopens the window once the reader drains what was queued', async () => {
    const socket = await bindTiny(42050, 42060)
    await sendMany(socket.localPort, 8)
    expect(socket.droppedInbound).toBeGreaterThan(0)

    // A window that filled once and never reopened looks identical to a
    // working socket right up until the app stops receiving anything.
    const reader = socket.readable.getReader()
    await reader.read()
    await reader.read()

    const droppedBefore = socket.droppedInbound
    await sendMany(socket.localPort, 1)
    const { value } = await reader.read()
    expect(value?.data.byteLength).toBe(512)
    expect(socket.droppedInbound).toBe(droppedBefore)
    reader.releaseLock()
  })

  it('leaves the window intact for a reader that keeps up', async () => {
    const socket = await bindIn(42100, 42110)
    const sender = createSocket('udp4')
    opened.push(sender)

    const reader = socket.readable.getReader()
    sender.send(new Uint8Array([7]), socket.localPort, '127.0.0.1')
    const { value } = await reader.read()
    expect(value?.data).toEqual(new Uint8Array([7]))
    expect(socket.droppedInbound).toBe(0)
    reader.releaseLock()
  })
})

// D5 (defect 1): a single async OS error on the shared dgram socket used to
// end the readable unconditionally, which tears down every OTHER peer's
// traffic on the same handle -- the exact shape A87 already fixed for a
// policy-denied send, never extended to an OS-reported error. A real Linux
// socket will not reliably reproduce a peer-shaped async error on demand (a
// throwaway probe found that an unconnected, bind()-only socket's 'error'
// event does not even fire for the obvious trigger -- see the commit
// message), so this drives `readableOf` directly against a fake emitter that
// stands in for a real DgramSocket, which only ever calls `.on(...)` on it.
describe('readableOf -- classifying a socket-level error', () => {
  function fakeSocket (): DgramSocket {
    return new EventEmitter() as unknown as DgramSocket
  }

  it('does not end the stream for a peer-shaped error -- later datagrams still arrive', async () => {
    const socket = fakeSocket()
    const readable = readableOf(socket, { count: 0 }, 1024)
    const reader = readable.getReader()

    socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
    socket.emit('message', Buffer.from([9]), { address: '127.0.0.1', port: 1234, family: 'IPv4' })

    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value?.data).toEqual(new Uint8Array([9]))
    reader.releaseLock()
  })

  it('does not end the stream for an error the OS gave no errno at all', async () => {
    const socket = fakeSocket()
    const readable = readableOf(socket, { count: 0 }, 1024)
    const reader = readable.getReader()

    socket.emit('error', new Error('unattributed'))
    socket.emit('message', Buffer.from([1]), { address: '127.0.0.1', port: 1, family: 'IPv4' })

    const { value } = await reader.read()
    expect(value?.data).toEqual(new Uint8Array([1]))
    reader.releaseLock()
  })

  it('ends the stream for a genuinely fd-fatal error', async () => {
    const socket = fakeSocket()
    const readable = readableOf(socket, { count: 0 }, 1024)
    const reader = readable.getReader()

    socket.emit('error', Object.assign(new Error('bad fd'), { code: 'EBADF' }))

    await expect(reader.read()).rejects.toMatchObject({ code: 'internal', platformCode: 'EBADF' })
  })
})

describe('bindUdp -- an abort landing mid-bind', () => {
  // D4 regression. Aborting here, before the first await, lands while
  // socket.bind() is genuinely pending: real Node dgram sockets emit neither
  // 'error' nor the bind callback when closed in that window, only 'close' --
  // so this used to hang forever instead of rejecting. A raw socket.close()
  // in the abort handler is also reachable a second time once the retry loop
  // closes the same socket again, which throws ERR_SOCKET_DGRAM_NOT_RUNNING
  // synchronously inside an AbortSignal listener -- uncaught there, not
  // caught by this async function's own try/catch.
  it('settles instead of hanging, and never reaches the process as an uncaught exception', async () => {
    const uncaught: unknown[] = []
    const onUncaughtException = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', onUncaughtException)

    try {
      const controller = new AbortController()
      const promise = bindUdp([{ lo: 43000, hi: 43010 }], controller.signal)
      controller.abort()
      await expect(promise).rejects.toMatchObject({ code: 'revoked' })
    } finally {
      process.removeListener('uncaughtException', onUncaughtException)
    }
    expect(uncaught).toEqual([])
  })
})
