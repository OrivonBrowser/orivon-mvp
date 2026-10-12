// `connectSecure` over a route: the route carries the bytes, and the TLS
// handshake, certificate verification and SNI are the same ones a direct
// dial runs (../adapters/tls-adapter.ts), against the name the app asked for.

import type { Socket } from 'node:net'
import { connectOptionsFor, dialOneSecure } from '../adapters/tls-adapter.js'
import type { DialedSecureSocket, SecureDialOptions } from '../broker-contracts.js'
import { fail } from '../errors.js'
import { mapRouteError } from './provider.js'
import type { Route } from './provider.js'

export async function dialSecureThroughRoute (
  route: Route,
  target: { readonly host: string, readonly port: number },
  options: SecureDialOptions,
  signal: AbortSignal
): Promise<DialedSecureSocket> {
  let carrier: Socket
  try {
    carrier = await route.provider.connect(target.host, target.port, signal)
  } catch (error) {
    throw signal.aborted ? fail('revoked', 'the connection was abandoned') : mapRouteError(error)
  }
  try {
    const dialed = await dialOneSecure({ ...connectOptionsFor(target.host, target, options, {}), socket: carrier }, signal)
    // What the app sees is the far end it named, never the proxy's address.
    return { ...dialed, remoteAddress: target.host, remotePort: target.port, localAddress: '', localPort: 0 }
  } catch (error) {
    carrier.destroy()
    throw error
  }
}
