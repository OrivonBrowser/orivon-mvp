// `tls` module target: tls.connect()/TLSSocket over orivon.net.connectSecure.
// The broker performs the handshake under the app's own TLS options (trust
// anchors, rejectUnauthorized, client certificate, SNI, ALPN) and hands back
// a plaintext TcpSocket plus what the handshake established (ADR-0017). A
// TLSSocket is therefore a net.Socket with a different dial, plus the
// TLS-shaped members libraries read. ./node-tls-options.ts translates the
// options and finishes verification when the app brings its own
// checkServerIdentity; what cannot cross to the broker refuses by name.

import { Socket, kDial, socketOptionsFrom, type NetDialFn } from './node-net-socket.js'
import { normalizeConnectArgs, type ConnectTarget } from './node-net-args.js'
import { getOrivon } from './orivon-global.js'
import { isIP } from './node-net-isip.js'
import { refuseShim, type OrivonShimError } from './errors.js'
import { refusingProxy } from './unimplemented.js'
import { checkServerIdentity } from './node-tls-identity.js'
import { nodePeerCertificate, planTls, verdictFor, type TlsPlan, type TlsVerdict } from './node-tls-options.js'
import type { SecureConnectOptions } from '../contracts/capability-api.js'
import type { SecureHandshake, TcpSocket } from '../contracts/handles.js'

export type TlsConnectOptions = ConnectTarget & { [kDial]?: NetDialFn }

type SecureHandle = TcpSocket & Partial<SecureHandshake>
type SecureDialFn = (opts: SecureConnectOptions) => Promise<SecureHandle>

/** What one TLSSocket's dial learned, filled in before its connect promise settles. */
interface HandshakeState {
  handle?: SecureHandle
  verdict?: TlsVerdict
  /** The error verification destroyed the socket with, passed to the app unchanged. */
  failure?: Error
}

/**
 * The dial a TLSSocket connects through: connectSecure with the planned
 * options, then the verdict. A failing verdict closes the handle and rejects
 * the dial, so net.Socket's queued writes never reach an unverified peer --
 * they wait on this same promise.
 */
function secureDial (dial: SecureDialFn, plan: TlsPlan | OrivonShimError, state: HandshakeState, servername: unknown): NetDialFn {
  return async ({ host, port }) => {
    if (plan instanceof Error) throw plan
    const handle = await dial({ ...plan.broker, host, port })
    // Node checks identity against `servername || host`.
    const identity = typeof servername === 'string' && servername !== '' ? servername : host
    const verdict = verdictFor(handle, plan, identity)
    state.handle = handle
    state.verdict = verdict
    if (verdict.error !== undefined) {
      state.failure = verdict.error
      handle.close().catch(() => {})
      throw verdict.error
    }
    return handle
  }
}

export class TLSSocket extends Socket {
  readonly encrypted = true
  authorized = false
  /** Node's value: the verification error's code string, null until verification fails. */
  authorizationError: string | null = null
  alpnProtocol: string | false = false
  servername: string | false = false
  private readonly plan: TlsPlan | OrivonShimError
  private readonly state: HandshakeState

  /** `new TLSSocket(socket)` wraps an existing socket in Node; here the first argument must be absent. */
  constructor (socket?: unknown, options: TlsConnectOptions = {}) {
    const plan = planTls(options, 'tls.connect')
    const state: HandshakeState = {}
    const dial = (options[kDial] as SecureDialFn | undefined) ?? ((opts) => getOrivon().net.connectSecure(opts))
    super(socketOptionsFrom(options, secureDial(dial, plan, state, options.servername)))
    if (socket !== undefined && socket !== null) {
      throw refuseShim('new tls.TLSSocket(socket)', 'unimplemented',
        'new tls.TLSSocket(socket): wrapping an existing socket is not available -- orivon.net.connectSecure opens a ' +
        'connection that is TLS from its first byte. Use tls.connect() to open a new TLS connection.')
    }
    this.plan = plan
    this.state = state
  }

  /** The named refusal for options nothing could apply, or undefined. */
  planRefusal (): OrivonShimError | undefined {
    return this.plan instanceof Error ? this.plan : undefined
  }

  override connect (...args: readonly unknown[]): this {
    const { options } = normalizeConnectArgs(args)
    const host = typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost'
    const servername = typeof options.servername === 'string' ? options.servername : host
    this.servername = servername !== '' && isIP(servername) === 0 ? servername : false
    return super.connect(...args)
  }

  protected override onConnected (): void {
    this.authorized = this.state.verdict?.authorized ?? true
    this.authorizationError = this.state.verdict?.authorizationError ?? null
    this.alpnProtocol = this.state.handle?.alpnProtocol ?? false
    super.onConnected()
    this.emit('secureConnect')
  }

  protected override connectFailure (error: unknown, host: string, port: number): Error {
    if (error !== undefined && error === this.state.failure) return this.state.failure
    return super.connectFailure(error, host, port)
  }

  /**
   * The server's certificate as the broker reported it, in Node's shape
   * (`raw`/`pubkey` as Buffers); `{}` before the handshake or when none was
   * presented, null once destroyed. No chain: `detailed` adds no
   * `issuerCertificate`, which the broker does not report.
   */
  getPeerCertificate (_detailed?: boolean): Record<string, unknown> | null {
    if (this.destroyed) return null
    return nodePeerCertificate(this.state.handle?.peerCertificate)
  }

  getCertificate (): Record<string, never> { return {} }
  /** null is Node's answer for a socket whose protocol is unknown to it. */
  getProtocol (): string | null { return null }
  getSession (): undefined { return undefined }
  isSessionReused (): boolean { return false }
}

/** Node's tls.connect overloads: `(options[, cb])`, `(port[, host][, options][, cb])`. The third-position options object is merged in. */
function normalizeTlsArgs (args: readonly unknown[]): { options: TlsConnectOptions, callback: (() => void) | undefined } {
  const { options, callback } = normalizeConnectArgs(args)
  const extra = [args[1], args[2]].find((value) => typeof value === 'object' && value !== null)
  return { options: extra !== undefined && extra !== args[0] ? { ...options, ...(extra as object) } : options, callback }
}

/** tls.connect with already-normalised options; https.request dials through this too. The callback listens for 'secureConnect', as in Node. */
export function connectTls (options: TlsConnectOptions, callback?: () => void): TLSSocket {
  const socket = new TLSSocket(undefined, options)
  if (callback !== undefined) socket.once('secureConnect', callback)
  const refusal = socket.planRefusal()
  if (refusal !== undefined) {
    queueMicrotask(() => socket.destroy(refusal))
    return socket
  }
  if (typeof options.timeout === 'number') socket.setTimeout(options.timeout)
  return socket.connect(options)
}

export function connect (...args: readonly unknown[]): TLSSocket {
  const { options, callback } = normalizeTlsArgs(args)
  return connectTls(options, callback)
}

export { checkServerIdentity }

function otherTlsMember (prop: string): OrivonShimError {
  return refuseShim(`tls.${prop}`, 'unimplemented',
    `tls.${prop} is real Node tls surface this shim has not implemented; tls.connect, TLSSocket and ` +
    'checkServerIdentity are built, over orivon.net.connectSecure. See docs/planning/compatibility-matrix.md Table 3.')
}

export default refusingProxy({ connect, TLSSocket, checkServerIdentity }, otherTlsMember)
