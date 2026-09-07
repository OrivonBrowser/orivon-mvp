import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { FailableTcpSocket } from '../handles/handle-contracts.js'
import type { PortLike, RegisteredSocket } from './port-transport.js'
import type { PortRegistry } from './port-registry.js'
import { createPortPump } from './port-pump.js'
import { createPortSink } from './port-sink.js'
import { parseRendererToBrokerMessage } from './port-messages.js'
import { errnoOf, isOrivonErrorLike } from '../errors.js'

// Everything mechanical about relaying ONE socket's bytes over its
// dedicated port, in both directions: given an already-delivered PortLike,
// wires it to a read pump and a write sink, and owns the one registry slot
// both directions and ./ipc.ts's net.close/net.setNoDelay/net.setKeepAlive
// share. See src/broker/README.md's "Design notes" for why registration
// and release live in this one file rather than split back to the caller.

/**
 * Maps a raw error off `socket.readable`/`socket.writable` to a closed-enum
 * code. Deliberately narrow: a real Node stream wrapping a TCP socket
 * (node-adapters.ts's dialOne, via Duplex.toWeb) surfaces the underlying
 * socket's own errors here, and ECONNRESET/EPIPE are the only ones with a
 * sharper code than 'internal' worth naming. Exported so a real-socket test
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
  /**
   * Stops both the pump and the sink, then cleans up. Idempotent, via the
   * same `cleanup` and the pump/sink's own stop() guards.
   *
   * `cleanup()` alone unregisters the socket and closes the port, but
   * leaves the pump free to still be mid-`pumpLoop` when it returns --
   * still reading the OS socket and calling `port.postMessage` on a port
   * that was just closed. `./ipc.ts`'s abandon path (a request that fails
   * after the socket already exists) needs this, not `cleanup()` alone.
   */
  readonly stop: (code?: OrivonErrorCode) => void
}

export function createSocketRelay (options: SocketRelayOptions): SocketRelay {
  const { origin, socket, port, registry, readWindowBytes, writeWindowBytes } = options

  registry.register(origin, socket.id, {
    kind: 'tcp',
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

  // `socket.fail` (FailableTcpSocket, handle-contracts.ts) promises it never
  // throws, but its real implementation is HandleTable.fail (handles.ts),
  // which can -- e.g. if this origin's whole table was already reaped
  // before a queued write-abort for the same handle is delivered. Both
  // callers below now reach it SYNCHRONOUSLY from port.onMessage, so an
  // uncaught throw here would crash the whole Electron main process from a
  // teardown path with nowhere further to report to.
  function failSocket (code: OrivonErrorCode, error: unknown): void {
    try {
      socket.fail(code, errnoOf(error))
    } catch (caught) {
      console.error('[broker] failing a socket handle threw', caught)
    }
  }

  // Same tolerance as failSocket above, and for the same reason: socket.abort
  // (FailableTcpSocket, handle-contracts.ts) promises it never throws, but
  // its real implementation (HandleTable.abort, handles.ts) can, and this is
  // reached synchronously from port.onMessage via the sink's onAbort.
  function abortSocket (): void {
    try {
      socket.abort()
    } catch (caught) {
      console.error('[broker] aborting a socket handle threw', caught)
    }
  }

  // Shared by the pump and the sink (code-guidelines.md Rule 3 -- one
  // implementation, not two identical closures). Guarded the same way: a
  // real MessagePortMain can be closed out from under either one -- stop()
  // races a message still queued behind it -- and this is a teardown path
  // with nowhere further to report a throw to.
  function send (message: Parameters<PortLike['postMessage']>[0]): void {
    try {
      port.postMessage(message)
    } catch (caught) {
      console.error('[broker] posting to a socket\'s port failed', caught)
    }
  }

  const pump = createPortPump({
    handleId: socket.id,
    readable: socket.readable,
    send,
    initialCredit: readWindowBytes,
    mapError: mapSocketError,
    // A socket that dies underneath us releases nothing on its own:
    // socket.closed never settles otherwise, so the handler below never
    // runs and the handle stays counted against LIMITS.concurrentSockets
    // forever. See ./ipc.ts's own prior comment on this exact point --
    // moved here with the pump it describes.
    onStreamFailed: failSocket
  })

  const sink = createPortSink({
    handleId: socket.id,
    writable: socket.writable,
    send,
    windowBytes: writeWindowBytes,
    mapError: mapSocketError,
    // Symmetric with the pump's onStreamFailed: a write-window violation or
    // a real write failure is this direction's own "died underneath us",
    // and must fail the SAME handle the read side would -- freeing the
    // registry slot this file just claimed, not merely notifying the page.
    onSinkFailed: failSocket,
    // Distinct from onSinkFailed above: the app CHOSE to discard a still-live
    // connection, so this must reach the ACTIVE-reset path (HandleTable.abort),
    // not the "already dead, touch nothing" one onSinkFailed's 'failed' means.
    onAbort: abortSocket
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

  function stop (code?: OrivonErrorCode): void {
    pump.stop(code)
    sink.stop(code)
    cleanup()
  }

  // A renderer navigating away or explicitly closing its side of the port
  // triggers this without ever calling net.close. socket.closed settling is
  // otherwise the only release trigger, and it never happens on its own for
  // an idle, healthy, established socket -- without this, an abandoned
  // renderer's registry slot, pump reader and sink heartbeat timer would
  // all live for the process's lifetime (T11b).
  port.onClose(() => { stop() })

  // Teardown ahead of `socket.closed`, but ONLY for a reason that destroys the
  // socket anyway. HandleTable unlinks a handle synchronously and only then
  // awaits its destroy, which a peer that stops reading can stall forever --
  // leaving the registry slot, the pump and the sink live with nothing able to
  // reach them (open-questions.md A84). Acting at unlink is what shuts that,
  // and with it A70's window: net.close/setNoDelay/setKeepAlive resolve through
  // the registry entry `cleanup()` releases.
  //
  // THE BRANCH IS LOAD-BEARING, and it is here because the version without it
  // was measured and found to lose data. `stop()` calls `pump.stop()`, which
  // cancels the reader -- and cancelling the readable half of a Duplex.toWeb
  // DESTROYS the whole socket, discarding anything still in its write queue.
  // On a flushing reason ('closed'/'sessionEnded', where destroy calls
  // `socket.end()`) that truncates the app's own final bytes: 8 MiB queued,
  // 8 MiB lost, against a real socket. Those reasons are left to settle
  // through `closed` below, which the drain deadline in node-adapters.ts now
  // guarantees always happens -- later than unlink, but without truncating.
  // 'revoked'/'aborted'/'failed' destroy the socket regardless, so there is
  // nothing to preserve and immediate teardown is the whole point.
  socket.onUnlink((reason, code) => {
    if (reason === 'closed' || reason === 'sessionEnded') return
    stop(code)
  })

  // The .catch is not decoration -- this chain is nobody's awaited promise,
  // so anything these handlers throw becomes an unhandled rejection, and
  // Node's default for those since v15 is to THROW, taking the whole
  // Electron main process down from a socket-teardown path.
  socket.closed.then(
    () => { stop() },
    (error: unknown) => { stop(isOrivonErrorLike(error) ? error.code : 'internal') }
  ).catch((error: unknown) => {
    console.error('[broker] releasing a socket failed after it closed', error)
  })

  return { cleanup, stop }
}
