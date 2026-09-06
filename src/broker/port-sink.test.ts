import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortSink } from './port-sink.js'
import type { WriteAckMessage, WriteFailedMessage } from '../contracts/ipc.js'
import { CREDIT_COALESCE_BYTES, WRITE_HEARTBEAT_MS } from '../contracts/ipc.js'
import { tick } from './ipc.test-helpers.js'

const HANDLE = 'handle-1'

const chunk = (n: number): Uint8Array => new Uint8Array(n).fill(1)

/**
 * A WritableStream whose write()/close() settle only when the test tells
 * them to -- the write-side mirror of port-pump.test.ts's chunkStream, which
 * controls pull() the same way for the read side.
 */
function controllableWritable (): {
  writable: WritableStream<Uint8Array>
  written: Uint8Array[]
  resolveNext: () => void
  rejectNext: (error: unknown) => void
  abortReasons: unknown[]
  closeCalls: number
} {
  const written: Uint8Array[] = []
  const resolvers: Array<() => void> = []
  const rejecters: Array<(error: unknown) => void> = []
  const abortReasons: unknown[] = []
  const state = { closeCalls: 0 }
  const writable = new WritableStream<Uint8Array>({
    write (chunk) {
      written.push(chunk)
      return new Promise<void>((resolve, reject) => { resolvers.push(resolve); rejecters.push(reject) })
    },
    close () {
      state.closeCalls++
      // Never settles -- matches the measured Duplex.toWeb quirk this sink
      // is written around: close() does not resolve until the whole duplex
      // is destroyed, well after the underlying socket's FIN completes.
      return new Promise<void>(() => {})
    },
    abort (reason) { abortReasons.push(reason) }
  })
  return {
    writable,
    written,
    resolveNext: () => { resolvers.shift()?.() },
    rejectNext: (error) => { rejecters.shift()?.(error) },
    abortReasons,
    get closeCalls () { return state.closeCalls }
  }
}

/** A WritableStream that accepts every write immediately (default queuing). */
function immediateWritable (): { writable: WritableStream<Uint8Array>, written: Uint8Array[] } {
  const written: Uint8Array[] = []
  return { writable: new WritableStream<Uint8Array>({ write (chunk) { written.push(chunk) } }), written }
}

function acks (send: ReturnType<typeof vi.fn>): WriteAckMessage[] {
  return send.mock.calls.map((call) => call[0]).filter((m): m is WriteAckMessage => m.kind === 'write-ack')
}

function failures (send: ReturnType<typeof vi.fn>): WriteFailedMessage[] {
  return send.mock.calls.map((call) => call[0]).filter((m): m is WriteFailedMessage => m.kind === 'write-failed')
}

describe('createPortSink -- basic write/ack flow', () => {
  it('writes bytes to the underlying writable, in order, byte-identical', async () => {
    const { writable, written } = immediateWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(3) })
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(5) })
    await tick()

    expect(written).toEqual([chunk(3), chunk(5)])
  })

  it('acks a single write immediately once accepted, with its own byte length', async () => {
    const { writable } = immediateWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(7) })
    await tick()

    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 7 }])
  })

  it('coalesces acks for writes accepted in the same burst into one message', async () => {
    const { writable } = immediateWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    // All three admitted synchronously, before any of their write() promises
    // has a chance to settle -- so the underlying stream resolves them one
    // at a time, and only the last resolution finds nothing else pending.
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(3) })
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(5) })
    await tick()

    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 12 }])
  })

  it('flushes early once CREDIT_COALESCE_BYTES has been accepted, even with more still pending', async () => {
    const { writable, resolveNext } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: CREDIT_COALESCE_BYTES * 3 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(CREDIT_COALESCE_BYTES) })
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(10) }) // still pending after this
    await tick() // let the underlying sink actually receive the first write
    resolveNext() // the first, large write settles; the second is still outstanding
    await tick()

    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: CREDIT_COALESCE_BYTES }])
  })

  it('acks a zero-length write, so its write() promise is never left unresolved', async () => {
    const { writable } = immediateWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(0) })
    await tick()

    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 0 }])
  })

  it('ignores a message addressed to a different handleId', () => {
    const { writable, written } = immediateWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: 'some-other-handle', chunk: chunk(3) })

    expect(written).toEqual([])
  })
})

describe('createPortSink -- the write window bounds broker memory', () => {
  it('refuses a write that would exceed the window, with code limit, and stops the sink', async () => {
    const { writable, written } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 100, onSinkFailed })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(60) }) // admitted, unacked = 60
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(60) }) // 60+60 > 100 -- refused

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'limit' }])
    expect(onSinkFailed).toHaveBeenCalledWith('limit', expect.anything())
    await tick()
    expect(written).toHaveLength(1) // the second chunk never reached the writable

    // The sink is now stopped -- a further write is refused too, silently,
    // exactly as port-pump.ts's handleCredit is a no-op after stop().
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(1) })
    await tick()
    expect(written).toHaveLength(1)
  })

  it('a well-behaved sequence that exactly fills and drains the window never trips limit', async () => {
    const { writable, resolveNext } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 30, onSinkFailed })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(30) }) // fills the window exactly
    await tick()
    resolveNext()
    await tick()
    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 30 }])

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(30) }) // window fully drained, so this fits again
    await tick()
    resolveNext()
    await tick()

    expect(onSinkFailed).not.toHaveBeenCalled()
    expect(failures(send)).toEqual([])
  })

  it('rejects a flood of zero-length writes once too many are outstanding at once, even though none of them costs a single byte against the window', () => {
    // Never resolves -- models the worst case, where nothing ever drains,
    // so pendingCount only ever climbs. A byte-based window alone cannot
    // see this flood at all: unacked stays 0 forever for a zero-length
    // chunk, so every one of these would otherwise be admitted (T11b).
    const { writable, written } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000_000, onSinkFailed })

    for (let i = 0; i < 10_000; i++) {
      sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(0) })
    }

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'limit' }])
    expect(onSinkFailed).toHaveBeenCalledWith('limit', expect.anything())
    // Proof the cap actually bit well before all 10,000 were queued.
    expect(written.length).toBeLessThan(1_000)
  })
})

describe('createPortSink -- errors from the underlying writable', () => {
  it('a rejecting write sends write-failed with the mapped code and platformCode, and stops the sink', async () => {
    const { writable, written, rejectNext } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const boom = Object.assign(new Error('EPIPE'), { code: 'EPIPE' })
    const sink = createPortSink({
      handleId: HANDLE, writable, send, windowBytes: 1_000, onSinkFailed,
      mapError: () => 'reset'
    })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    rejectNext(boom)
    await tick()

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'reset', platformCode: 'EPIPE' }])
    expect(onSinkFailed).toHaveBeenCalledWith('reset', boom)
    expect(written).toHaveLength(1)

    // Stopped: a further write never reaches the (now-errored) writable.
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(1) })
    expect(written).toHaveLength(1)
  })

  it('defaults a write error to internal when no error mapper is given', async () => {
    const { writable, rejectNext } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    rejectNext(new Error('boom'))
    await tick()

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'internal' }])
  })

  it('a denied-coded failure never carries a platformCode, regardless of which rule caused it', async () => {
    const { writable, rejectNext } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({
      handleId: HANDLE, writable, send, windowBytes: 1_000,
      mapError: () => 'denied'
    })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    rejectNext(Object.assign(new Error('whatever'), { code: 'EACCES' }))
    await tick()

    const failure = failures(send)[0]
    expect(failure?.code).toBe('denied')
    expect(Object.hasOwn(failure ?? {}, 'platformCode')).toBe(false)
  })
})

describe('createPortSink -- the writable independently ending underneath a write (A69: peer FIN, allowHalfOpen: false)', () => {
  it('maps the resulting AbortError to write-failed code closed, not internal, and does not fail the whole handle', async () => {
    // The exact shape Node 24.11.1 produces for a write() issued after our
    // own writable auto-ended on a peer FIN with allowHalfOpen: false --
    // confirmed empirically against a real socket, not assumed.
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
    const { writable, rejectNext } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const sink = createPortSink({
      handleId: HANDLE, writable, send, windowBytes: 1_000, onSinkFailed,
      mapError: () => 'internal' // what the OLD, wrong behaviour would have produced
    })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    rejectNext(abortError)
    await tick()

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'closed' }])
    expect(onSinkFailed).not.toHaveBeenCalled()
  })

  it('still maps a genuine transport failure (a real ECONNRESET) the ordinary way, unaffected by the A69 special case', async () => {
    const { writable, rejectNext } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const boom = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
    const sink = createPortSink({
      handleId: HANDLE, writable, send, windowBytes: 1_000, onSinkFailed, mapError: () => 'reset'
    })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    rejectNext(boom)
    await tick()

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'reset', platformCode: 'ECONNRESET' }])
    expect(onSinkFailed).toHaveBeenCalledWith('reset', boom)
  })
})

describe('createPortSink -- write-end (half-close)', () => {
  it('drains queued writes before closing, and never awaits close() settling', async () => {
    // NOTE: read `.closeCalls` off `controllable` at each check, never
    // destructure it -- destructuring a getter snapshots its value once, at
    // destructure time, rather than tracking it live.
    const controllable = controllableWritable()
    const { writable, written, resolveNext } = controllable
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    sink.handleEnd({ kind: 'write-end', handleId: HANDLE })
    await tick()

    expect(controllable.closeCalls).toBe(0) // the queued write has not settled yet -- close must wait for it
    resolveNext()
    await tick()

    expect(written).toHaveLength(1)
    expect(controllable.closeCalls).toBe(1) // close() was called once the write drained
    // The sink's own promise chain does not hang despite close() never
    // settling -- proven by the fact this test itself completes.
  })

  it('refuses a write arriving after write-end with code closed, and never touches the writable', async () => {
    const { writable, written } = immediateWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleEnd({ kind: 'write-end', handleId: HANDLE })
    await tick()
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'closed' }])
    expect(written).toEqual([])
  })
})

describe('createPortSink -- a rejected writer.close()', () => {
  it('reports write-failed when the FIN never actually went out', async () => {
    let rejectClose: (error: unknown) => void = () => {}
    const writable = new WritableStream<Uint8Array>({
      close () { return new Promise((_resolve, reject) => { rejectClose = reject }) }
    })
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000, mapError: () => 'internal' })

    sink.handleEnd({ kind: 'write-end', handleId: HANDLE })
    await tick()
    rejectClose(new Error('close failed'))
    await tick()

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'internal' }])
  })
})

describe('createPortSink -- write-abort (RST)', () => {
  it('aborts the writer, fires onSinkFailed with reset, and discards further writes', async () => {
    const { writable, abortReasons } = controllableWritable()
    const send = vi.fn()
    const onSinkFailed = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000, onSinkFailed })

    sink.handleAbort({ kind: 'write-abort', handleId: HANDLE })

    expect(onSinkFailed).toHaveBeenCalledWith('reset', expect.anything())
    await tick()
    expect(abortReasons).toHaveLength(1)

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    expect(onSinkFailed).toHaveBeenCalledTimes(1) // the refused write did not re-fire it
  })
})

describe('createPortSink -- the write heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('emits a zero-byte ack while a write sits unaccepted past the heartbeat interval', async () => {
    const { writable } = controllableWritable() // never resolves -- the write stays pending
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000, heartbeatMs: WRITE_HEARTBEAT_MS })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await vi.advanceTimersByTimeAsync(WRITE_HEARTBEAT_MS)

    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 0 }])
  })

  it('carries bytes already earned by an earlier resolved write instead of zero, when a later write is still outstanding', async () => {
    const { writable, resolveNext } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000, heartbeatMs: WRITE_HEARTBEAT_MS })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) }) // W1: small
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(10) }) // W2: stays pending
    await vi.advanceTimersByTimeAsync(0) // both reach the writable; pendingCount = 2
    resolveNext() // W1 resolves; W2 still outstanding, so pendingCount stays 1 -- no flush yet
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(WRITE_HEARTBEAT_MS) // heartbeat fires while W2 is still pending

    expect(acks(send)).toEqual([{ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 4 }])
  })

  it('does not heartbeat once nothing is outstanding', async () => {
    const { writable, resolveNext } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000, heartbeatMs: WRITE_HEARTBEAT_MS })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await vi.advanceTimersByTimeAsync(0) // let the underlying sink actually receive the write
    resolveNext()
    await vi.advanceTimersByTimeAsync(0)
    send.mockClear()

    await vi.advanceTimersByTimeAsync(WRITE_HEARTBEAT_MS * 3)

    expect(send).not.toHaveBeenCalled()
  })

  it('stop() clears the heartbeat timer, so it never fires afterward', async () => {
    const { writable } = controllableWritable() // never resolves -- the write stays pending
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000, heartbeatMs: WRITE_HEARTBEAT_MS })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await vi.advanceTimersByTimeAsync(0)
    sink.stop()
    send.mockClear()

    await vi.advanceTimersByTimeAsync(WRITE_HEARTBEAT_MS * 3)

    expect(send).not.toHaveBeenCalled()
  })
})

describe('createPortSink -- the heartbeat timer cannot keep the process alive on its own', () => {
  it('is unref()d as soon as it is armed', () => {
    const { writable } = controllableWritable() // never resolves -- keeps the timer armed
    const send = vi.fn()
    const realSetTimeout = setTimeout
    const unref = vi.fn()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms)
      timer.unref = unref
      return timer
    }) as typeof setTimeout)

    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })
    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })

    expect(unref).toHaveBeenCalled()

    sink.stop() // clears the real timer before this test ends
    setTimeoutSpy.mockRestore()
  })
})

describe('createPortSink -- stop()', () => {
  // stop() never touches the writer -- see its own doc comment. By the time
  // a real caller (socket-relay.ts) reaches it, HandleTable's injected
  // destroy callback has already sent the CloseReason-correct wire signal
  // (FIN or RST) directly on the raw socket; a stop()-driven abort() here
  // would risk sending a SECOND, contradictory one (RST after a real FIN).
  it('is idempotent, never touches the writer, and blocks further writes', async () => {
    const { writable, written, abortReasons } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.stop()
    sink.stop()

    expect(abortReasons).toEqual([])

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    expect(written).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('never touches the writer even with a write still pending when it is called', async () => {
    const { writable, abortReasons } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    sink.stop()

    expect(abortReasons).toEqual([])
  })

  it('does not interfere with a writable that already closed cleanly via write-end', async () => {
    const { writable, abortReasons, resolveNext } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    resolveNext()
    await tick()
    sink.handleEnd({ kind: 'write-end', handleId: HANDLE }) // nothing left pending -- closes right away
    await tick()

    sink.stop()

    expect(abortReasons).toEqual([]) // already ended cleanly -- stop() is a no-op here
  })

  it('stop(code) reports the real reason for a write still outstanding, instead of leaving it to the renderer\'s own silence timeout', async () => {
    const { writable, abortReasons } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    sink.stop('revoked')

    expect(failures(send)).toEqual([{ kind: 'write-failed', handleId: HANDLE, code: 'revoked' }])
    expect(abortReasons).toEqual([]) // still never touches the writer -- see the tests above
  })

  it('an ordinary stop() with no code stays silent even with a write outstanding', async () => {
    const { writable } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.handleWrite({ kind: 'write', handleId: HANDLE, chunk: chunk(4) })
    await tick()
    sink.stop()

    expect(failures(send)).toEqual([])
  })

  it('stop(code) sends nothing extra when nothing was outstanding', () => {
    const { writable } = controllableWritable()
    const send = vi.fn()
    const sink = createPortSink({ handleId: HANDLE, writable, send, windowBytes: 1_000 })

    sink.stop('revoked')

    expect(failures(send)).toEqual([])
  })
})
