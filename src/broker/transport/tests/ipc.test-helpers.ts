// Shared fixtures for ipc.test.ts, ipc-rate-limit.test.ts and
// transport/relay/tests/socket.test.ts -- all three test handleControlRequest/
// createSocketRelay against the same Broker/ControlEvent/PortLike/
// FailableTcpSocket shapes (code-guidelines.md Rule 3: the reason for reuse
// is that all three exercise the same seams, not a stylistic preference).
//
// The fake `Broker` double itself (`stubBroker`/`BrokerCall`) now lives in
// ./stub-broker.ts -- split out under code-guidelines.md Rule 2 once this
// file reached the 500-line ceiling (measured 499/500, A195) -- and is
// re-exported below so no existing `from './ipc.test-helpers.js'` import
// site needed to change.

import { vi } from 'vitest'
import type { ControlEvent, PortLike, PortPair, PortTransport } from '../ipc.js'
import { createPortRegistry } from '../relay/port-registry.js'
import type { Datagram, OrivonError, OrivonErrorCode } from '../../../contracts/index.js'
import type { CloseReason, FailableTcpServer, FailableTcpSocket, FailableUdpSocket } from '../../handles/handle-contracts.js'
import type { RequestEnvelope } from '../../../contracts/ipc.js'

export type { BrokerCall } from './stub-broker.js'
export { stubBroker } from './stub-broker.js'

export const APP = 'https://app.example'
export const OTHER = 'https://other.example'

/** A ControlEvent whose senderFrame resolves to `origin` via originFromSenderFrame. */
export function frameFor (origin: string): ControlEvent {
  return { senderFrame: { url: `${origin}/index.html`, origin, postMessage: vi.fn() } }
}

export const NO_FRAME: ControlEvent = { senderFrame: null }

export function envelope (method: string, payload: unknown, timeoutMs = 1_000): RequestEnvelope<unknown> {
  return { id: 'req-1', method, payload, timeoutMs }
}

/** A promise that never settles -- models a broker call still in flight when a timeout fires. */
export function never<T> (): Promise<T> {
  return new Promise<T>(() => {})
}

/**
 * A controllable in-memory PortLike -- captures every postMessage, lets a
 * test simulate the renderer sending a message back (`emit`), and lets a
 * test simulate the renderer's own side of the port closing (`simulateClose`).
 *
 * `postMessage` THROWS once `close()` has been called, matching a real
 * `MessagePortMain`'s own behaviour -- a fake that instead accepted a
 * postMessage after close silently would let a caller that keeps posting
 * to a closed port pass its tests while crashing the real Electron main
 * process the moment it ran for real.
 */
export function fakePort (): PortLike & {
  readonly sent: unknown[]
  /** The transfer list passed alongside each `sent` message, same index -- `undefined` where none was given. Only ever non-empty for an AcceptedMessage (transport/relay/tests/server.test.ts). */
  readonly transfers: Array<readonly unknown[] | undefined>
  emit: (message: unknown) => void
  simulateClose: () => void
  isClosed: () => boolean
} {
  let listener: ((message: unknown) => void) | undefined
  let closeListener: (() => void) | undefined
  let closed = false
  const sent: unknown[] = []
  const transfers: Array<readonly unknown[] | undefined> = []
  return {
    postMessage: (message, transfer) => {
      if (closed) throw new Error('Object has been destroyed')
      sent.push(message)
      transfers.push(transfer)
    },
    onMessage: (l) => { listener = l },
    onClose: (l) => { closeListener = l },
    close: () => { closed = true },
    sent,
    transfers,
    emit: (message) => { listener?.(message) },
    simulateClose: () => { closeListener?.() },
    isClosed: () => closed
  }
}

export function fakePortPair (): { readonly pair: PortPair, readonly port1: ReturnType<typeof fakePort> } {
  const port1 = fakePort()
  return { pair: { port1, port2: 'fake-port2' }, port1 }
}

/** A PortTransport whose createPortPair always returns the SAME pair -- fine for tests that make at most one net.connect call. */
export function fakeTransport (pair: PortPair): PortTransport {
  return { createPortPair: () => pair, registry: createPortRegistry() }
}

/**
 * A PortTransport that mints a FRESH `fakePortPair()` on every
 * `createPortPair()` call, tracking each one in order. `fakeTransport`'s
 * single fixed pair is not enough wherever a test drives more than one port
 * at once -- transport/relay/tests/server.test.ts's own server port plus one fresh pair per
 * accepted connection, distinct from each other and from the server's.
 */
export function fakeMultiTransport (): PortTransport & { readonly pairs: ReadonlyArray<ReturnType<typeof fakePortPair>> } {
  const pairs: Array<ReturnType<typeof fakePortPair>> = []
  return {
    createPortPair: () => {
      const next = fakePortPair()
      pairs.push(next)
      return next.pair
    },
    registry: createPortRegistry(),
    pairs
  }
}

export interface FakeSocket {
  readonly socket: FailableTcpSocket
  readonly closeSpy: ReturnType<typeof vi.fn>
  readonly failSpy: ReturnType<typeof vi.fn>
  readonly abortSpy: ReturnType<typeof vi.fn>
  readonly settleClosed: (error?: OrivonError) => void
  /** Fires whatever the socket's consumer registered via `onUnlink`, the way HandleTable's own unlink pass does. Leaves `closed` pending, which is the case that matters. */
  readonly unlink: (reason: CloseReason, code?: OrivonErrorCode) => void
}

/**
 * A FailableTcpSocket whose `readable`/`writable` a test controls directly
 * and whose `closed` a test settles on demand -- close()/fail() themselves
 * settle it, the same way the real ones do (index.ts's connect()).
 */
export function fakeTcpSocket (
  readable: ReadableStream<Uint8Array> = new ReadableStream({ start: (c) => { c.close() } }),
  writable: WritableStream<Uint8Array> = new WritableStream()
): FakeSocket {
  let settle: (error?: OrivonError) => void = () => {}
  let settled = false
  let unlinkListener: ((reason: CloseReason, code?: OrivonErrorCode) => void) | undefined
  const closed = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(); else reject(error)
    }
  })
  const closeSpy = vi.fn(async () => { settle() })
  const failSpy = vi.fn((code: OrivonErrorCode, platformCode?: string) => {
    const err = { name: 'OrivonError', message: 'the handle failed', code, platformCode } as OrivonError
    settle(err)
  })
  const abortSpy = vi.fn(() => {
    const err = { name: 'OrivonError', message: 'the app aborted this handle', code: 'reset' as OrivonErrorCode } as OrivonError
    settle(err)
  })
  const socket: FailableTcpSocket = {
    id: 'handle-1',
    closed,
    close: closeSpy,
    fail: failSpy,
    abort: abortSpy,
    readable,
    writable,
    remoteAddress: '93.184.216.34',
    remotePort: 443,
    localAddress: '10.0.0.5',
    localPort: 54321,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    onUnlink: (listener) => { unlinkListener = listener }
  }
  return {
    socket,
    closeSpy,
    failSpy,
    abortSpy,
    settleClosed: settle,
    unlink: (reason, code) => { unlinkListener?.(reason, code) }
  }
}

/** Lets a fire-and-forget pump/wiring chain progress before assertions run. */
export async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

export interface FakeUdpSocket {
  readonly socket: FailableUdpSocket
  readonly closeSpy: ReturnType<typeof vi.fn>
  readonly failSpy: ReturnType<typeof vi.fn>
  readonly settleClosed: (error?: OrivonError) => void
  readonly unlink: (reason: CloseReason, code?: OrivonErrorCode) => void
}

/** ./fakeTcpSocket's counterpart. `send` resolves `{ sent: true }` unless overridden. */
export function fakeUdpSocket (
  readable: ReadableStream<Datagram> = new ReadableStream({ start: (c) => { c.close() } }),
  send: FailableUdpSocket['send'] = async () => ({ sent: true })
): FakeUdpSocket {
  let settle: (error?: OrivonError) => void = () => {}
  let settled = false
  let unlinkListener: ((reason: CloseReason, code?: OrivonErrorCode) => void) | undefined
  const closed = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(); else reject(error)
    }
  })
  const closeSpy = vi.fn(async () => { settle() })
  const failSpy = vi.fn((code: OrivonErrorCode, platformCode?: string) => {
    settle({ name: 'OrivonError', message: 'the handle failed', code, platformCode } as OrivonError)
  })
  const socket: FailableUdpSocket = {
    id: 'handle-udp-1',
    closed,
    close: closeSpy,
    fail: failSpy,
    abort: vi.fn(),
    readable,
    send,
    localAddress: '0.0.0.0',
    localPort: 6881,
    droppedInbound: 0,
    onUnlink: (listener) => { unlinkListener = listener }
  }
  return {
    socket,
    closeSpy,
    failSpy,
    settleClosed: settle,
    unlink: (reason, code) => { unlinkListener?.(reason, code) }
  }
}

export interface FakeTcpServer {
  readonly server: FailableTcpServer
  readonly closeSpy: ReturnType<typeof vi.fn>
  readonly failSpy: ReturnType<typeof vi.fn>
  readonly settleClosed: (error?: OrivonError) => void
  readonly unlink: (reason: CloseReason, code?: OrivonErrorCode) => void
  /** Pushes one accepted connection into `server.connections` -- one per unit of demand a test has already granted, exactly like a real accept(). */
  readonly acceptOne: (socket: FailableTcpSocket) => void
  /** Ends `server.connections` cleanly (`controller.close()`). */
  readonly endConnections: () => void
  /** Ends `server.connections` abruptly (`controller.error()`). */
  readonly errorConnections: (error: unknown) => void
}

/**
 * ./fakeTcpSocket's/fakeUdpSocket's counterpart for a `FailableTcpServer`.
 *
 * `highWaterMark: 0` on `connections`, matching capabilities/net.ts's own
 * `entry.connections` exactly (handle-contracts.md's "TcpServer" section) --
 * a test drives it item by item via `acceptOne`, the same one-per-real-read
 * shape `createAcceptPump` (./accept-pump.js) expects on the other end.
 */
export function fakeTcpServer (): FakeTcpServer {
  let settle: (error?: OrivonError) => void = () => {}
  let settled = false
  let unlinkListener: ((reason: CloseReason, code?: OrivonErrorCode) => void) | undefined
  const closed = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (settled) return
      settled = true
      if (error === undefined) resolve(); else reject(error)
    }
  })
  const closeSpy = vi.fn(async () => { settle() })
  const failSpy = vi.fn((code: OrivonErrorCode, platformCode?: string) => {
    settle({ name: 'OrivonError', message: 'the handle failed', code, platformCode } as OrivonError)
  })
  let controller: ReadableStreamDefaultController<FailableTcpSocket> | undefined
  const connections = new ReadableStream<FailableTcpSocket>({
    start (c) { controller = c }
  }, { highWaterMark: 0 })
  const server: FailableTcpServer = {
    id: 'handle-server-1',
    closed,
    close: closeSpy,
    fail: failSpy,
    connections,
    localAddress: '0.0.0.0',
    localPort: 4001,
    onUnlink: (listener) => { unlinkListener = listener }
  }
  return {
    server,
    closeSpy,
    failSpy,
    settleClosed: settle,
    unlink: (reason, code) => { unlinkListener?.(reason, code) },
    acceptOne: (socket) => { controller?.enqueue(socket) },
    endConnections: () => { controller?.close() },
    errorConnections: (error) => { controller?.error(error) }
  }
}
