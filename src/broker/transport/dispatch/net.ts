// net.connect / connectSecure / udpBind / listen / close / setNoDelay /
// setKeepAlive, split out of ../ipc.ts's dispatch() switch under
// code-guidelines.md Rule 2 -- see ./app.ts's header for the seam
// this and its siblings share. Also owns deliverTcpSocket, the byte-pump
// wiring net.connect and net.connectSecure share (code-guidelines.md Rule
// 3): only they need it. net.listen's own delivery helper, deliverTcpServer,
// lives in ../relay/server.ts beside the relay it wires rather than here --
// see that file's own doc for why.

import { fail } from '../../errors.js'
import type { Broker, FailableSecureTcpSocket } from '../../broker-contracts.js'
import type { FailableTcpSocket } from '../../handles/handle-contracts.js'
import type { SecureHandshake } from '../../../contracts/index.js'
import { parseSecureConnectParams } from '../secure-connect-params.js'
import { createSocketRelay } from '../relay/socket.js'
import { createDatagramRelay } from '../relay/datagram.js'
import { deliverPort } from '../relay/deliver-port.js'
import { deliverTcpServer } from '../relay/server.js'
import {
  isNetCloseParams, isNetConnectParams, isNetLookupParams, isNetSetKeepAliveParams, isNetSetNoDelayParams,
  isNetUdpBindParams
} from '../ipc-validation.js'
import type { ControlMethod } from '../ipc-validation.js'
import type { ControlEvent, PortTransport, SocketDescriptor, UdpSocketDescriptor } from '../relay/port-transport.js'
import { LIMITS } from '../../../contracts/index.js'

/** The `net.*` slice of `ControlMethod` -- see ./app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type NetControlMethod = Extract<ControlMethod, `net.${string}`>

/**
 * Everything net.connect and net.connectSecure share once the broker has
 * already handed back an acquired `FailableTcpSocket`: mint a port pair,
 * wire the byte-pump relay, deliver the port to the calling frame (or
 * abandon and release the handle if that fails), and return the plain
 * descriptor. The two control methods differ only in WHICH broker method
 * produced `socket` and which grant authorised it -- both dead ends by the
 * time this runs -- so this is one implementation of "wire an acquired TCP
 * socket to the renderer", not two copies drifting apart
 * (code-guidelines.md Rule 3).
 */
async function deliverTcpSocket (
  origin: string,
  socket: FailableTcpSocket,
  event: ControlEvent,
  transport: PortTransport
): Promise<SocketDescriptor> {
  const pair = transport.createPortPair()
  // Owns everything mechanical about relaying this socket's bytes in
  // both directions, registering it for net.close, and releasing it
  // exactly once -- see ../relay/socket.ts. What stays here is only
  // what is security-relevant: the transport check above, the origin
  // re-derivation below, and the port delivery itself.
  const relay = createSocketRelay({
    origin,
    socket,
    port: pair.port1,
    registry: transport.registry,
    readWindowBytes: LIMITS.readWindowBytes,
    writeWindowBytes: LIMITS.writeWindowBytes
  })

  // If the port never reaches the frame, the app never learns this
  // socket's id -- the descriptor below is not returned -- so it can
  // never call net.close for it either. Releasing it here is the only
  // remaining chance: handle-contracts.ts's destroy rule is that a
  // resource is released exactly once, ALWAYS, "including when the
  // acquisition that would have registered the handle is itself
  // refused... otherwise one fd leaks per attempt against a limit an
  // attacker can hit in a loop". A frame that navigated or was disposed
  // between this request and this line is ordinary, not adversarial.
  const abandon = async (reason: string): Promise<never> => {
    // stop(), not a bare cleanup(): cleanup() alone unregisters and closes
    // the port but leaves the pump free to still be mid-pumpLoop, reading
    // the OS socket and posting to a port that was just closed.
    relay.stop('internal')
    try {
      await socket.close()
    } catch {
      // The handle table is the owner of record and has already been told
      // to release; a failure here leaves nothing further to do.
    }
    throw fail('internal', reason)
  }

  await deliverPort({
    origin,
    handleId: socket.id,
    frame: event.senderFrame,
    port2: pair.port2,
    abandon
  })

  return {
    id: socket.id,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort
  }
}

/** Just the handshake facts, picked rather than spread: the socket also carries streams and functions, which cannot clone. */
function handshakeOf (socket: FailableSecureTcpSocket): SecureHandshake {
  const { authorized, authorizationError, alpnProtocol, peerCertificate } = socket
  return authorizationError === undefined
    ? { authorized, alpnProtocol, peerCertificate }
    : { authorized, authorizationError, alpnProtocol, peerCertificate }
}

/** `net.*`'s dispatch cases, unchanged from ../ipc.ts's own switch. */
export async function dispatchNet (
  broker: Broker,
  origin: string,
  method: NetControlMethod,
  payload: unknown,
  event: ControlEvent,
  transport: PortTransport | undefined
): Promise<unknown> {
  switch (method) {
    case 'net.connect': {
      if (!isNetConnectParams(payload)) throw fail('invalid', 'net.connect requires { host: string, port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.connect(origin, { host: payload.host, port: payload.port })
      return await deliverTcpSocket(origin, socket, event, transport)
    }
    // A SIBLING of net.connect above, not a variant: the payload's TLS
    // options (../secure-connect-params.ts) and the broker method (checked
    // against the separate https.connect grant and dialled via node:tls --
    // ../../capabilities/net-connect-secure.ts) differ. Everything past that call -- the
    // port pair, the byte-pump relay, the port delivery -- is
    // deliverTcpSocket, unchanged; the reply adds the handshake facts.
    case 'net.connectSecure': {
      const parsed = parseSecureConnectParams(payload)
      if (!parsed.ok) throw fail('invalid', `net.connectSecure: ${parsed.problem}`)
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.connectSecure(origin, parsed.params)
      const descriptor = await deliverTcpSocket(origin, socket, event, transport)
      return { ...descriptor, tls: handshakeOf(socket) }
    }
    case 'net.udpBind': {
      if (!isNetUdpBindParams(payload)) throw fail('invalid', 'net.udpBind requires { port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const socket = await broker.net.udpBind(origin, { port: payload.port })

      const pair = transport.createPortPair()
      const relay = createDatagramRelay({
        origin,
        socket,
        port: pair.port1,
        registry: transport.registry,
        inboundWindow: LIMITS.inboundDatagramWindow,
        inboundWindowBytes: LIMITS.inboundDatagramWindowBytes,
        outboundWindow: LIMITS.outboundDatagramWindow
      })

      const abandon = async (reason: string): Promise<never> => {
        relay.stop('internal')
        try {
          await socket.close()
        } catch {
          // As net.connect's: the handle table already owns the release.
        }
        throw fail('internal', reason)
      }

      await deliverPort({
        origin,
        handleId: socket.id,
        frame: event.senderFrame,
        port2: pair.port2,
        abandon
      })

      const descriptor: UdpSocketDescriptor = {
        id: socket.id,
        localAddress: socket.localAddress,
        localPort: socket.localPort
      }
      return descriptor
    }
    // A114/d-0028: the server's own port is delivered the same way a
    // net.connect socket's is (deliverTcpServer, ../relay/server.ts); each
    // connection it later accepts arrives over THAT port as an
    // AcceptedMessage, not through another control-channel round trip --
    // see ../relay/server.ts's own header for the shape this reuses.
    case 'net.listen': {
      if (!isNetUdpBindParams(payload)) throw fail('invalid', 'net.listen requires { port: number }')
      if (transport === undefined) throw fail('internal', 'no port transport configured for this broker')
      const server = await broker.net.listen(origin, { port: payload.port })
      return await deliverTcpServer(origin, server, event, transport)
    }
    case 'net.close': {
      if (!isNetCloseParams(payload)) throw fail('invalid', 'net.close requires { id: string }')
      // Idempotent, silent no-op for an id this origin was never handed --
      // matching TcpSocket.close()'s own contract (handle-contracts.md's
      // "Common shape" section) -- rather than distinguishing "wrong origin"
      // from "already gone", either of which would let an app probe for
      // handles it does not hold. Covers a server's own id too: RegisteredSocket's
      // `kind: 'server'` entry (../relay/port-transport.ts) answers `close` the same way.
      const entry = transport?.registry.get(origin, payload.id)
      if (entry !== undefined) await entry.close()
      return undefined
    }
    case 'net.setNoDelay': {
      if (!isNetSetNoDelayParams(payload)) throw fail('invalid', 'net.setNoDelay requires { id: string, on: boolean }')
      // Same T11c ownership check and same silent-no-op contract as
      // net.close above, over the same registry -- a handle id from one
      // origin means nothing presented by another.
      const entry = transport?.registry.get(origin, payload.id)
      // 'invalid', not the silent no-op an unknown id gets: the app HOLDS this
      // handle, so calling a TCP-only option on it is its own bug rather than
      // a probe for handles it does not have, and telling it so leaks nothing.
      if (entry?.kind === 'udp') throw fail('invalid', 'setNoDelay is not available on a UDP socket')
      if (entry?.kind === 'server') throw fail('invalid', 'setNoDelay is not available on a TCP server')
      if (entry !== undefined) await entry.setNoDelay(payload.on)
      return undefined
    }
    case 'net.setKeepAlive': {
      if (!isNetSetKeepAliveParams(payload)) throw fail('invalid', 'net.setKeepAlive requires { id: string, on: boolean }')
      const entry = transport?.registry.get(origin, payload.id)
      if (entry?.kind === 'udp') throw fail('invalid', 'setKeepAlive is not available on a UDP socket')
      if (entry?.kind === 'server') throw fail('invalid', 'setKeepAlive is not available on a TCP server')
      if (entry !== undefined) await entry.setKeepAlive(payload.on, payload.initialDelayMs)
      return undefined
    }
    // No port pair, no handle registration -- unlike every other case here,
    // `broker.net.lookup` (d-0030) resolves once and hands back plain data,
    // never a live resource (capabilities/net.ts's own `lookup` doc). The
    // CONTROL_CHANNEL round trip alone is the whole delivery.
    case 'net.lookup': {
      if (!isNetLookupParams(payload)) throw fail('invalid', 'net.lookup requires { hostname: string }')
      return await broker.net.lookup(origin, { hostname: payload.hostname })
    }
    default: {
      // Exhaustiveness check, same reasoning as ../ipc.ts's own dispatch():
      // if NetControlMethod ever gains a member no case above names, this
      // line fails to compile instead of silently resolving to `undefined`.
      const unrouted: never = method
      throw fail('internal', `unrouted net control method: ${unrouted as string}`)
    }
  }
}
