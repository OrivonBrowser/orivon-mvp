import { describe, expect, it, vi } from 'vitest'
import { createSocketRelay } from './socket-relay.js'
import { createPortRegistry } from './port-registry.js'
import { fakePort, fakeTcpSocket, tick } from './ipc.test-helpers.js'
import type { PortRegistry } from './port-registry.js'
import type { RegisteredSocket } from './port-transport.js'

const ORIGIN = 'https://app.example'

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

  it('write-abort reaches both the writer\'s abort() and socket.abort(), and frees the registry slot', async () => {
    const abortReasons: unknown[] = []
    const writable = new WritableStream<Uint8Array>({ abort (r) { abortReasons.push(r) } })
    const { socket, abortSpy } = fakeTcpSocket(new ReadableStream(), writable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    port.emit({ kind: 'write-abort', handleId: 'handle-1' })
    await tick()

    expect(abortReasons).toHaveLength(1)
    // socket.abort() -- not socket.fail() -- is what reaches HandleTable.abort
    // in production, the path that produces a real RST rather than a plain
    // destroy (handles.ts).
    expect(abortSpy).toHaveBeenCalledOnce()
    expect(registeredEntry(registry)).toBeUndefined()
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

describe('createSocketRelay -- socket.fail/socket.abort must never crash the message listener that calls them', () => {
  it('does not throw synchronously when socket.fail itself throws (the handle table already reaped for this origin)', async () => {
    const writable = new WritableStream<Uint8Array>({ write: async () => await new Promise(() => {}) })
    const { socket } = fakeTcpSocket(new ReadableStream(), writable)
    // FailableTcpSocket.fail's own contract promises it never throws, but a
    // caller upstream of this test (HandleTable.fail, handles.ts) can --
    // this stands in for that, to prove createSocketRelay tolerates it
    // rather than relying on the promise always holding.
    const throwingFail = vi.fn(() => { throw new Error('no such handle for this origin') })
    const socketWithThrowingFail = { ...socket, fail: throwingFail }
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket: socketWithThrowingFail, port, registry, readWindowBytes: 1_000, writeWindowBytes: 10 })

    // A write-window violation reaches handleWrite's own fail() synchronously,
    // which is what now reaches socket.fail straight from this listener --
    // see ./socket-relay.ts's own comment on failSocket.
    expect(() => {
      port.emit({ kind: 'write', handleId: 'handle-1', chunk: new Uint8Array(6) })
      port.emit({ kind: 'write', handleId: 'handle-1', chunk: new Uint8Array(6) }) // 6+6 > 10
    }).not.toThrow()
    await tick()
    expect(throwingFail).toHaveBeenCalled()
  })

  it('does not throw synchronously when socket.abort itself throws', async () => {
    const writable = new WritableStream<Uint8Array>({ abort () {} })
    const { socket } = fakeTcpSocket(new ReadableStream(), writable)
    // Same contract, same reason as socket.fail above -- HandleTable.abort
    // (handles.ts) can throw (e.g. an id already reaped by a racing revoke).
    const throwingAbort = vi.fn(() => { throw new Error('no such handle for this origin') })
    const socketWithThrowingAbort = { ...socket, abort: throwingAbort }
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket: socketWithThrowingAbort, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })

    expect(() => { port.emit({ kind: 'write-abort', handleId: 'handle-1' }) }).not.toThrow()
    await tick()
    expect(throwingAbort).toHaveBeenCalled()
  })
})

describe('createSocketRelay -- stop() (the abandon path)', () => {
  it('stops the pump too, so a chunk already buffered in the stream never reaches port.postMessage', async () => {
    const chunk = new Uint8Array([9, 9, 9])
    // Never closes -- there is always more the pump COULD read, the same
    // shape as a live socket abandoned mid-stream.
    const readable = new ReadableStream<Uint8Array>({ start (c) { c.enqueue(chunk) } })
    const { socket } = fakeTcpSocket(readable)
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    const relay = createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    relay.stop('internal') // before the pump's own in-flight reader.read() has a chance to settle
    await tick()

    // stop() itself legitimately sends one terminal end message -- what
    // must never arrive is the buffered chunk the pump was mid-read on.
    expect(port.sent).not.toContainEqual({ kind: 'data', handleId: 'handle-1', chunk })
  })

  it('also frees the registry slot and closes the port, like cleanup()', async () => {
    const { socket } = fakeTcpSocket()
    const port = fakePort()
    const closePort = vi.spyOn(port, 'close')
    const registry = createPortRegistry<RegisteredSocket>()

    const relay = createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    relay.stop('internal')

    expect(registeredEntry(registry)).toBeUndefined()
    expect(closePort).toHaveBeenCalledOnce()
  })
})

describe('createSocketRelay -- the renderer-side port closing frees resources too', () => {
  it('triggers the same cleanup as socket.closed settling, even though socket.closed itself never settles', async () => {
    const { socket } = fakeTcpSocket() // an idle, healthy, established socket -- closed never settles on its own
    const port = fakePort()
    const closePort = vi.spyOn(port, 'close')
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    expect(registeredEntry(registry)).toBeDefined()

    port.simulateClose()
    await tick()

    expect(registeredEntry(registry)).toBeUndefined()
    expect(closePort).toHaveBeenCalledOnce()
  })

  it('stops the sink heartbeat too, so an orphaned socket cannot keep a timer alive on its own', async () => {
    vi.useFakeTimers()
    try {
      const writable = new WritableStream<Uint8Array>({ write: async () => await new Promise(() => {}) }) // never resolves
      const { socket } = fakeTcpSocket(new ReadableStream(), writable)
      const port = fakePort()
      const registry = createPortRegistry<RegisteredSocket>()

      createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
      port.emit({ kind: 'write', handleId: 'handle-1', chunk: new Uint8Array([1]) })
      await vi.advanceTimersByTimeAsync(0)

      port.simulateClose()
      await vi.advanceTimersByTimeAsync(0)
      const sentBeforeWaiting = port.sent.length

      await vi.advanceTimersByTimeAsync(30_000) // several heartbeat intervals, if the timer were still armed

      expect(port.sent.length).toBe(sentBeforeWaiting)
    } finally {
      vi.useRealTimers()
    }
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

describe('createSocketRelay -- unlink (open-questions.md A84/A70)', () => {
  it('releases the registry slot the moment the handle is unlinked, without waiting for `closed`', async () => {
    const { socket, unlink } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    expect(registeredEntry(registry)).toBeDefined()

    unlink('revoked', 'revoked')

    // `closed` is deliberately left pending: A84's non-draining peer holds it
    // open forever, and before this hook that pinned the slot with it.
    expect(registeredEntry(registry)).toBeUndefined()
  })

  it('closes the port on unlink, so an abandoned socket stops costing a port', async () => {
    const { socket, unlink } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    unlink('revoked', 'revoked')

    expect(port.isClosed()).toBe(true)
  })

  it('reports the terminal code it was unlinked with, so a revoke does not read as a clean end', async () => {
    const { socket, unlink } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    unlink('revoked', 'revoked')
    await tick()

    expect(port.sent).toContainEqual({ kind: 'end', handleId: 'handle-1', code: 'revoked' })
  })

  it('does NOT tear down on a clean close -- that would truncate the app\'s queued bytes', async () => {
    const { socket, unlink } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    unlink('closed', undefined)
    await tick()

    // stop() cancels the reader, and cancelling a Duplex.toWeb readable
    // destroys the whole socket -- discarding whatever destroySocket's end()
    // was about to flush. Measured: 8 MiB queued, 8 MiB lost. The clean close
    // settles through `closed` instead, which the drain deadline guarantees.
    expect(registeredEntry(registry)).toBeDefined()
    expect(port.isClosed()).toBe(false)
  })

  it('a session teardown is a flushing reason too, and is left alone the same way', async () => {
    const { socket, unlink } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    // destroySocket('sessionEnded') calls end(), not resetAndDestroy -- so it
    // flushes, and its CODE is 'revoked', which is exactly why the branch reads
    // the REASON rather than the code.
    unlink('sessionEnded', 'revoked')
    await tick()

    expect(registeredEntry(registry)).toBeDefined()
  })

  it('still tears down immediately for an abort, which destroys the socket anyway', async () => {
    const { socket, unlink } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    unlink('aborted', 'reset')

    expect(registeredEntry(registry)).toBeUndefined()
  })

  it('is idempotent against `closed` settling afterwards', async () => {
    const { socket, unlink, settleClosed } = fakeTcpSocket(new ReadableStream())
    const port = fakePort()
    const registry = createPortRegistry<RegisteredSocket>()

    createSocketRelay({ origin: ORIGIN, socket, port, registry, readWindowBytes: 1_000, writeWindowBytes: 1_000 })
    unlink('revoked', 'revoked')
    settleClosed()
    await tick()

    expect(port.sent.filter((m) => (m as { kind: string }).kind === 'end')).toHaveLength(1)
  })
})
