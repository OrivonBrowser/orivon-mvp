import { describe, expect, it, vi } from 'vitest'
import { createSocketRelay } from './socket-relay.js'
import { createPortRegistry } from './port-registry.js'
import { fakePort, fakeTcpSocket } from './ipc.test-helpers.js'
import type { PortRegistry } from './port-registry.js'
import type { RegisteredSocket } from './port-transport.js'

const ORIGIN = 'https://app.example'

/** Lets fire-and-forget promise chains progress before assertions run -- same idiom as ipc.test-helpers.ts's tick(). */
async function tick (times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function registeredEntry (registry: PortRegistry<RegisteredSocket>, id = 'handle-1'): RegisteredSocket | undefined {
  return registry.get(ORIGIN, id)
}

describe('createSocketRelay -- read side (unchanged behaviour, relayed through the pump)', () => {
  it('relays the readable stream as DataMessages, then a clean end', async () => {
    const chunk = new Uint8Array([1, 2, 3])
    const readable = new ReadableStream<Uint8Array>({ start (c) { c.enqueue(chunk); c.close() } })
    const { socket } = fakeTcpSocket(readable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    await tick()

    expect(port.sent).toEqual([
      { kind: 'data', handleId: 'handle-1', chunk },
      { kind: 'end', handleId: 'handle-1' }
    ])
  })

  it('threads an inbound credit message to the pump without throwing', async () => {
    const { socket } = fakeTcpSocket()
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    await tick()

    expect(() => { port.emit({ kind: 'credit', handleId: 'handle-1', bytesConsumed: 100 }) }).not.toThrow()
  })
})

describe('createSocketRelay -- write side (new: routes write/write-end/write-abort to the sink)', () => {
  it('an inbound write message reaches the socket\'s real writable, and acks', async () => {
    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({ write (chunk) { written.push(chunk) } })
    const { socket } = fakeTcpSocket(new ReadableStream(), writable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit({ kind: 'write', handleId: 'handle-1', chunk: new Uint8Array([9, 9]) })
    await tick()

    expect(written).toEqual([new Uint8Array([9, 9])])
    expect(port.sent).toContainEqual({ kind: 'write-ack', handleId: 'handle-1', bytesAccepted: 2 })
  })

  it('write-end drains and closes the writer', async () => {
    let closed = false
    const writable = new WritableStream<Uint8Array>({ close () { closed = true } })
    const { socket } = fakeTcpSocket(new ReadableStream(), writable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit({ kind: 'write-end', handleId: 'handle-1' })
    await tick()

    expect(closed).toBe(true)
  })

  it('write-abort reaches the writer\'s abort()', async () => {
    const abortReasons: unknown[] = []
    const writable = new WritableStream<Uint8Array>({ abort (r) { abortReasons.push(r) } })
    const { socket } = fakeTcpSocket(new ReadableStream(), writable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit({ kind: 'write-abort', handleId: 'handle-1' })
    await tick()

    expect(abortReasons).toHaveLength(1)
  })

  it('a write-window violation fails the handle AND frees its registry slot, not just a wire message', async () => {
    const writable = new WritableStream<Uint8Array>({ write: async () => await new Promise(() => {}) })
    const { socket, failSpy } = fakeTcpSocket(new ReadableStream(), writable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 10 })
    expect(registeredEntry(registry)).toBeDefined()

    port.emit({ kind: 'write', handleId: 'handle-1', chunk: new Uint8Array(6) })
    port.emit({ kind: 'write', handleId: 'handle-1', chunk: new Uint8Array(6) }) // 6+6 > 10 -- over the window
    await tick()

    expect(failSpy).toHaveBeenCalledWith('limit', undefined)
    expect(registeredEntry(registry)).toBeUndefined() // the socket-budget slot was actually freed
  })
})

describe('createSocketRelay -- registers and releases, exactly once', () => {
  it('registers the socket under (origin, id) at construction', () => {
    const { socket } = fakeTcpSocket()
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })

    expect(registeredEntry(registry)).toBeDefined()
  })

  it('a clean socket.closed resolution unregisters the socket and closes the port', async () => {
    const { socket, settleClosed } = fakeTcpSocket()
    const port = fakePort()
    const closePort = vi.spyOn(port, 'close')
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    settleClosed()
    await tick()

    expect(registeredEntry(registry)).toBeUndefined()
    expect(closePort).toHaveBeenCalledOnce()
  })

  it('cleanup() is idempotent, whether called directly or reached again via socket.closed', async () => {
    const { socket, settleClosed } = fakeTcpSocket()
    const port = fakePort()
    const closePort = vi.spyOn(port, 'close')
    const registry = createPortRegistry<RegisteredSocket>()

    const relay = createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    relay.cleanup()
    settleClosed()
    await tick()

    expect(closePort).toHaveBeenCalledTimes(1)
  })
})
