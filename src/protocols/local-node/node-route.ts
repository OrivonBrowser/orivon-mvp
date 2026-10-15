// A local node's network when it runs through a tunnel: the same `NodeNetDeps` node-net.ts is built on, with every
// connection, datagram and name lookup going through a route (a SOCKS5 server) and none through this computer's own
// sockets or resolver. Only the API listener is left as it is, on loopback. README.md says what this does and does not
// carry; node-net.ts still decides which addresses may be reached.

import { isIP } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ConnectionOptions } from 'node:tls'
import { Agent, fetch as undiciFetch } from 'undici'
import type { Datagram, LookupAddress } from '../../contracts/index.js'
import type { Bind, BoundUdpSocket, Dial, SendOutcome } from '../../broker/broker-contracts.js'
import { dialThroughRoute } from '../../broker/route/routed-socket.js'
import { mapRouteError } from '../../broker/route/provider.js'
import type { RoutedUdp, RouteProvider } from '../../broker/route/provider.js'
import { fail } from '../../broker/errors.js'
import { LIMITS } from '../../contracts/index.js'
import { listenTcp } from '../../broker/adapters/node-adapters.js'
import { createNodeLookup } from './node-dns.js'
import type { WebFetch } from '../gateways/allowlisted-fetch.js'
import type { NodeNetDeps } from './node-net.js'

/** Where the route is now. Asked at every use, because the tunnel's process can restart on another port; it rejects when there is no route, and nothing then falls back to a direct socket. */
export type RouteSource = () => Promise<RouteProvider>

/** Connections being opened through the route at once; the rest wait. A mixnet tunnel that is handed hundreds of opens together stalls all of them. */
export const MAX_PENDING_DIALS = 16
/** One dial through a tunnel that is still coming up can take most of a minute. */
export const DIAL_DEADLINE_MS = 60_000
/** A DNS-over-HTTPS query through a mixnet: a TLS handshake takes several round trips of about a second each. */
export const ROUTED_QUERY_TIMEOUT_MS = 40_000
/** Datagrams the node has not read yet, per socket; past it they are dropped like any lost datagram. */
const INBOUND_QUEUE = 64

class Semaphore {
  #free: number
  readonly #waiting: Array<() => void> = []
  constructor (size: number) { this.#free = size }

  async take (signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw fail('revoked', 'the connection was abandoned')
    if (this.#free > 0) {
      this.#free -= 1
      return () => { this.#give() }
    }
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => { signal.removeEventListener('abort', onAbort); resolve() }
      const onAbort = (): void => {
        const at = this.#waiting.indexOf(wake)
        if (at >= 0) this.#waiting.splice(at, 1)
        reject(fail('revoked', 'the connection was abandoned'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#waiting.push(wake)
    })
    return () => { this.#give() }
  }

  #give (): void {
    const next = this.#waiting.shift()
    if (next === undefined) this.#free += 1
    else next()
  }
}

/** IPv4 first: the tunnel's exit may have no IPv6, and an address that cannot be reached costs a whole dial. */
function inOrder (addresses: readonly string[]): string[] {
  return [...addresses.filter((address) => isIP(address) === 4), ...addresses.filter((address) => isIP(address) !== 4)]
}

/** Writes one line of what the route did, for the node's log (`ORIVON_IPFS_NODE_LOG=1`); never a secret, only addresses, ports and times. */
export type Trace = (line: string) => void

export function routedDial (source: RouteSource, trace?: Trace): Dial {
  const pending = new Semaphore(MAX_PENDING_DIALS)
  return async (addresses, port, signal) => {
    const queued = Date.now()
    const release = await pending.take(signal)
    try {
      const provider = await source().catch((error: unknown) => { throw mapRouteError(error) })
      let last: unknown
      for (const address of inOrder(addresses)) {
        const began = Date.now()
        try {
          const dialed = await dialThroughRoute({ provider }, address, port, signal, DIAL_DEADLINE_MS)
          trace?.(`route dial ${address}:${String(port)} ok in ${String(Date.now() - began)} ms (waited ${String(began - queued)} ms)`)
          return dialed
        } catch (error) {
          last = error
          trace?.(`route dial ${address}:${String(port)} failed after ${String(Date.now() - began)} ms: ${(error as { code?: string }).code ?? 'error'}`)
          if (signal.aborted) break
        }
      }
      throw last ?? fail('unreachable', 'no address to dial')
    } finally {
      release()
    }
  }
}

let fakePort = 49_152

/** A datagram socket that is the route's channel and nothing else: no socket of this computer's is bound. */
export function routedBind (source: RouteSource, trace?: Trace): Bind {
  return async (_ranges, signal) => {
    let channel: RoutedUdp
    const began = Date.now()
    try {
      const provider = await source()
      if (provider.udp === undefined) throw fail('denied', 'this tunnel carries no datagrams')
      channel = await provider.udp(signal)
      trace?.(`route datagram channel open in ${String(Date.now() - began)} ms`)
    } catch (error) {
      trace?.(`route datagram channel refused after ${String(Date.now() - began)} ms`)
      throw mapRouteError(error)
    }
    let controller: ReadableStreamDefaultController<Datagram> | undefined
    let dropped = 0
    const readable = new ReadableStream<Datagram>({ start (c) { controller = c } }, { highWaterMark: INBOUND_QUEUE })
    channel.onDatagram((datagram) => {
      if (controller === undefined || controller.desiredSize === null || controller.desiredSize <= 0) { dropped += 1; return }
      try {
        controller.enqueue({ data: datagram.data, address: datagram.host, port: datagram.port, family: isIP(datagram.host) === 6 ? 'IPv6' : 'IPv4' })
      } catch {
        dropped += 1
      }
    })
    channel.onClose(() => { try { controller?.close() } catch { /* already closed */ } })
    fakePort = fakePort >= 65_000 ? 49_152 : fakePort + 1
    const bound: BoundUdpSocket = {
      readable,
      send: async (datagram): Promise<SendOutcome> => {
        if (datagram.data.byteLength > LIMITS.maxDatagramBytes) return { sent: false, code: 'invalid' }
        try {
          await channel.send({ host: datagram.address, port: datagram.port, data: datagram.data })
          return { sent: true }
        } catch (error) {
          const mapped = mapRouteError(error)
          return { sent: false, code: mapped.code }
        }
      },
      localAddress: '127.0.0.1',
      localPort: fakePort,
      get droppedInbound () { return dropped },
      destroy: async () => { await channel.close() }
    }
    return bound
  }
}

/**
 * HTTPS through the route, for the node's DNS-over-HTTPS lookups: the connection is a `CONNECT` through the tunnel to the
 * endpoint's name (the tunnel's side resolves it), and the certificate is checked for that name. Connections are kept, so the
 * handshake's round trips are paid once.
 */
export function routedFetch (source: RouteSource, tls: ConnectionOptions = {}): WebFetch {
  const agent = new Agent({
    connections: 2,
    keepAliveTimeout: 60_000,
    connect: (options, callback) => {
      const host = (options as { hostname?: string }).hostname ?? ''
      const port = Number((options as { port?: string | number }).port) || 443
      source().then(async (provider) => await provider.connect(host, port, AbortSignal.timeout(DIAL_DEADLINE_MS))).then((carrier) => {
        const secure = tlsConnect({ ...tls, socket: carrier, servername: host, ALPNProtocols: ['http/1.1'] })
        secure.once('secureConnect', () => { callback(null, secure) })
        secure.once('error', (error) => { carrier.destroy(); callback(error, null) })
      }, (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error)), null) })
    }
  })
  return async (url, init) => await (undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>)
}

/** Everything a node reaches, through `source`. The API listener stays on loopback; there is no system resolver. `tls` adds trust for a test's certificate. */
export function createRoutedNetDeps (source: RouteSource, dohEndpoints: readonly string[], tls?: ConnectionOptions, trace?: Trace): NodeNetDeps {
  const names = createNodeLookup({ endpoints: dohEndpoints, fetch: routedFetch(source, tls), queryTimeoutMs: ROUTED_QUERY_TIMEOUT_MS })
  return {
    dial: routedDial(source, trace),
    listen: listenTcp,
    bind: routedBind(source, trace),
    lookup: async (hostname): Promise<readonly LookupAddress[]> => {
      const began = Date.now()
      try {
        const found = await names(hostname)
        trace?.(`route lookup ${hostname} -> ${String(found.length)} addresses in ${String(Date.now() - began)} ms`)
        return found
      } catch (error) {
        trace?.(`route lookup ${hostname} failed after ${String(Date.now() - began)} ms`)
        throw mapRouteError(error)
      }
    }
  }
}
