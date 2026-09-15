import { describe, expect, it } from 'vitest'
import { createServerPort } from '../server-port.js'

const HANDLE = 'handle-server-1'

/** A controllable in-memory port -- the renderer's end, mirroring ../../broker/transport/tests/ipc.test-helpers.ts's fakePort. */
function fakePort (): { postMessage: (m: unknown) => void, onMessage: (l: (m: unknown) => void) => void, close: () => void, sent: unknown[], emit: (m: unknown) => void, isClosed: () => boolean } {
  let listener: ((message: unknown) => void) | undefined
  let closed = false
  const sent: unknown[] = []
  return {
    postMessage: (message) => { sent.push(message) },
    onMessage: (l) => { listener = l },
    close: () => { closed = true },
    sent,
    emit: (message) => { listener?.(message) },
    isClosed: () => closed
  }
}

/** A stand-in for the raw (DOM) MessagePort AcceptedMessage.port carries -- everything ./socket-port.ts's own wrapPort touches. */
function fakeRawMessagePort (): { postMessage: (m: unknown) => void, onmessage: ((e: { data: unknown }) => void) | null, close: () => void, sent: unknown[], closeCalls: number } {
  const sent: unknown[] = []
  const state = { closeCalls: 0 }
  return {
    postMessage: (message) => { sent.push(message) },
    onmessage: null,
    close: () => { state.closeCalls++ },
    sent,
    get closeCalls () { return state.closeCalls }
  }
}

function accepted (overrides: Partial<{
  socketId: string, remoteAddress: string, remotePort: number, localAddress: string, localPort: number, port: unknown
}> = {}): Record<string, unknown> {
  return {
    kind: 'accepted',
    handleId: HANDLE,
    socketId: 'accepted-1',
    remoteAddress: '93.184.216.34',
    remotePort: 51234,
    localAddress: '10.0.0.5',
    localPort: 4001,
    port: fakeRawMessagePort(),
    ...overrides
  }
}

async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('createServerPort -- accepted connections', () => {
  it('delivers each AcceptedMessage to onAccepted, in order, with its descriptor fields intact', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    const received: Array<{ socketId: string }> = []
    serverPort.onAccepted((connection) => { received.push(connection) })

    port.emit(accepted({ socketId: 'a' }))
    port.emit(accepted({ socketId: 'b' }))

    expect(received.map((c) => c.socketId)).toEqual(['a', 'b'])
  })

  it('carries the accepted socket\'s remote/local address and port through unchanged', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    let received: { remoteAddress: string, remotePort: number, localAddress: string, localPort: number } | undefined
    serverPort.onAccepted((connection) => { received = connection })

    port.emit(accepted({ remoteAddress: '1.2.3.4', remotePort: 5555, localAddress: '10.0.0.9', localPort: 4001 }))

    expect(received).toMatchObject({ remoteAddress: '1.2.3.4', remotePort: 5555, localAddress: '10.0.0.9', localPort: 4001 })
  })

  it('wraps the raw transferred port into a PortLike the accepted connection\'s own SocketPort can use', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    let receivedPort: { postMessage: (m: unknown) => void } | undefined
    serverPort.onAccepted((connection) => { receivedPort = connection.port })
    const raw = fakeRawMessagePort()

    port.emit(accepted({ port: raw }))

    receivedPort?.postMessage({ kind: 'credit', handleId: 'accepted-1', bytesConsumed: 1 })
    expect(raw.sent).toEqual([{ kind: 'credit', handleId: 'accepted-1', bytesConsumed: 1 }])
  })

  it('ignores an accepted message addressed to a different handle', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    const received: unknown[] = []
    serverPort.onAccepted((connection) => { received.push(connection) })

    port.emit(accepted({}))
    // Force a mismatched handleId by emitting a raw object rather than
    // going through accepted()'s own default.
    port.emit({ kind: 'accepted', handleId: 'some-other-handle', socketId: 'x', remoteAddress: '', remotePort: 0, localAddress: '', localPort: 0, port: fakeRawMessagePort() })

    expect(received).toHaveLength(1)
  })
})

describe('createServerPort -- reportAccepted (the reused accept-demand signal)', () => {
  it('sends exactly one credit message per call, always bytesConsumed: 1', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })

    serverPort.reportAccepted()
    serverPort.reportAccepted()

    expect(port.sent).toEqual([
      { kind: 'credit', handleId: HANDLE, bytesConsumed: 1 },
      { kind: 'credit', handleId: HANDLE, bytesConsumed: 1 }
    ])
  })

  it('never posts after dispose()', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })

    serverPort.dispose()
    serverPort.reportAccepted()

    expect(port.sent).toEqual([])
  })
})

describe('createServerPort -- terminal states', () => {
  it('calls onReadEnd once, with the code if any, on a StreamEndMessage', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    serverPort.closed.catch(() => {}) // an errored end also rejects `closed` -- not this test's concern
    const ends: Array<string | undefined> = []
    serverPort.onReadEnd((code) => { ends.push(code) })

    port.emit({ kind: 'end', handleId: HANDLE, code: 'revoked' })

    expect(ends).toEqual(['revoked'])
  })

  it('resolves closed on a clean end (no code)', async () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })

    port.emit({ kind: 'end', handleId: HANDLE })
    await tick()

    await expect(serverPort.closed).resolves.toBeUndefined()
  })

  it('rejects closed on an abrupt end', async () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    serverPort.closed.catch(() => {})

    port.emit({ kind: 'end', handleId: HANDLE, code: 'revoked' })
    await tick()

    await expect(serverPort.closed).rejects.toMatchObject({ code: 'revoked' })
  })

  it('dispose() closes the port and resolves closed, for an app-initiated close', async () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })

    serverPort.dispose()

    expect(port.isClosed()).toBe(true)
    await expect(serverPort.closed).resolves.toBeUndefined()
  })
})

describe('createServerPort -- every non-accepted, non-end message kind is ignored, not acted on', () => {
  it('does not throw and does not fire onAccepted/onReadEnd for a byte- or datagram-domain message', () => {
    const port = fakePort()
    const serverPort = createServerPort({ handleId: HANDLE, port })
    const acceptedCalls: unknown[] = []
    const endCalls: unknown[] = []
    serverPort.onAccepted((c) => { acceptedCalls.push(c) })
    serverPort.onReadEnd((c) => { endCalls.push(c) })

    expect(() => {
      port.emit({ kind: 'data', handleId: HANDLE, chunk: new Uint8Array([1]) })
      port.emit({ kind: 'write-ack', handleId: HANDLE, bytesAccepted: 1 })
      port.emit({ kind: 'write-failed', handleId: HANDLE, code: 'internal' })
      port.emit({ kind: 'datagram', handleId: HANDLE, data: new Uint8Array([1]), address: '1.2.3.4', port: 80, family: 'IPv4', dropped: 0 })
      port.emit({ kind: 'datagram-dropped', handleId: HANDLE, dropped: 1 })
      port.emit({ kind: 'send-ack', handleId: HANDLE, datagramsAccepted: 1 })
      port.emit({ kind: 'send-failed', handleId: HANDLE, code: 'denied', dropped: 1, address: '1.2.3.4', port: 80 })
    }).not.toThrow()

    expect(acceptedCalls).toEqual([])
    expect(endCalls).toEqual([])
  })
})
