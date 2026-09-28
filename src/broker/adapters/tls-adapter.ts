// `DialSecure` over real TLS -- the ADR-0017 sibling of ./node-adapters.ts's
// dialTcp, in its own file for the same reason ./udp-adapter.ts is: little
// shared beyond wrapping a Node socket. `node:tls`'s `TLSSocket` IS a
// `net.Socket` (Node's own inheritance, not an assumption made here), so
// `destroySocket` -- the CloseReason table `dialOne` already uses -- applies
// unchanged (Rule 3).
//
// NO `electron` IMPORT, matching ./node-adapters.ts's own rule: everything
// below is testable against a real local TLS server and a real, freshly
// generated certificate, with no Electron and no mocking of the handshake
// itself -- a mocked TLS layer would prove nothing about certificate
// verification, which is the whole security property ADR-0017 rests on.

import { checkServerIdentity, connect as tlsConnect } from 'node:tls'
import type { ConnectionOptions, PeerCertificate as NodePeerCertificate, TLSSocket } from 'node:tls'
import { isIP } from 'node:net'
import { Duplex } from 'node:stream'
import type { SecureHandshake } from '../../contracts/index.js'
import type { DialedSecureSocket, DialSecure, SecureDialOptions, SecureDialTarget } from '../broker-contracts.js'
import { DIAL_TIMEOUT_MS, destroySocket } from './node-adapters.js'
import { errnoOf, fail } from '../errors.js'
import { toPeerCertificate } from './tls-peer-certificate.js'

/**
 * The roots a dial trusts when the call supplies no `ca` of its own.
 * **Supplying either REPLACES the runtime's built-in root store; it does not
 * add to it** -- measured, not assumed: a real public host that handshakes
 * fine with no `ca` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` the moment
 * an unrelated CA is passed.
 *
 * A TESTING SEAM ONLY. The production `dialTls` below passes none, so it
 * trusts the runtime's own store unless an app's call names its own `ca`
 * (`SecureDialOptions`, which ../capabilities/net-connect-secure.ts treats as removing
 * the certificate's binding of the granted name). Only a test constructing
 * its own dialer can set this, to exercise the default path against a
 * throwaway CA: there is no other way to hand a local test server a
 * certificate a trusted root actually signed.
 */
export interface DialTlsOptions {
  // Matches node:tls's own `SecureContextOptions.ca` shape exactly (a plain,
  // mutable array, not a readonly one) -- widening it here would only make
  // TypeScript reject the object literal handed to `tls.connect` below.
  readonly ca?: string | Buffer | Array<string | Buffer>
}

/**
 * The `tls.connect` options for dialling `address` on `target`'s behalf.
 *
 * `servername` MUST be passed explicitly for a hostname, and omitting it does
 * not merely lose a nicety -- it breaks the handshake against most of the
 * public web. `tls.connect` does NOT default it from `host` in this object
 * form, so no SNI extension is sent, and a name-based virtual host answers
 * with whatever default certificate it keeps for clients that send none
 * (real Google answers a self-signed `CN = invalid2.invalid`). A local
 * single-certificate server cannot catch its absence; only a multi-tenant
 * host distinguishes the two. An IP literal gets none: SNI's grammar has no
 * place for one.
 *
 * `checkServerIdentity` is Node's own function, bound to the name the
 * certificate must carry, because Node's default would verify against
 * `servername || host` -- and `host` here may be a checked address literal
 * rather than the name, or `servername` an empty string meaning "no SNI".
 */
function connectOptionsFor (address: string, target: SecureDialTarget, options: SecureDialOptions, base: DialTlsOptions): ConnectionOptions {
  const identity = options.servername === undefined || options.servername === '' ? target.host : options.servername
  const sni = options.servername ?? (isIP(target.host) === 0 ? target.host : '')
  const ca = options.ca === undefined ? base.ca : typeof options.ca === 'string' ? options.ca : [...options.ca]
  return {
    host: address,
    port: target.port,
    ...(sni === '' ? {} : { servername: sni }),
    ...(ca === undefined ? {} : { ca }),
    ...(options.cert === undefined ? {} : { cert: options.cert }),
    ...(options.key === undefined ? {} : { key: options.key }),
    ...(options.pfx === undefined ? {} : { pfx: Buffer.from(options.pfx.buffer, options.pfx.byteOffset, options.pfx.byteLength) }),
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    ...(options.alpnProtocols === undefined ? {} : { ALPNProtocols: [...options.alpnProtocols] }),
    rejectUnauthorized: options.rejectUnauthorized !== false,
    checkServerIdentity: (_hostname: string, cert: NodePeerCertificate) => checkServerIdentity(identity, cert)
  }
}

/** Node types `authorizationError` as an Error; at runtime it is the verification error's code string (`_tls_wrap.js`'s onConnectSecure). */
function authorizationErrorOf (socket: TLSSocket): string | undefined {
  if (socket.authorized) return undefined
  const raw: unknown = socket.authorizationError
  if (typeof raw === 'string') return raw
  return errnoOf(raw) ?? (raw instanceof Error ? raw.message : undefined)
}

function handshakeOf (socket: TLSSocket): SecureHandshake {
  const authorizationError = authorizationErrorOf(socket)
  const facts = {
    authorized: socket.authorized,
    alpnProtocol: socket.alpnProtocol ?? false,
    peerCertificate: toPeerCertificate(socket.getPeerCertificate())
  }
  return authorizationError === undefined ? facts : { ...facts, authorizationError }
}

/**
 * One dial-and-handshake attempt. With the default `rejectUnauthorized`,
 * Node fails the handshake with 'error' (the verification code as `.code`,
 * e.g. 'ERR_TLS_CERT_ALTNAME_INVALID') rather than ever reaching
 * 'secureConnect'; with `false` it connects and reports the code on
 * `authorizationError` instead.
 *
 * Mirrors ./node-adapters.ts's `dialOne` structure deliberately -- same
 * timeout race, same abort wiring -- because this is that function's sibling
 * for a secured connection, not a new pattern.
 */
function dialOneSecure (connectOptions: ConnectionOptions, signal: AbortSignal): Promise<DialedSecureSocket> {
  const where = `${String(connectOptions.host)}:${String(connectOptions.port)}`
  return new Promise((resolve, reject) => {
    let socket: TLSSocket
    try {
      socket = tlsConnect(connectOptions)
    } catch (error) {
      // Thrown synchronously while building the secure context: a key,
      // certificate, pfx or passphrase the runtime cannot load. The app's
      // own input, so 'invalid'; the fixed message never echoes it.
      reject(fail('invalid', 'the TLS credentials or trust anchors could not be loaded', undefined, errnoOf(error)))
      return
    }
    const onAbort = (): void => { socket.destroy() }
    signal.addEventListener('abort', onAbort, { once: true })
    let timer: NodeJS.Timeout
    const settle = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    timer = setTimeout(() => {
      settle()
      socket.destroy()
      reject(fail('timeout', `connecting to ${where} exceeded ${String(DIAL_TIMEOUT_MS)}ms`))
    }, DIAL_TIMEOUT_MS)
    timer.unref()

    // Raw, not wrapped in an OrivonError -- matching dialOne's own division
    // of labour: ../io-errors.ts's mapTlsError is the caller's job, the one
    // place this failure becomes 'unreachable' plus a platformCode.
    socket.once('error', (error: NodeJS.ErrnoException) => {
      settle()
      reject(error)
    })
    socket.once('secureConnect', () => {
      settle()
      const { readable, writable } = Duplex.toWeb(socket)
      resolve({
        readable: readable as ReadableStream<Uint8Array>,
        writable: writable as WritableStream<Uint8Array>,
        remoteAddress: socket.remoteAddress ?? String(connectOptions.host),
        remotePort: socket.remotePort ?? connectOptions.port ?? 0,
        localAddress: socket.localAddress ?? '',
        localPort: socket.localPort ?? 0,
        ...handshakeOf(socket),
        setNoDelay: async (on) => { socket.setNoDelay(on) },
        setKeepAlive: async (on, initialDelayMs) => { socket.setKeepAlive(on, initialDelayMs) },
        destroy: async (reason) => { await destroySocket(socket, reason) }
      })
    })
  })
}

/** A failure before any handshake byte, which the next checked address may not share. */
function isConnectFailure (error: unknown): boolean {
  return (error as { syscall?: unknown } | null)?.syscall === 'connect'
}

/**
 * Builds a `DialSecure`. `base` exists only for tests -- see `DialTlsOptions`'s
 * own doc for why production never supplies one.
 *
 * `target.addresses`, when present, are tried in order, like dialTcp's, but
 * only past a connect-level failure: a handshake or verification failure
 * means the server answered, and the next address would answer the same.
 */
export function createDialTls (base: DialTlsOptions = {}): DialSecure {
  return async (target, options, signal) => {
    if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
    let lastError: unknown = fail('unreachable', 'no address to connect to')
    for (const address of target.addresses ?? [target.host]) {
      try {
        return await dialOneSecure(connectOptionsFor(address, target, options, base), signal)
      } catch (error) {
        lastError = error
        if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
        if (!isConnectFailure(error)) break
      }
    }
    throw lastError
  }
}

/**
 * The production `DialSecure` -- exactly `createDialTls()` with no argument,
 * trusting the runtime's own default certificate store unless a call names
 * its own `ca` (ADR-0017: no new dependency). Wired into
 * `CreateBrokerOptions.dialSecure` by ../transport/ipc.ts's
 * `brokerIpcSubsystem`.
 */
export const dialTls: DialSecure = createDialTls()
