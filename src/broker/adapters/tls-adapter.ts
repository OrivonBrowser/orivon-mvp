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

import { connect as tlsConnect } from 'node:tls'
import { Duplex } from 'node:stream'
import type { DialedSocket, DialSecure } from '../broker-contracts.js'
import { DIAL_TIMEOUT_MS, destroySocket } from './node-adapters.js'
import { fail } from '../errors.js'

/**
 * Trust anchors for the handshake. **Supplying this REPLACES the runtime's
 * built-in root store; it does not add to it.** Measured, not assumed: a real
 * public host that handshakes fine with no `ca` fails with
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` the moment an unrelated CA is passed.
 * So anything that reached this option in production would not be widening
 * trust, it would be switching every public certificate off.
 *
 * A TESTING SEAM ONLY. `DialSecure` (../broker-contracts.ts) takes no such
 * option, so nothing between an app and this file can ever reach it: not
 * `net-capability.ts`'s `connectSecure`, not a grant, not a manifest. Only a
 * test that constructs its own `DialSecure` via `createDialTls` directly --
 * bypassing the broker entirely -- can supply one, to trust a throwaway CA
 * generated for that test run (there is no other way to hand a local test
 * server a certificate a real trusted root actually signed).
 */
export interface DialTlsOptions {
  // Matches node:tls's own `SecureContextOptions.ca` shape exactly (a plain,
  // mutable array, not a readonly one) -- widening it here would only make
  // TypeScript reject the object literal handed to `tls.connect` below.
  readonly ca?: string | Buffer | Array<string | Buffer>
}

/**
 * One dial-and-handshake attempt. `tls.connect({ host, port })` resolves DNS,
 * opens the TCP connection AND performs the handshake -- certificate chain
 * validation and hostname verification against `host` itself, using the
 * runtime's own OpenSSL binding (`rejectUnauthorized` defaults to true, and
 * nothing here overrides `checkServerIdentity`: weakening either is not this
 * file's decision to make). No explicit `servername` is passed -- `tls.
 * connect` already defaults it to `host`, and passing an IP literal there
 * explicitly trips a Node deprecation warning for no behavioural gain
 * (confirmed against a real handshake, not assumed: verification behaves
 * identically either way).
 *
 * Mirrors ./node-adapters.ts's `dialOne` structure deliberately -- same
 * timeout race, same abort wiring -- because this is that function's sibling
 * for a secured connection, not a new pattern.
 */
function dialOneSecure (
  host: string,
  port: number,
  signal: AbortSignal,
  options: DialTlsOptions
): Promise<DialedSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, ca: options.ca })
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
      reject(fail('timeout', `connecting to ${host}:${String(port)} exceeded ${String(DIAL_TIMEOUT_MS)}ms`))
    }, DIAL_TIMEOUT_MS)
    timer.unref()

    // Raw, not wrapped in an OrivonError -- matching dialOne's own division
    // of labour: ../io-errors.ts's mapTlsError is the caller's job (net-
    // capability.ts), the one place this failure becomes 'unreachable' plus
    // a platformCode. A rejected certificate surfaces here too: with the
    // default `rejectUnauthorized: true`, Node fails the handshake with
    // 'error' (verification error as `.code`, e.g.
    // 'ERR_TLS_CERT_ALTNAME_INVALID') rather than ever reaching
    // 'secureConnect' -- confirmed against a real mismatched-hostname
    // handshake in ./tests/tls-adapter.test.ts, not assumed.
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
        remoteAddress: socket.remoteAddress ?? host,
        remotePort: socket.remotePort ?? port,
        localAddress: socket.localAddress ?? '',
        localPort: socket.localPort ?? 0,
        setNoDelay: async (on) => { socket.setNoDelay(on) },
        setKeepAlive: async (on, initialDelayMs) => { socket.setKeepAlive(on, initialDelayMs) },
        destroy: async (reason) => { await destroySocket(socket, reason) }
      })
    })
  })
}

/**
 * Builds a `DialSecure`. `options` exists only for ./tests/tls-adapter.
 * test.ts -- see `DialTlsOptions`'s own doc for why nothing else may ever
 * supply one.
 */
export function createDialTls (options: DialTlsOptions = {}): DialSecure {
  return async (host, port, signal) => {
    if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
    return await dialOneSecure(host, port, signal, options)
  }
}

/**
 * The production `DialSecure` -- exactly `createDialTls()` with no argument,
 * trusting only the runtime's own default certificate store (ADR-0017: no
 * new dependency, no override). Wired into `CreateBrokerOptions.dialSecure`
 * by ../transport/ipc.ts's `brokerIpcSubsystem`.
 */
export const dialTls: DialSecure = createDialTls()
