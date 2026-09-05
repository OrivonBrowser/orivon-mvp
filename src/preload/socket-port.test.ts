import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSocketPort } from './socket-port.js'
import { CREDIT_COALESCE_BYTES, WRITE_SILENCE_TIMEOUT_MS } from '../contracts/ipc.js'

const HANDLE = 'handle-1'

/** A controllable in-memory port -- the renderer's end (port2), mirroring ipc.test-helpers.ts's fakePort for the broker's end. */
function fakePort (): { postMessage: (m: unknown) => void, onMessage: (l: (m: unknown) => void) => void, close: () => void, sent: unknown[], emit: (m: unknown) => void } {
  let listener: ((message: unknown) => void) | undefined
  const sent: unknown[] = []
  return {
    postMessage: (message) => { sent.push(message) },
    onMessage: (l) => { listener = l },
    close: () => {},
    sent,
    emit: (message) => { listener?.(message) }
  }
}

async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('createSocketPort -- read side', () => {
  it('delivers each DataMessage to onData, in order', () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    const received: Uint8Array[] = []
    socketPort.onData((chunk) => { received.push(chunk) })

    port.emit({ kind: 'data', handleId: HANDLE, chunk: new Uint8Array([1]) })
    port.emit({ kind: 'data', handleId: HANDLE, chunk: new Uint8Array([2]) })

    expect(received).toEqual([new Uint8Array([1]), new Uint8Array([2])])
  })

  it('calls onReadEnd once, with the code if any, on a StreamEndMessage', () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    socketPort.closed.catch(() => {}) // an errored end also rejects `closed` -- not this test's concern
    const ends: Array<string | undefined> = []
    socketPort.onReadEnd((code) => { ends.push(code) })

    port.emit({ kind: 'end', handleId: HANDLE, code: 'revoked' })

    expect(ends).toEqual(['revoked'])
  })

  it('reportConsumed sends an immediate credit message once CREDIT_COALESCE_BYTES is reached', () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    socketPort.reportConsumed(CREDIT_COALESCE_BYTES)

    expect(port.sent).toEqual([{ kind: 'credit', handleId: HANDLE, bytesConsumed: CREDIT_COALESCE_BYTES }])
  })

  it('coalesces small reportConsumed calls into one credit message on the next macrotask, not immediately', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    socketPort.reportConsumed(10)
    socketPort.reportConsumed(20)
    expect(port.sent).toEqual([]) // not yet -- still below the threshold, and no macrotask has run

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(port.sent).toEqual([{ kind: 'credit', handleId: HANDLE, bytesConsumed: 30 }])
  })

  it('never depends on requestAnimationFrame -- coalescing still flushes with rAF entirely absent', async () => {
    const original = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    try {
      const port = fakePort()
      const socketPort = createSocketPort({ handleId: HANDLE, port })

      socketPort.reportConsumed(5)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(port.sent).toEqual([{ kind: 'credit', handleId: HANDLE, bytesConsumed: 5 }])
    } finally {
      if (original !== undefined) (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = original
    }
  })
})

describe('createSocketPort -- write side', () => {
  it('write() resolves once cumulative write-ack reaches the chunk length', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    const written = socketPort.write(new Uint8Array([1, 2, 3, 4]))
    expect(port.sent).toEqual([{ kind: 'write', handleId: HANDLE, chunk: new Uint8Array([1, 2, 3, 4]) }])

    port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 2 }) // partial
    await tick()
    port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 2 }) // completes it

    await expect(written).resolves.toBeUndefined()
  })

  it('a zero-byte write-ack (heartbeat) does not resolve the write early', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    let resolved = false
    const written = socketPort.write(new Uint8Array([1, 2])).then(() => { resolved = true })

    port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 0 })
    await tick()
    expect(resolved).toBe(false)

    port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 2 })
    await written
    expect(resolved).toBe(true)
  })

  it('write-failed rejects the pending write with the real code and platformCode', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    socketPort.closed.catch(() => {}) // covered separately below

    const written = socketPort.write(new Uint8Array([1]))
    port.emit({ kind: 'write-failed', handleId: HANDLE, code: 'reset', platformCode: 'ECONNRESET' })

    await expect(written).rejects.toMatchObject({ code: 'reset', platformCode: 'ECONNRESET' })
  })

  it('onFatal fires once a write-failed arrives', () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    socketPort.closed.catch(() => {}) // covered separately below
    const fatal = vi.fn()
    socketPort.onFatal(fatal)

    socketPort.write(new Uint8Array([1])).catch(() => {})
    port.emit({ kind: 'write-failed', handleId: HANDLE, code: 'limit' })

    expect(fatal).toHaveBeenCalledWith('limit')
  })

  it('endWrite sends write-end', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    await socketPort.endWrite()

    expect(port.sent).toEqual([{ kind: 'write-end', handleId: HANDLE }])
  })

  it('abortWrite sends write-abort and rejects a pending write with reset', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    socketPort.closed.catch(() => {}) // covered separately below
    const written = socketPort.write(new Uint8Array([1]))

    socketPort.abortWrite()

    expect(port.sent).toContainEqual({ kind: 'write-abort', handleId: HANDLE })
    await expect(written).rejects.toMatchObject({ code: 'reset' })
  })

  it('a message for a different handleId is ignored', () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    const received: Uint8Array[] = []
    socketPort.onData((chunk) => { received.push(chunk) })

    port.emit({ kind: 'data', handleId: 'someone-else', chunk: new Uint8Array([9]) })

    expect(received).toEqual([])
  })
})

describe('createSocketPort -- the silence watchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires onFatal with timeout after true silence past WRITE_SILENCE_TIMEOUT_MS', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    socketPort.closed.catch(() => {}) // covered separately in the closed describe block
    const fatal = vi.fn()
    socketPort.onFatal(fatal)
    const written = socketPort.write(new Uint8Array([1])).catch(() => {})

    await vi.advanceTimersByTimeAsync(WRITE_SILENCE_TIMEOUT_MS + 1)
    await written

    expect(fatal).toHaveBeenCalledWith('timeout')
  })

  it('does not fire while heartbeats (or any message) keep arriving', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    const fatal = vi.fn()
    socketPort.onFatal(fatal)
    socketPort.write(new Uint8Array([1, 1])).catch(() => {})

    // A heartbeat partway through resets the clock.
    await vi.advanceTimersByTimeAsync(WRITE_SILENCE_TIMEOUT_MS - 100)
    port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 0 })
    await vi.advanceTimersByTimeAsync(WRITE_SILENCE_TIMEOUT_MS - 100)

    expect(fatal).not.toHaveBeenCalled()
  })
})

describe('createSocketPort -- closed (settles once BOTH directions are terminal)', () => {
  it('does not settle while only the read side has ended cleanly', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    let settled = false
    socketPort.closed.then(() => { settled = true }, () => { settled = true })

    port.emit({ kind: 'end', handleId: HANDLE })
    await tick()

    expect(settled).toBe(false)
  })

  it('does not settle while only the write side has ended (endWrite called)', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    let settled = false
    socketPort.closed.then(() => { settled = true }, () => { settled = true })

    await socketPort.endWrite()
    await tick()

    expect(settled).toBe(false)
  })

  it('resolves once both a clean read end and endWrite have happened, in either order', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    port.emit({ kind: 'end', handleId: HANDLE })
    await socketPort.endWrite()

    await expect(socketPort.closed).resolves.toBeUndefined()
  })

  it('rejects immediately on an errored read end, without waiting for the write side', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    port.emit({ kind: 'end', handleId: HANDLE, code: 'revoked' })

    await expect(socketPort.closed).rejects.toMatchObject({ code: 'revoked' })
  })

  it('rejects immediately on a write-failed, without waiting for the read side', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    socketPort.write(new Uint8Array([1])).catch(() => {})
    port.emit({ kind: 'write-failed', handleId: HANDLE, code: 'reset', platformCode: 'ECONNRESET' })

    await expect(socketPort.closed).rejects.toMatchObject({ code: 'reset', platformCode: 'ECONNRESET' })
  })

  it('rejects on abortWrite with reset', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })

    socketPort.write(new Uint8Array([1])).catch(() => {})
    socketPort.abortWrite()

    await expect(socketPort.closed).rejects.toMatchObject({ code: 'reset' })
  })
})
