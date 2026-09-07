import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { FailableUdpSocket } from '../handles/handle-contracts.js'
import type { PortLike, RegisteredSocket } from './port-transport.js'
import type { PortRegistry } from './port-registry.js'
import { createDatagramPump } from './datagram-pump.js'
import { createDatagramSink } from './datagram-sink.js'
import { mapSocketError } from './socket-relay.js'
import { parseRendererToBrokerMessage } from './port-messages.js'
import { isOrivonErrorLike } from '../errors.js'

// Everything mechanical about relaying ONE UDP socket's datagrams over its
// dedicated port -- ./socket-relay.ts's counterpart, and structured the same
// way so the two read alike.
//
// ONE REAL DIFFERENCE, AND IT IS A SIMPLIFICATION: this tears down on EVERY
// close reason, where the TCP relay branches. See ../README.md, Design notes.

export interface DatagramRelayOptions {
  readonly origin: string
  readonly socket: FailableUdpSocket
  readonly port: PortLike
  /** `net.close`'s own lookup table (./ipc.ts) -- registered here, released on cleanup. */
  readonly registry: PortRegistry<RegisteredSocket>
  /** LIMITS.inboundDatagramWindow in production. */
  readonly inboundWindow: number
  /** LIMITS.inboundDatagramWindowBytes in production. */
  readonly inboundWindowBytes: number
  /** LIMITS.outboundDatagramWindow in production. */
  readonly outboundWindow: number
}

export interface DatagramRelay {
  /** Unregisters the socket and closes the port. Idempotent. */
  readonly cleanup: () => void
  /** Stops both directions, then cleans up. Idempotent. */
  readonly stop: (code?: OrivonErrorCode) => void
}

export function createDatagramRelay (options: DatagramRelayOptions): DatagramRelay {
  const { origin, socket, port, registry, inboundWindow, inboundWindowBytes, outboundWindow } = options

  registry.register(origin, socket.id, { kind: 'udp', close: socket.close })

  let released = false
  function cleanup (): void {
    if (released) return
    released = true
    registry.remove(origin, socket.id)
    port.close()
  }

  // Same guards, and the same reasons, as ./socket-relay.ts's: both are
  // reached synchronously from port.onMessage or a teardown path, and an
  // uncaught throw on the Electron main process takes the whole browser down.
  function failSocket (code: OrivonErrorCode, error: unknown): void {
    try {
      socket.fail(code, isOrivonErrorLike(error) ? error.platformCode : undefined)
    } catch (caught) {
      console.error('[broker] failing a udp handle threw', caught)
    }
  }

  function send (message: Parameters<PortLike['postMessage']>[0]): void {
    try {
      port.postMessage(message)
    } catch (caught) {
      console.error('[broker] posting to a udp socket\'s port failed', caught)
    }
  }

  const pump = createDatagramPump({
    handleId: socket.id,
    readable: socket.readable,
    send,
    initialCredit: inboundWindow,
    initialCreditBytes: inboundWindowBytes,
    droppedInbound: () => socket.droppedInbound,
    mapError: mapSocketError,
    onStreamFailed: failSocket
  })

  const sink = createDatagramSink({
    handleId: socket.id,
    send,
    sendDatagram: socket.send,
    windowDatagrams: outboundWindow,
    // A refused DATAGRAM never reaches here (A87) -- only a renderer ignoring
    // its window does, and that is this direction's "died underneath us".
    onSinkFailed: failSocket
  })

  port.onMessage((raw) => {
    const message = parseRendererToBrokerMessage(raw)
    if (message === undefined) return
    switch (message.kind) {
      case 'datagram-credit': pump.handleCredit(message); break
      case 'send': sink.handleSend(message); break
      // A byte-path message on a datagram port is a renderer confusing its own
      // handles. Ignored rather than fatal, matching this file's stance that
      // an unrecognised message is dropped: there is no socket state it could
      // have corrupted, because nothing here would act on it.
      default: break
    }
  })

  function stop (code?: OrivonErrorCode): void {
    pump.stop(code)
    sink.stop()
    cleanup()
  }

  port.onClose(() => { stop() })

  // UNCONDITIONAL, unlike ./socket-relay.ts's, and that asymmetry is the point
  // rather than an oversight: the TCP relay must not act at unlink on a
  // FLUSHING reason, because cancelling a Duplex.toWeb's read half destroys
  // the socket and drops its write queue (8 MiB measured lost). A UDP socket
  // has no write queue -- a datagram is handed to the OS or refused, never
  // buffered for later -- so there is nothing a teardown here can truncate.
  socket.onUnlink((_reason, code) => { stop(code) })

  socket.closed.then(
    () => { stop() },
    (error: unknown) => { stop(isOrivonErrorLike(error) ? error.code : 'internal') }
  ).catch((error: unknown) => {
    console.error('[broker] releasing a udp socket failed after it closed', error)
  })

  return { cleanup, stop }
}
