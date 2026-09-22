// `tls` module target: tls.connect()/TLSSocket over orivon.net.connectSecure.
// The broker performs the handshake, verifies the chain against the system
// trust store and the certificate against the host it dialled, and hands
// back a plaintext TcpSocket (ADR-0017). A TLSSocket is therefore a
// net.Socket with a different dial, plus the TLS-shaped members libraries
// read. What the broker cannot do per connection -- a custom CA, a client
// certificate, a custom identity check, upgrading an existing socket, a
// servername other than the host -- refuses by name through 'error' rather
// than being dropped; README.md's Design notes say why rejectUnauthorized
// is the one override accepted.

import { Socket, kDial, socketOptionsFrom, type NetDialFn } from './node-net-socket.js'
import { normalizeConnectArgs, type ConnectTarget } from './node-net-args.js'
import { getOrivon } from './orivon-global.js'
import { isIP } from './node-net-isip.js'
import { refuseShim, type OrivonShimError } from './errors.js'
import { refusingProxy } from './unimplemented.js'

export type TlsConnectOptions = ConnectTarget & { [kDial]?: NetDialFn }

const BROKER_VERIFIES =
  'orivon.net.connectSecure performs the TLS handshake in the broker, verifying the certificate chain against ' +
  'the system trust store and the certificate against the host it dialled, and accepts no per-connection override'

/** Options a caller sets to change who is trusted or how; the broker would silently ignore every one. */
const UNHONOURABLE_OPTIONS = ['ca', 'cert', 'key', 'pfx', 'secureContext', 'checkServerIdentity'] as const

function unhonourable (api: string, what: string, consequence: string): OrivonShimError {
  return refuseShim(api, 'unimplemented', `${api}: ${what} cannot be honoured -- ${BROKER_VERIFIES}. ${consequence}`)
}

/** The named refusal for a TLS option set the broker cannot honour, or undefined when it can. Shared with https.request. */
export function tlsOptionRefusal (options: ConnectTarget, api: string): OrivonShimError | undefined {
  if (options.socket !== undefined && options.socket !== null) {
    return unhonourable(api, 'upgrading an existing socket (the `socket` option, STARTTLS)',
      'Only a connection opened by connectSecure itself can be TLS.')
  }
  for (const key of UNHONOURABLE_OPTIONS) {
    if (options[key] !== undefined && options[key] !== null) {
      return unhonourable(api, `the '${key}' option`,
        'A server whose certificate does not chain to the system store (self-signed, private CA) cannot be reached this way.')
    }
  }
  const { servername, host } = options
  if (typeof servername === 'string' && servername !== '' &&
      servername.toLowerCase() !== String(host ?? 'localhost').toLowerCase()) {
    return unhonourable(api, `a servername ('${servername}') different from the host`,
      'Pass the name the certificate is issued for as the host.')
  }
  return undefined
}

export class TLSSocket extends Socket {
  readonly encrypted = true
  authorized = false
  authorizationError: Error | null = null
  /** No ALPN is negotiated: connectSecure has no parameter for it, so an ALPNProtocols option is accepted and this stays false. */
  alpnProtocol: string | false = false
  servername: string | false = false
  private readonly relaxedVerification: boolean

  /** `new TLSSocket(socket)` wraps an existing socket in Node; here the first argument must be absent. */
  constructor (socket?: unknown, options: TlsConnectOptions = {}) {
    super(socketOptionsFrom(options, options[kDial] ?? ((opts) => getOrivon().net.connectSecure(opts))))
    if (socket !== undefined && socket !== null) {
      throw unhonourable('new tls.TLSSocket(socket)', 'wrapping an existing socket', 'Use tls.connect() to open a new TLS connection.')
    }
    this.relaxedVerification = options.rejectUnauthorized === false
  }

  override connect (...args: readonly unknown[]): this {
    const { options } = normalizeConnectArgs(args)
    const host = typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost'
    const servername = typeof options.servername === 'string' ? options.servername : host
    this.servername = servername !== '' && isIP(servername) === 0 ? servername : false
    return super.connect(...args)
  }

  protected override onConnected (): void {
    this.authorized = true
    super.onConnected()
    this.emit('secureConnect')
  }

  protected override connectFailure (error: unknown, host: string, port: number): Error {
    const mapped = super.connectFailure(error, host, port) as Error & { orivonCode?: string }
    if (this.relaxedVerification && mapped.orivonCode === 'unreachable') {
      mapped.message += ` (rejectUnauthorized: false was not applied: ${BROKER_VERIFIES})`
    }
    return mapped
  }

  /** Node returns `{}` when no peer certificate is available; the broker keeps it. */
  getPeerCertificate (_detailed?: boolean): Record<string, never> { return {} }
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
  const refusal = tlsOptionRefusal(options, 'tls.connect')
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

function otherTlsMember (prop: string): OrivonShimError {
  return refuseShim(`tls.${prop}`, 'unimplemented',
    `tls.${prop} is real Node tls surface this shim has not implemented; tls.connect and TLSSocket are ` +
    'built, over orivon.net.connectSecure. See docs/planning/compatibility-matrix.md Table 3.')
}

export default refusingProxy({ connect, TLSSocket }, otherTlsMember)
