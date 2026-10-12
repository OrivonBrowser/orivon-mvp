// `connectSecure` over a route: the route carries the bytes, and the TLS
// handshake, certificate verification and SNI are the same ones a direct
// dial runs (../adapters/tls-adapter.ts), against the name the app asked for.

import type { Socket } from 'node:net'
import { connectOptionsFor, dialOneSecure } from '../adapters/tls-adapter.js'
import type { DialedSecureSocket, SecureDialOptions } from '../broker-contracts.js'
import { fail } from '../errors.js'
import { withDeadline } from './deadline.js'
import { mapRouteError } from './provider.js'
import type { Route } from './provider.js'

export async function dialSecureThroughRoute (
  route: Route,
  target: { readonly host: string, readonly port: number },
  options: SecureDialOptions,
  signal: AbortSignal,
  deadlineMs?: number
): Promise<DialedSecureSocket> {
  // One deadline over the route's connect and the handshake together, as a direct dial has.
  return await withDeadline(signal, async (attempt) => {
    let carrier: Socket
    try {
      carrier = await route.provider.connect(target.host, target.port, attempt)
    } catch (error) {
      throw attempt.aborted ? fail('revoked', 'the connection was abandoned') : mapRouteError(error)
    }
    try {
      const dialed = await dialOneSecure({ ...connectOptionsFor(target.host, target, options, {}), socket: carrier }, attempt)
      // What the app sees is the far end it named, never the proxy's address.
      return { ...dialed, remoteAddress: target.host, remotePort: target.port, localAddress: '', localPort: 0 }
    } catch (error) {
      carrier.destroy()
      throw error
    }
  }, deadlineMs)
}
