import type { OrivonErrorCode } from '../contracts/errors.js'
import type { FailableTcpSocket } from './handle-contracts.js'
import type { PortLike, RegisteredSocket } from './port-transport.js'
import type { PortRegistry } from './port-registry.js'
import { createPortPump } from './port-pump.js'
import { createPortSink } from './port-sink.js'
import { parseRendererToBrokerMessage } from './port-messages.js'
import { errnoOf, isOrivonErrorLike } from './errors.js'

// Everything mechanical about relaying ONE socket's bytes over its dedicated
// port -- both directions -- split out of ./ipc.ts's net.connect case
// (code-guidelines.md Rule 2) so that file keeps only what is
// security-relevant: the transport check, the origin re-derivation, and the
// port delivery. This file owns none of that; it is handed an already-
// delivered PortLike and just wires it to a pump and a sink.
//
// REGISTRATION LIVES HERE TOO, not split back out to the caller, because
// registering and releasing a socket are one lifecycle, not two: whichever
// path ends the socket -- a clean close, a revoke, a write-window
// violation the sink itself detects -- must free the SAME registry slot,
// and keeping both ends in one file is what makes that easy to see.

/**
 * Maps a raw error off `socket.readable`/`socket.writable` to a closed-enum
 * code. Deliberately narrow (this is the ONE place that needs it, now
 * shared by both directions): a real Node stream wrapping a TCP socket
 * (node-adapters.ts's dialOne, via Duplex.toWeb) surfaces the underlying
 * socket's own errors here, and ECONNRESET/EPIPE are the only ones with a
 * sharper code than 'internal' worth naming. Moved from ./ipc.ts with the
 * pump it used to be private to. Exported so a real-socket test
 * (port-sink-real-socket.test.ts) can prove the write direction's actual
 * mapping rather than a mocked one, without a second copy of this logic
 * (code-guidelines.md Rule 3 -- the reason is shared, not just the shape).
 */
export function mapSocketError (error: unknown): OrivonErrorCode {
  const code = errnoOf(error)
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset'
  if (code === 'ETIMEDOUT') return 'timeout'
  return 'internal'
}

export interface SocketRelayOptions {
  readonly origin: string
  readonly socket: FailableTcpSocket
  readonly port: PortLike
  /** `net.close`'s own lookup table (./ipc.ts) -- registered here, released on cleanup. */
  readonly registry: PortRegistry<RegisteredSocket>
  /** LIMITS.readWindowBytes in production -- explicit at the call site, matching ./port-pump.ts's own initialCredit. */
  readonly readWindowBytes: number
  /** LIMITS.writeWindowBytes in production. */
  readonly writeWindowBytes: number
}

export interface SocketRelay {
  /** Unregisters the socket and closes the port. Idempotent -- safe to call from both the abandon path and socket.closed settling. */
  readonly cleanup: () => void
}

export function createSocketRelay (options: SocketRelayOptions): SocketRelay {
  const { origin, socket, port, registry, readWindowBytes, writeWindowBytes } = options

  registry.register(origin, socket.id, {
    close: socket.close,
    setNoDelay: socket.setNoDelay,
    setKeepAlive: socket.setKeepAlive
  })

  let released = false
  function cleanup (): void {
    if (released) return
    released = true
    registry.remove(origin, socket.id)
    port.close()
  }

  const pump = createPortPump({
    handleId: socket.id,
    readable: socket.readable,
    send: (message) => { port.postMessage(message) },
    initialCredit: readWindowBytes,
    mapError: mapSocketError,
    // A socket that dies underneath us releases nothing on its own:
    // socket.closed never settles otherwise, so the handler below never
    // runs and the handle stays counted against LIMITS.concurrentSockets
    // forever. See ./ipc.ts's own prior comment on this exact point --
    // moved here with the pump it describes.
    onStreamFailed: (code, error) => { socket.fail(code, errnoOf(error)) }
  })

  const sink = createPortSink({
    handleId: socket.id,
    writable: socket.writable,
    send: (message) => { port.postMessage(message) },
    windowBytes: writeWindowBytes,
    mapError: mapSocketError,
    // Symmetric with the pump's onStreamFailed: a write-window violation or
    // a real write failure is this direction's own "died underneath us",
    // and must fail the SAME handle the read side would -- freeing the
    // registry slot this file just claimed, not merely notifying the page.
    onSinkFailed: (code, error) => { socket.fail(code, errnoOf(error)) }
  })

  port.onMessage((raw) => {
    const message = parseRendererToBrokerMessage(raw)
    if (message === undefined) return
    switch (message.kind) {
      case 'credit': pump.handleCredit(message); break
      case 'write': sink.handleWrite(message); break
      case 'write-end': sink.handleEnd(message); break
      case 'write-abort': sink.handleAbort(message); break
    }
  })

  // The .catch is not decoration -- this chain is nobody's awaited promise,
  // so anything these handlers throw becomes an unhandled rejection, and
  // Node's default for those since v15 is to THROW, taking the whole
  // Electron main process down from a socket-teardown path.
  socket.closed.then(
    () => { pump.stop(); sink.stop(); cleanup() },
    (error: unknown) => {
      const code = isOrivonErrorLike(error) ? error.code : 'internal'
      pump.stop(code); sink.stop(); cleanup()
    }
  ).catch((error: unknown) => {
    console.error('[broker] releasing a socket failed after it closed', error)
  })

  return { cleanup }
}
