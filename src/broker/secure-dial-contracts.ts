// `orivon.net.connectSecure`'s own broker vocabulary: the dial it injects and
// the socket it hands back. Split out of ./broker-contracts.ts by subsystem,
// as ./fs-contracts.ts was, and re-exported from there. No runtime code.

import type { SecureConnectOptions, SecureHandshake } from '../contracts/index.js'
import type { FailableTcpSocket } from './handles/handle-contracts.js'
import type { DialedSocket } from './broker-contracts.js'

/** The TLS options of one `connectSecure` call, already shape-checked at the IPC boundary (./transport/secure-connect-params.ts). */
export type SecureDialOptions = Omit<SecureConnectOptions, 'host' | 'port'>

/**
 * Where one secure dial goes.
 *
 * `host` is exactly `ConnectSecureAllowed.host` (policy/connect-secure.ts):
 * normalised and already checked against the grant. The certificate is
 * verified against it, and SNI carries it, unless the options name a
 * `servername`.
 *
 * `addresses`, WHEN PRESENT, ARE WHAT GETS DIALLED, and `host` is then never
 * resolved again. The broker supplies them whenever the handshake the app
 * asked for would not bind `host` to the peer by itself (../net-connect-
 * secure.ts's `bindsGrantedName`): each is a literal `checkConnect`
 * (policy/connect.ts) already approved, so connecting to the name a second
 * time would be the second resolution T12 forbids. Absent, the dial resolves
 * `host` itself, and the default verification is what binds the answer.
 */
export interface SecureDialTarget {
  readonly host: string
  readonly port: number
  readonly addresses?: readonly string[]
}

/** A dialled secure connection: the plaintext `DialedSocket` plus what its handshake established. */
export interface DialedSecureSocket extends DialedSocket, SecureHandshake {}

/**
 * Opens a TLS-secured connection. The handshake, chain validation and
 * hostname verification all happen inside this call, on the trusted side
 * (ADR-0017, ./adapters/tls-adapter.ts), under whatever `options` the app
 * set -- `rejectUnauthorized: false` really skips the refusal, as in Node.
 *
 * `signal` fires the instant the grant authorising this connection is
 * revoked while the handshake is still in flight, exactly as `Dial`'s does.
 */
export type DialSecure = (target: SecureDialTarget, options: SecureDialOptions, signal: AbortSignal) => Promise<DialedSecureSocket>

/** `connectSecure`'s handle: `connect`'s `FailableTcpSocket` plus the handshake facts the page's `SecureTcpSocket` carries. */
export type FailableSecureTcpSocket = FailableTcpSocket & SecureHandshake
