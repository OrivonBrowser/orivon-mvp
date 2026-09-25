import type { OrivonError, OrivonErrorCode } from '../../contracts/errors.js'
import type { BrokerToRendererMessage } from '../../contracts/ipc.js'
import type { PortLike } from './socket.js'
import { wrapPort } from './socket.js'
import { toOrivonError } from '../orivon-error.js'

// The isolated-world state machine for ONE TcpServer's dedicated port --
// ./socket.ts's sibling for the accept direction (A114, d-0028).
// Structured the same way so the two read alike: onData/reportConsumed there
// is onAccepted/reportAccepted here.
//
// REPORTACCEPTED REUSES CreditMessage, NOT A NEW WIRE MESSAGE -- a flagged
// AI judgment call (open-questions.md A185), matching
// ../../broker/transport/accept-pump.ts's own header, which this file is the
// renderer-side counterpart of. `bytesConsumed` below is always 1: one unit
// of demand per app `connections.getReader().read()` call, the exact
// highWaterMark: 0 semantics handle-contracts.md's "TcpServer" section
// specifies one layer down -- see ../main-world-socket.ts's own `buildServer`
// for where that one-read-one-report rule is actually enforced (its `pull()`
// is the only caller of `reportAccepted`).

/** One accepted connection, as this module hands it to surface/orivon.ts -- the socket-port.ts-shaped state machine plus the descriptor fields AcceptedMessage carried up front. */
export interface AcceptedConnection {
  readonly socketId: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
  readonly port: PortLike
}

export interface ServerPortOptions {
  readonly handleId: string
  readonly port: PortLike
}

export interface ServerPort {
  /** Fires once per accepted connection, in order. */
  onAccepted: (cb: (connection: AcceptedConnection) => void) => void
  /** Fires once when the connections stream reaches a terminal state. */
  onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  /** The app asked to accept one more connection -- see this file's own header on the reused wire shape. */
  reportAccepted: () => void
  /** Resolves on a clean end, rejects on an abrupt one -- handle-contracts.md's "Common shape". */
  readonly closed: Promise<void>
  /** Local cleanup only -- closes the port and stops the message listener. Sends nothing. */
  dispose: () => void
}

export function createServerPort (options: ServerPortOptions): ServerPort {
  const { handleId, port } = options

  let acceptedCb: ((connection: AcceptedConnection) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined) => void) | undefined
  let disposed = false

  let closedSettled = false
  let resolveClosed: () => void = () => {}
  let rejectClosed: (error: OrivonError) => void = () => {}
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  // Handled on THIS reference only, matching ./socket.ts's own `closed`
  // -- an app that never touches `closed` must not produce an unhandled
  // rejection on every abrupt close. main-world-socket.ts derives a fresh
  // promise for the page.
  closed.catch(() => {})

  function settleClosed (error?: OrivonError): void {
    if (closedSettled) return
    closedSettled = true
    if (error === undefined) resolveClosed(); else rejectClosed(error)
  }

  port.onMessage((raw) => {
    if (disposed) return
    const message = raw as BrokerToRendererMessage
    if (message == null || typeof message !== 'object' || message.handleId !== handleId) return
    switch (message.kind) {
      case 'accepted':
        acceptedCb?.({
          socketId: message.socketId,
          remoteAddress: message.remoteAddress,
          remotePort: message.remotePort,
          localAddress: message.localAddress,
          localPort: message.localPort,
          port: wrapPort(message.port)
        })
        break
      case 'end':
        readEndCb?.(message.code)
        settleClosed(message.code === undefined ? undefined : toOrivonError(message.code))
        break
      // Every byte- and datagram-domain kind is foreign to a server's own
      // port -- ./socket.ts and ./datagram.ts own those. Listed
      // explicitly, not folded into a bare default, so TypeScript narrows
      // `message` to `never` below and the NEXT new BrokerToRendererMessage
      // member landing here unhandled is a compile error rather than the
      // silent gap A114 found (open-questions.md A167/A185).
      case 'data':
      case 'write-ack':
      case 'write-failed':
      case 'datagram':
      case 'datagram-dropped':
      case 'send-ack':
      case 'send-failed':
        break
      default: {
        const exhaustive: never = message
        void exhaustive
      }
    }
  })

  return {
    onAccepted (cb) { acceptedCb = cb },
    onReadEnd (cb) { readEndCb = cb },
    reportAccepted () {
      if (disposed) return
      port.postMessage({ kind: 'credit', handleId, bytesConsumed: 1 })
    },
    closed,
    dispose () {
      if (disposed) return
      disposed = true
      port.close()
      settleClosed()
    }
  }
}
