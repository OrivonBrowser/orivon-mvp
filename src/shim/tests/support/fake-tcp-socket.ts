// A fake TcpSocket (src/contracts/handles.ts) for exercising node-http-client.ts
// without a broker, a preload or an Electron launch -- exactly the "fake
// orivon.net.connectSecure returning a real in-memory TcpSocket-shaped
// duplex" the queue item's own instructions describe as fully unit-testable.
// Under tests/support/ (not tests/) because it is a shared test fixture, not
// itself a test file -- vitest.config.ts's `include` only matches
// `*.test.ts`, so this file is never picked up as one.

import type { OrivonErrorCode } from '../../../contracts/errors.js'
import type { TcpSocket } from '../../../contracts/handles.js'

export interface FakeTcpSocket {
  readonly socket: TcpSocket
  /** Every chunk the client has written, in write order. */
  readonly written: Uint8Array[]
  /** Simulates bytes arriving from the remote peer. */
  push (chunk: Uint8Array): void
  /** Simulates the remote peer sending FIN (clean end). */
  end (): void
  /** Simulates the remote peer resetting the connection (or the broker reporting a fault). */
  fail (code: OrivonErrorCode, message: string, platformCode?: string): void
  /** Whether the client called socket.close(). */
  closed (): boolean
}

function makeOrivonError (code: OrivonErrorCode, message: string, platformCode?: string): Error {
  const error = new Error(message) as Error & { code: OrivonErrorCode, platformCode?: string }
  error.code = code
  if (platformCode !== undefined) error.platformCode = platformCode
  return error
}

export function createFakeTcpSocket (): FakeTcpSocket {
  let readableController!: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start (controller) { readableController = controller }
  })

  const written: Uint8Array[] = []
  const writable = new WritableStream<Uint8Array>({
    write (chunk) { written.push(chunk) }
  })

  let didClose = false
  const socket: TcpSocket = {
    id: 'fake-tcp-socket',
    closed: new Promise(() => {}),
    close: async () => { didClose = true },
    readable,
    writable,
    remoteAddress: '127.0.0.1',
    remotePort: 80,
    localAddress: '127.0.0.1',
    localPort: 55555,
    setNoDelay: async () => {},
    setKeepAlive: async () => {}
  }

  return {
    socket,
    written,
    push: (chunk) => readableController.enqueue(chunk),
    end: () => readableController.close(),
    fail: (code, message, platformCode) => readableController.error(makeOrivonError(code, message, platformCode)),
    closed: () => didClose
  }
}
