// createSocketPort's read-end ordering, the platform code a peer reset
// carries, and the copy a partial view gets before it is posted. Kept apart
// from socket-port.test.ts, which covers the credit and write windows.
import { describe, expect, it } from 'vitest'
import { createSocketPort } from '../socket-port.js'
import { LIMITS } from '../../contracts/limits.js'

const HANDLE = 'handle-1'

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

describe('createSocketPort -- an errored read end', () => {
  it('hands the platform code to onReadEnd and to the rejection of `closed`', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    const ends: Array<[string | undefined, string | undefined]> = []
    socketPort.onReadEnd((code, platformCode) => { ends.push([code, platformCode]) })

    port.emit({ kind: 'end', handleId: HANDLE, code: 'reset', platformCode: 'ECONNRESET' })

    expect(ends).toEqual([['reset', 'ECONNRESET']])
    await expect(socketPort.closed).rejects.toMatchObject({ code: 'reset', platformCode: 'ECONNRESET' })
  })

  it('rejects `closed` with the real reason even when the callback disposes the port on the spot', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    socketPort.onReadEnd(() => { socketPort.dispose() })

    port.emit({ kind: 'end', handleId: HANDLE, code: 'reset' })

    await expect(socketPort.closed).rejects.toMatchObject({ code: 'reset' })
  })
})

describe('createSocketPort -- partial views are posted as their own copy', () => {
  it('never posts a view whose buffer is larger than the view', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    const parent = new Uint8Array(1024).fill(7)

    const pending = socketPort.write(parent.subarray(10, 20))
    port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 10 })
    await pending

    const posted = (port.sent[0] as { chunk: Uint8Array }).chunk
    expect(posted.byteLength).toBe(10)
    expect(posted.buffer.byteLength).toBe(10)
    expect(Array.from(posted)).toEqual(new Array(10).fill(7))
  })

  it('copies each piece of a write split at the write window, not the whole parent per piece', async () => {
    const port = fakePort()
    const socketPort = createSocketPort({ handleId: HANDLE, port })
    const total = LIMITS.writeWindowBytes * 2 + 5

    const pending = socketPort.write(new Uint8Array(total))
    for (let i = 0; i < 3; i++) {
      await Promise.resolve()
      const last = port.sent[port.sent.length - 1] as { chunk: Uint8Array }
      port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: last.chunk.byteLength })
    }
    await pending

    const chunks = port.sent.map((m) => (m as { chunk: Uint8Array }).chunk)
    expect(chunks.map((c) => c.byteLength)).toEqual([LIMITS.writeWindowBytes, LIMITS.writeWindowBytes, 5])
    for (const c of chunks) expect(c.buffer.byteLength).toBe(c.byteLength)
  })
})
