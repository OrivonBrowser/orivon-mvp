// What a network route has to offer the broker, and nothing about how it is
// carried. Any proxy that can open a TCP stream to host:port can be one; UDP
// and name resolution are optional, and a missing one is refused, never
// replaced by a direct call. README.md says what this directory may import.

import type { Socket } from 'node:net'
import type { LookupAddress, OrivonError } from '../../contracts/index.js'
import { errnoOf, fail } from '../errors.js'
import { isOrivonError } from '../io-errors.js'

/** One datagram carried by a route. `host` is whatever the app named, an address literal or a name, never resolved on this machine. */
export interface RoutedDatagram {
  readonly host: string
  readonly port: number
  readonly data: Uint8Array
}

/** A datagram channel through the route. Close it and the route's relay is released. */
export interface RoutedUdp {
  send: (datagram: RoutedDatagram) => Promise<void>
  /** Called with every datagram that arrives from the route, and from nothing else. */
  onDatagram: (listener: (datagram: RoutedDatagram) => void) => void
  /** Called once when the channel ends, whoever ended it. */
  onClose: (listener: () => void) => void
  close: () => Promise<void>
}

export interface RouteProvider {
  /**
   * Opens a TCP stream to `host`:`port` and resolves once it is established.
   * `host` is passed as the app named it, a name or an address literal: a
   * provider that resolves names does so on its side. `signal` aborts a
   * connect still in flight. A `Socket`, not a bare duplex, because the
   * broker's stream wrappers and the TLS layer are written against one.
   */
  connect: (host: string, port: number, signal: AbortSignal) => Promise<Socket>
  /** Absent when the route cannot carry UDP. */
  udp?: (signal: AbortSignal) => Promise<RoutedUdp>
  /** Absent when the route cannot resolve names. */
  resolve?: (host: string, signal: AbortSignal) => Promise<readonly LookupAddress[]>
}

/** What the broker asks of a route, for one caller. */
export interface Route {
  readonly provider: RouteProvider
}

/** The route in force for an origin key, or undefined for an app that has none. */
export type RouteFor = (key: string) => Route | undefined

/** The part of `CreateBrokerOptions` that carries routes. */
export interface RouteBrokerOptions {
  /**
   * Read on every call, so a change applies to the next one. A routed app's `orivon.net` goes through
   * its route and nothing else: no local DNS, no direct dial, no T20 check, because the route is its
   * proxy. Omitted, no app is routed.
   */
  readonly routeFor?: RouteFor
}

/**
 * A failure inside a route as the app sees it: `unreachable`. An error the
 * broker already shaped, such as the one an aborted call carries, passes
 * through. The message is fixed so nothing about the proxy reaches the page.
 */
export function mapRouteError (error: unknown): OrivonError {
  if (isOrivonError(error)) return error
  return fail('unreachable', 'the route could not carry the connection', undefined, errnoOf(error))
}
