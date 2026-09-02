import { describe, expect, it, vi } from 'vitest'
import { createPortPump } from './port-pump.js'
import type { DataMessage, PortMessage, StreamEndMessage } from '../contracts/ipc.js'

const HANDLE = 'handle-1'

/** A readable stream that enqueues `chunks` one per pull(), then closes. */
function chunkStream (chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull (controller) {
      onPull?.()
      const next = chunks[i]
      if (next !== undefined) {
        controller.enqueue(next)
        i++
      } else {
        controller.close()
      }
    }
  })
}

/** A readable stream that enqueues `chunks`, then errors instead of closing. */
function erroringStream (chunks: Uint8Array[], error: unknown): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull (controller) {
      const next = chunks[i]
      if (next !== undefined) {
        controller.enqueue(next)
        i++
      } else {
        controller.error(error)
      }
    }
  })
}

const chunk = (n: number): Uint8Array => new Uint8Array(n).fill(1)

/** Lets a fire-and-forget async pump loop progress before assertions run. */
async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function dataMessages (send: ReturnType<typeof vi.fn>): DataMessage[] {
  return send.mock.calls.map((call) => call[0] as PortMessage).filter((m): m is DataMessage => m.kind === 'data')
}

function endMessages (send: ReturnType<typeof vi.fn>): StreamEndMessage[] {
  return send.mock.calls.map((call) => call[0] as PortMessage).filter((m): m is StreamEndMessage => m.kind === 'end')
}

describe('createPortPump', () => {
  it('sends each chunk from the readable stream as a DataMessage tagged with handleId, in order', async () => {
    const send = vi.fn()
    createPortPump({ handleId: HANDLE, readable: chunkStream([chunk(3), chunk(5)]), send, initialCredit: 1_000 })

    await tick()

    expect(dataMessages(send)).toEqual([
      { kind: 'data', handleId: HANDLE, chunk: chunk(3) },
      { kind: 'data', handleId: HANDLE, chunk: chunk(5) }
    ])
  })

  it('sends exactly one clean end message (no code) once the readable stream ends', async () => {
    const send = vi.fn()
    createPortPump({ handleId: HANDLE, readable: chunkStream([chunk(3)]), send, initialCredit: 1_000 })

    await tick()

    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE }])
  })

  it('stops reading once the credit budget is exhausted, without sending an end message', async () => {
    const send = vi.fn()
    let pulls = 0
    // Far more than fits in 25 bytes of credit at 10 bytes/chunk -- if the
    // pump kept reading regardless of credit, this would never stop.
    const manyChunks = Array.from({ length: 100 }, () => chunk(10))
    createPortPump({ handleId: HANDLE, readable: chunkStream(manyChunks, () => { pulls++ }), send, initialCredit: 25 })

    await tick(20)

    expect(dataMessages(send)).toHaveLength(3) // 10 + 10 + 10 = 30, exhausts a 25-byte budget
    // Exactly one pull ahead of what was sent, never more: a default
    // ReadableStream's own queuing strategy (highWaterMark: 1) refills its
    // internal queue by one item the instant each read() dequeues the
    // previous one -- independent of whether the pump asks for another --
    // plus the one pull the stream fires proactively on construction.
    // That's real Streams-API behaviour, not the pump ignoring credit: the
    // pump itself never calls reader.read() a 4th time (its own while
    // condition is false), so nothing beyond this single bounded readahead
    // chunk is ever consumed from the underlying source.
    expect(pulls).toBe(dataMessages(send).length + 1)
    expect(endMessages(send)).toEqual([])
  })

  it('resumes reading once handleCredit reports enough consumption, and can then finish', async () => {
    const send = vi.fn()
    const manyChunks = Array.from({ length: 5 }, () => chunk(10))
    const pump = createPortPump({ handleId: HANDLE, readable: chunkStream(manyChunks), send, initialCredit: 25 })
    await tick()
    expect(dataMessages(send)).toHaveLength(3) // stalled at 30 bytes sent against 25 credit

    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: 30 })
    await tick()

    expect(dataMessages(send)).toHaveLength(5) // the remaining 2 chunks, then EOF
    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE }])
  })

  it('ignores a credit message addressed to a different handle', async () => {
    const send = vi.fn()
    const manyChunks = Array.from({ length: 5 }, () => chunk(10))
    const pump = createPortPump({ handleId: HANDLE, readable: chunkStream(manyChunks), send, initialCredit: 10 })
    await tick()
    expect(dataMessages(send)).toHaveLength(1)

    pump.handleCredit({ kind: 'credit', handleId: 'some-other-handle', bytesConsumed: 1_000 })
    await tick()

    expect(dataMessages(send)).toHaveLength(1) // unchanged -- the credit did not apply here
  })

  it('stop() sends exactly one end message carrying the given code', async () => {
    const send = vi.fn()
    const pump = createPortPump({ handleId: HANDLE, readable: chunkStream([chunk(3)]), send, initialCredit: 1_000 })

    pump.stop('revoked')
    await tick()

    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE, code: 'revoked' }])
  })

  it('stop() with no argument sends a clean end with no code field at all', async () => {
    const send = vi.fn()
    const pump = createPortPump({ handleId: HANDLE, readable: chunkStream([chunk(3)]), send, initialCredit: 1_000 })

    pump.stop()
    await tick()

    const ends = endMessages(send)
    expect(ends).toHaveLength(1)
    const end = ends[0] as StreamEndMessage
    expect(end).toEqual({ kind: 'end', handleId: HANDLE })
    expect(Object.hasOwn(end, 'code')).toBe(false)
  })

  it('does not send a second end message if stop() is called after a natural end already sent one', async () => {
    const send = vi.fn()
    const pump = createPortPump({ handleId: HANDLE, readable: chunkStream([chunk(3)]), send, initialCredit: 1_000 })
    await tick()
    expect(endMessages(send)).toHaveLength(1)

    pump.stop('revoked')
    await tick()

    expect(endMessages(send)).toHaveLength(1) // still one -- the natural end wins, stop() is a no-op after it
  })

  it('a read error sends an end message using the injected error mapper, exactly once', async () => {
    const send = vi.fn()
    const boom = new Error('ECONNRESET')
    const mapError = vi.fn().mockReturnValue('reset')
    createPortPump({ handleId: HANDLE, readable: erroringStream([chunk(3)], boom), send, initialCredit: 1_000, mapError })

    await tick()

    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE, code: 'reset' }])
    expect(mapError).toHaveBeenCalledWith(boom)
  })

  it('defaults a read error to internal when no error mapper is given', async () => {
    const send = vi.fn()
    createPortPump({ handleId: HANDLE, readable: erroringStream([], new Error('boom')), send, initialCredit: 1_000 })

    await tick()

    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE, code: 'internal' }])
  })

  it('handleCredit after stop() has no observable effect', async () => {
    const send = vi.fn()
    const manyChunks = Array.from({ length: 5 }, () => chunk(10))
    const pump = createPortPump({ handleId: HANDLE, readable: chunkStream(manyChunks), send, initialCredit: 10 })
    await tick()
    pump.stop('revoked')
    await tick()
    const callsAtStop = send.mock.calls.length

    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: 1_000 })
    await tick()

    expect(send.mock.calls.length).toBe(callsAtStop)
  })
})

describe('the credit window bounds the broker, whatever the renderer reports', () => {
  // contracts/ipc.ts: "the broker sends at most LIMITS.readWindowBytes ahead
  // of what has been acknowledged... When the outstanding credit budget
  // reaches zero it STOPS READING THE UNDERLYING OS SOCKET." The renderer is
  // the party that window exists to bound, so its own figures cannot be
  // allowed to raise it.
  it('an Infinity credit does not disable the window', async () => {
    const send = vi.fn()
    const pump = createPortPump({
      handleId: HANDLE, readable: chunkStream(Array.from({ length: 100 }, () => chunk(10))), send, initialCredit: 25
    })
    await tick(20)
    expect(dataMessages(send)).toHaveLength(3)

    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: Number.POSITIVE_INFINITY })
    await tick(50)

    // Clamped to the 25-byte window, so exactly one more window's worth
    // moves -- not the whole 1000-byte stream.
    expect(dataMessages(send).length).toBeLessThanOrEqual(6)
  })

  it('a NaN credit is ignored rather than poisoning the budget', async () => {
    const send = vi.fn()
    const pump = createPortPump({
      handleId: HANDLE, readable: chunkStream(Array.from({ length: 5 }, () => chunk(10))), send, initialCredit: 25
    })
    await tick()
    expect(dataMessages(send)).toHaveLength(3)

    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: Number.NaN })
    await tick()
    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: 30 })
    await tick()

    // A NaN that had been added would make every later `credit > 0` false,
    // stranding the stream permanently even after a valid credit arrives.
    expect(dataMessages(send)).toHaveLength(5)
    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE }])
  })

  it('a negative credit is ignored rather than driving the budget below zero', async () => {
    const send = vi.fn()
    const pump = createPortPump({
      handleId: HANDLE, readable: chunkStream(Array.from({ length: 5 }, () => chunk(10))), send, initialCredit: 25
    })
    await tick()
    expect(dataMessages(send)).toHaveLength(3)

    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: -1_000_000 })
    await tick()
    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: 30 })
    await tick()

    expect(dataMessages(send)).toHaveLength(5)
  })

  it('honest credit still refills the budget to exactly one window, no further', async () => {
    const send = vi.fn()
    const pump = createPortPump({
      handleId: HANDLE, readable: chunkStream(Array.from({ length: 100 }, () => chunk(10))), send, initialCredit: 25
    })
    await tick(20)
    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: 30 })
    await tick(20)

    // 3 sent, budget back to 25, so 3 more -- the same shape as the first
    // window rather than an ever-growing one.
    expect(dataMessages(send)).toHaveLength(6)
  })
})

describe('onStreamFailed marks a stream that died, and only that', () => {
  it('fires with the mapped code and the raw error when the stream errors', async () => {
    const send = vi.fn()
    const onStreamFailed = vi.fn()
    const rawError = Object.assign(new Error('reset by peer'), { code: 'ECONNRESET' })
    const readable = new ReadableStream<Uint8Array>({ pull (c) { c.error(rawError) } })
    createPortPump({
      handleId: HANDLE, readable, send, initialCredit: 1_000, onStreamFailed, mapError: () => 'reset'
    })
    await tick(10)

    expect(onStreamFailed).toHaveBeenCalledWith('reset', rawError)
    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE, code: 'reset' }])
  })

  it('does NOT fire on a clean EOF -- a peer FIN leaves the socket writable (half-close)', async () => {
    const send = vi.fn()
    const onStreamFailed = vi.fn()
    createPortPump({ handleId: HANDLE, readable: chunkStream([chunk(4)]), send, initialCredit: 1_000, onStreamFailed })
    await tick(10)

    expect(endMessages(send)).toEqual([{ kind: 'end', handleId: HANDLE }])
    expect(onStreamFailed).not.toHaveBeenCalled()
  })

  it('does NOT fire on stop() -- that path already has an owner releasing the handle', async () => {
    const send = vi.fn()
    const onStreamFailed = vi.fn()
    const pump = createPortPump({
      handleId: HANDLE, readable: chunkStream([chunk(4)]), send, initialCredit: 1_000, onStreamFailed
    })
    pump.stop('revoked')
    await tick(10)

    expect(onStreamFailed).not.toHaveBeenCalled()
  })

  it('fires exactly once even if credit keeps arriving after the stream has already errored', async () => {
    // A ReadableStream rejects every FUTURE read() with the same error once
    // errored (WHATWG Streams spec, not re-invoked pull()) -- so a stray
    // CreditMessage arriving after the failure must not re-enter the pump
    // and call onStreamFailed a second time for the same handle.
    const send = vi.fn()
    const onStreamFailed = vi.fn()
    const readable = new ReadableStream<Uint8Array>({
      pull (c) { c.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' })) }
    })
    const pump = createPortPump({
      handleId: HANDLE, readable, send, initialCredit: 25, onStreamFailed, mapError: () => 'reset'
    })
    await tick(10)
    expect(onStreamFailed).toHaveBeenCalledTimes(1)

    pump.handleCredit({ kind: 'credit', handleId: HANDLE, bytesConsumed: 1_000 })
    await tick(10)

    expect(onStreamFailed).toHaveBeenCalledTimes(1)
  })
})
