// `orivon.net.connectSecure` (ADR-0017), split out of ./net.ts
// along Rule 2's seam: a SIBLING of `connect`, not a variant of it -- checked
// against `https.connect`, a SEPARATE grant from `tcp.connect`, and dialled
// through `deps.dialSecure` (../adapters/tls-adapter.ts). Takes the broker's
// own state, like ./net.ts, and holds none. README.md's Design
// notes say why an unbound handshake is address-checked.

import type { SecureConnectOptions, Pattern } from '../../contracts/index.js'
import type { HandleTable } from '../handles/handles.js'
import type { FailableTcpSocket, HandleEntry } from '../handles/handle-contracts.js'
import type { GrantLedger } from '../grants/grant-ledger.js'
import type {
  CreateBrokerOptions, DialedSecureSocket, DialedSocket, FailableSecureTcpSocket, SecureDialOptions, SecureDialTarget
} from '../broker-contracts.js'
import { fail } from '../errors.js'
import { mapTlsError } from '../io-errors.js'
import { assertSocketRoom } from './socket-room.js'
import { checkConnect, connectStillAuthorised } from '../policy/connect.js'
import type { Resolver } from '../policy/connect.js'
import { checkConnectSecure } from '../policy/connect-secure.js'
import { normalizeHost } from '../policy/canonical-host.js'
import { proxyProbeUrl } from '../policy/proxy-guard.js'
import { classifyAddress } from '../policy/address.js'
import { reachesOwnLoopbackPort } from '../policy/own-loopback.js'
import { NO_RESOLVER, isLoopbackTarget } from '../policy/connect-routed.js'
import { dialSecureThroughRoute } from '../route/routed-secure.js'

export interface ConnectSecureOptions {
  readonly deps: CreateBrokerOptions
  readonly handleTable: HandleTable
  readonly ledger: GrantLedger
  readonly canonical: (origin: string) => string
  readonly socketAllowance: (origin: string) => number
  /** ./net.ts's own wrapper, shared so both paths attach the same handle-table escape hatches (Rule 3). */
  readonly toFailableSocket: (key: string, entry: HandleEntry, socketFields: Omit<DialedSocket, 'destroy'>) => FailableTcpSocket
}

/**
 * Whether the handshake `options` ask for, on its own, binds `host` -- the
 * checked, normalised name -- to whoever answers: default verification,
 * against the runtime's built-in roots, of a certificate for `host` itself.
 *
 * NOT when verification is off, NOT when the app supplies its own `ca` (a
 * root it chose can vouch for any name), and NOT when `servername` makes the
 * certificate answer for some other name. Each of those is honoured, but the
 * name match alone no longer says where the socket goes, so the caller adds
 * `checkConnect`'s resolve-once address check (security-model.md T12).
 */
export function bindsGrantedName (host: string, options: SecureDialOptions): boolean {
  if (options.rejectUnauthorized === false || options.ca !== undefined) return false
  const { servername } = options
  return servername === undefined || servername === '' || normalizeHost(servername) === host
}

/** True when `host` is an address literal rather than a name. */
function isLiteral (host: string): boolean {
  return classifyAddress(host) !== 'unparseable'
}

export function createConnectSecure ({ deps, handleTable, ledger, canonical, socketAllowance, toFailableSocket }: ConnectSecureOptions): (origin: string, opts: SecureConnectOptions) => Promise<FailableSecureTcpSocket> {
  /** Resolve once, require every answer to pass the same grant, dial only what was checked -- `connect`'s own T12 rule, on top of the name match. */
  async function addressCheckedTarget (patterns: readonly Pattern[], host: string, port: number, resolve: Resolver = deps.resolve): Promise<SecureDialTarget> {
    const decision = await checkConnect(patterns, host, port, resolve)
    if (!decision.allowed) throw fail('denied', 'the secure connection was not authorised')
    return { host, port, addresses: decision.addresses }
  }

  /**
   * The handshake binds the granted name, so the answers are not address-checked: the name and the certificate are the
   * authorisation, and a public name may well resolve to a private address (split-horizon DNS). They are resolved HERE,
   * by the injected resolver, and dialled as addresses under the name (`servername` and the certificate identity stay the
   * name): handing the bare name to the TLS dial would have Node's system resolver look it up instead.
   */
  async function nameBoundTarget (host: string, port: number): Promise<SecureDialTarget> {
    if (isLiteral(host)) return { host, port }
    const addresses = await deps.resolve(host)
    if (addresses.length === 0) throw fail('unreachable', `could not resolve ${host}`)
    return { host, port, addresses }
  }

  return async function connectSecure (origin, opts) {
    const key = canonical(origin)
    const { host: hostArg, port, signal: abandon, ...options } = opts

    const current = ledger.currentGrant(key, 'https.connect')
    if (current === undefined) throw fail('denied', 'https.connect is not granted to this origin')

    // Read once per call: a route that changes later applies to the next one.
    // Only a peer other than this machine goes through it.
    const route = deps.routeFor?.(key)
    const viaRoute = route !== undefined && !isLoopbackTarget(hostArg)

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      let dialed: DialedSecureSocket
      let host: string
      let bound: boolean
      try {
        // The grant is checked against the NAME the app asked for, always --
        // never `servername`. An unbound handshake adds the address check on
        // top, so an option can only ever narrow what this reaches.
        const decision = checkConnectSecure(current.patterns, hostArg, port)
        if (!decision.allowed || reachesOwnLoopbackPort([decision.host], port, deps.ownLoopbackPort)) throw fail('denied', 'the secure connection was not authorised')
        host = decision.host
        bound = bindsGrantedName(host, options)
        if (viaRoute) {
          // A routed app: no T20 (the route is its proxy), and a name is never
          // resolved here. A literal the handshake does not bind to the name
          // still gets the address check, which needs no resolver for one; a
          // name that is not bound is the proxy's to resolve (policy/
          // connect-routed.ts).
          if (!bound && isLiteral(host)) await addressCheckedTarget(current.patterns, host, port)
          if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
          assertSocketRoom(handleTable, key, socketAllowance(key))
          dialed = await dialSecureThroughRoute(route, { host, port }, options, signal)
        } else {
          // Before ANY resolution or handshake attempt: both targets below
          // resolve `host` through `deps.resolve`, a lookup no configured
          // proxy ever sees (T20). A routed app reaching this machine is
          // checked without a resolver and dialled as literals.
          if (route === undefined) {
            const probeUrl = proxyProbeUrl(host, port)
            if (probeUrl === null) throw fail('denied', 'the connection was not authorised')
            if (await deps.proxyConfigured(probeUrl)) throw fail('denied', 'a system proxy is configured; connectSecure refuses to bypass it')
          }
          const target = bound && route === undefined ? await nameBoundTarget(host, port) : await addressCheckedTarget(current.patterns, host, port, route === undefined ? deps.resolve : NO_RESOLVER)
          // Without this, a grant revoked between the policy check and the
          // handshake completing would still let `deps.dialSecure` run to
          // completion for a capability the app no longer holds.
          if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
          assertSocketRoom(handleTable, key, socketAllowance(key))
          dialed = await deps.dialSecure(target, options, signal)
        }
      } catch (error) {
        // mapTlsError, NOT mapIoError: a failed handshake or a certificate/
        // hostname mismatch is 'unreachable' with a real platformCode, and
        // Node's TLS error codes are not POSIX errnos (io-errors.ts). An
        // OrivonError thrown above passes through unchanged.
        throw mapTlsError(error)
      }

      if (signal.aborted) {
        // `acquire` would refuse this, but its cleanup releases with
        // 'failed' -- silent, and wrong for a socket that is actually
        // connected and holding a live TLS session.
        await dialed.destroy('revoked')
        throw fail('revoked', 'the grant authorising this connection was withdrawn')
      }

      // No address was checked when the name binds the peer by itself (and no
      // route is in force), or when a route carries a name the proxy resolves.
      const addressUnchecked = (bound && route === undefined) || (viaRoute && (bound || !isLiteral(host)))
      const { destroy, authorized, authorizationError, alpnProtocol, peerCertificate, ...socketFields } = dialed
      const entry = handleTable.acquire({
        origin: key,
        kind: 'tcpSocket',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy,
        socketLimit: socketAllowance(key),
        stillCovered: (patterns) => checkConnectSecure(patterns, host, port).allowed &&
          (addressUnchecked || connectStillAuthorised(patterns, host, socketFields.remoteAddress, port))
      })

      const handshake = authorizationError === undefined
        ? { authorized, alpnProtocol, peerCertificate }
        : { authorized, authorizationError, alpnProtocol, peerCertificate }
      return { ...toFailableSocket(key, entry, socketFields), ...handshake }
    }, abandon)
  }
}
