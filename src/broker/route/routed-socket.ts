// A socket a route opened, in the shape the broker hands an app. The streams
// and the close table are the adapters' own, so a routed socket closes exactly
// as a direct one does.

import type { Socket } from 'node:net'
import { destroySocket } from '../adapters/node-adapters.js'
import { socketReadable, socketWritable } from '../adapters/socket-streams.js'
import type { DialedSocket } from '../broker-contracts.js'
import { fail } from '../errors.js'
import type { Route } from './provider.js'
import { mapRouteError } from './provider.js'

/**
 * Opens a stream to `host`:`port` through `route` and wraps it.
 *
 * The addresses it reports are the destination the app named, never the
 * proxy's: what the app sees is the route's far end, and a local address would
 * only show where the proxy listens. Every failure is `unreachable` or, for an
 * aborted call, `revoked`.
 */
export async function dialThroughRoute (route: Route, host: string, port: number, signal: AbortSignal): Promise<DialedSocket> {
  let socket: Socket
  try {
    socket = await route.provider.connect(host, port, signal)
  } catch (error) {
    throw signal.aborted ? fail('revoked', 'the connection was abandoned') : mapRouteError(error)
  }
  return wrapRouted(socket, host, port)
}

export function wrapRouted (socket: Socket, host: string, port: number): DialedSocket {
  return {
    readable: socketReadable(socket),
    writable: socketWritable(socket),
    remoteAddress: host,
    remotePort: port,
    localAddress: '',
    localPort: 0,
    setNoDelay: async (on) => { socket.setNoDelay(on) },
    setKeepAlive: async (on, initialDelayMs) => { socket.setKeepAlive(on, initialDelayMs) },
    destroy: async (reason) => { await destroySocket(socket, reason) }
  }
}
