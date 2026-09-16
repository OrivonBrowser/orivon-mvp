import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { AcceptedMessage, BrokerToRendererMessage } from '../../contracts/ipc.js'
import { LIMITS } from '../../contracts/index.js'
import type { FailableTcpServer } from '../handles/handle-contracts.js'
import type { ControlEvent, PortLike, PortTransport, TcpServerDescriptor } from './port-transport.js'
import { createAcceptPump } from './accept-pump.js'
import { createSocketRelay } from './socket-relay.js'
import { deliverPort } from './deliver-port.js'
import { parseRendererToBrokerMessage } from './port-messages.js'
import { fail, isOrivonErrorLike } from '../errors.js'

// Everything mechanical about relaying ONE TcpServer's accepted connections
// over its dedicated port -- ./socket-relay.ts's and ./datagram-relay.ts's
// counterpart for A114/d-0028's chosen delivery shape (contracts/ipc.ts's
// AcceptedMessage): each accepted socket gets its OWN fresh port pair, wired
// through the SAME createSocketRelay a dialled connection uses
// (code-guidelines.md Rule 3 -- an accepted socket and a dialled one are the
// same thing once accepted), delivered on the SERVER's port with `port`
// named in an explicit transfer list, exactly as AcceptedMessage's own doc
// (contracts/ipc.ts) requires.
//
// UNCONDITIONAL TEARDOWN ON UNLINK, matching ./datagram-relay.ts's asymmetry
// with ./socket-relay.ts, not ./socket-relay.ts's own conditional branch: a
// TcpServer has no write queue of its own to truncate
// (contracts/handles.ts's TcpServer has only `connections`, `localAddress`,
// `localPort`) -- the A84 hazard that branch exists for does not apply here.

export interface ServerRelayOptions {
  readonly origin: string
  readonly server: FailableTcpServer
  readonly port: PortLike
  readonly transport: PortTransport
  /** LIMITS.readWindowBytes in production -- passed straight through to each accepted connection's own createSocketRelay. */
  readonly readWindowBytes: number
  /** LIMITS.writeWindowBytes in production. */
  readonly writeWindowBytes: number
}

export interface ServerRelay {
  /** Unregisters the server and closes its port. Idempotent -- safe to call from both the abandon path and server.closed settling. */
  readonly cleanup: () => void
  /** Stops the accept pump, then cleans up. Idempotent. */
  readonly stop: (code?: OrivonErrorCode) => void
}

export function createServerRelay (options: ServerRelayOptions): ServerRelay {
  const { origin, server, port, transport, readWindowBytes, writeWindowBytes } = options

  transport.registry.register(origin, server.id, { kind: 'server', close: server.close })

  let released = false
  function cleanup (): void {
    if (released) return
    released = true
    transport.registry.remove(origin, server.id)
    port.close()
  }

  // Same tolerance, and the same reason, as ./socket-relay.ts's failSocket:
  // FailableTcpServer.fail promises it never throws, but its real
  // implementation (HandleTable.fail) can, and this is reached from a
  // teardown path with nowhere further to report a throw to.
  function failServer (code: OrivonErrorCode, error: unknown): void {
    try {
      server.fail(code, isOrivonErrorLike(error) ? error.platformCode : undefined)
    } catch (caught) {
      console.error('[broker] failing a server handle threw', caught)
    }
  }

  // Same guard as every other relay's own `send`: a real MessagePortMain can
  // be closed out from under this, and there is nowhere further to report a
  // throw to from a message-dispatch or teardown path.
  function send (message: BrokerToRendererMessage, transfer?: readonly unknown[]): void {
    try {
      port.postMessage(message, transfer)
    } catch (caught) {
      console.error('[broker] posting to a server\'s port failed', caught)
    }
  }

  const pump = createAcceptPump({
    handleId: server.id,
    connections: server.connections,
    maxOutstandingDemand: LIMITS.concurrentSockets,
    send,
    onStreamFailed: failServer,
    onAccepted (socket) {
      const pair = transport.createPortPair()
      // Reused unchanged (Rule 3): an accepted socket and a dialled one are
      // the same thing once accepted. This registers its OWN registry slot
      // under socket.id, independent of the server's -- net.close/
      // setNoDelay/setKeepAlive address it exactly like a net.connect
      // socket, because it is one.
      createSocketRelay({
        origin, socket, port: pair.port1, registry: transport.registry, readWindowBytes, writeWindowBytes
      })
      const accepted: AcceptedMessage = {
        kind: 'accepted',
        handleId: server.id,
        socketId: socket.id,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        // A167's own flagged narrowing, restated here where it is actually
        // hit: contracts/ipc.ts types `port` as the DOM `MessagePort` the
        // RENDERER receives, matching the type's own name
        // (BrokerToRendererMessage). This side holds the real
        // MessagePortMain that ./port-transport.ts's own PortPair.port2
        // already types as `unknown` for exactly this reason -- there is no
        // narrower type this file could give it without importing `electron`
        // into a structurally-typed module. See open-questions.md A167/A185.
        port: pair.port2 as MessagePort
      }
      send(accepted, [pair.port2])
    }
  })

  port.onMessage((raw) => {
    const message = parseRendererToBrokerMessage(raw)
    // Only 'credit' means anything on a server's own port -- reused here as
    // accept demand, not byte credit (./accept-pump.ts's own header). Every
    // other RendererToBrokerMessage kind is a renderer confusing its own
    // handles, matching ./datagram-relay.ts's stance toward a byte-path
    // message on a datagram port: dropped, not fatal, because there is no
    // server state it could act on.
    if (message?.kind === 'credit') pump.handleDemand(message)
  })

  function stop (code?: OrivonErrorCode): void {
    pump.stop(code)
    cleanup()
  }

  // A renderer navigating away or explicitly closing its side of the port
  // triggers this without ever calling net.close -- see ./socket-relay.ts's
  // own note; the same T11b reasoning applies to an abandoned server.
  port.onClose(() => { stop() })

  // UNCONDITIONAL, matching ./datagram-relay.ts's reasoning, not
  // ./socket-relay.ts's conditional one: see this file's own header.
  server.onUnlink((_reason, code) => { stop(code) })

  // The .catch is not decoration -- see ./socket-relay.ts's identical note:
  // this chain is nobody's awaited promise, and an unhandled rejection here
  // takes the whole Electron main process down.
  server.closed.then(
    () => { stop() },
    (error: unknown) => { stop(isOrivonErrorLike(error) ? error.code : 'internal') }
  ).catch((error: unknown) => {
    console.error('[broker] releasing a server failed after it closed', error)
  })

  return { cleanup, stop }
}

/**
 * Everything net.listen needs once the broker has handed back an acquired
 * FailableTcpServer: mint the server's own port pair, wire createServerRelay,
 * deliver the port to the calling frame (or abandon and release it if that
 * fails), and return the plain descriptor. Mirrors ./dispatch-net.ts's own
 * deliverTcpSocket (code-guidelines.md Rule 3 -- same idea, "wire an
 * acquired handle to the renderer") -- kept here, beside the relay it wires,
 * rather than in ./dispatch-net.ts, which only calls it.
 */
export async function deliverTcpServer (
  origin: string,
  server: FailableTcpServer,
  event: ControlEvent,
  transport: PortTransport
): Promise<TcpServerDescriptor> {
  const pair = transport.createPortPair()
  const relay = createServerRelay({
    origin,
    server,
    port: pair.port1,
    transport,
    readWindowBytes: LIMITS.readWindowBytes,
    writeWindowBytes: LIMITS.writeWindowBytes
  })

  // Same reasoning as deliverTcpSocket's own abandon: if the port never
  // reaches the frame, the app never learns this server's id and can never
  // call net.close for it either -- this is the last chance to release it.
  const abandon = async (reason: string): Promise<never> => {
    relay.stop('internal')
    try {
      await server.close()
    } catch {
      // The handle table is the owner of record and has already been told
      // to release; a failure here leaves nothing further to do.
    }
    throw fail('internal', reason)
  }

  await deliverPort({
    origin,
    handleId: server.id,
    frame: event.senderFrame,
    port2: pair.port2,
    abandon
  })

  return { id: server.id, localAddress: server.localAddress, localPort: server.localPort }
}
