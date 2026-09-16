// net.Server over orivon.net.listen's TcpServer (handles.ts) -- A114/d-0028's
// Node shape. Node's Server is an EventEmitter; TcpServer.connections is a
// WHATWG stream deliberately run at highWaterMark: 0 (handle-contracts.md's
// "TcpServer" section), so ONE stream read is what authorises the broker to
// accept ONE pending connection -- see this file's own `_pump` for how that
// stays true once an EventEmitter is layered on top.
//
// HOST/BACKLOG ARE NOT A CAPABILITY orivon.net.listen HAS -- the broker
// always binds every interface (src/broker/adapters/node-adapters.ts's own
// listenTcp). `.listen(port, host, cb)` accepts a host argument (real Node
// callers pass one routinely) but only silently accepts values that mean
// "every interface" already (undefined, '0.0.0.0', '::'); anything else --
// most commonly '127.0.0.1', a caller asking to bind loopback-only -- would
// silently bind wider than asked, which is a real behaviour change with
// security consequences, so that case throws a named error instead.

import { EventEmitter } from 'events'
import type { TcpServer, TcpSocket } from '../contracts/handles.js'
import { Socket, type SocketOptions } from './node-net-socket.js'
import { toNodeError } from './node-http-errors.js'
import { refuseShim } from './errors.js'

export type NetListenFn = (opts: { port: number }) => Promise<TcpServer>

export interface ServerOptions extends SocketOptions {}

/** Every host spelling this shim can honour -- orivon.net.listen always binds every interface. */
const ANY_INTERFACE_HOSTS = new Set([undefined, '0.0.0.0', '::', '::0', '0000:0000:0000:0000:0000:0000:0000:0000'])

interface ParsedListen {
  readonly port: number
  readonly host: string | undefined
  readonly callback: (() => void) | undefined
}

/** `.listen(port)`, `.listen(port, cb)`, `.listen(port, host[, backlog][, cb])`, `.listen(options[, cb])` -- real Node's own overload set, scanned the same way createConnectFactory (node-net-socket.ts) scans net.connect's. `backlog`, when present, is a plain number sitting between host and the callback; it is accepted and ignored (an OS accept-queue hint, not a correctness knob) rather than rejected. */
function parseListenArgs (args: readonly unknown[]): ParsedListen {
  const last = args[args.length - 1]
  const callback = typeof last === 'function' ? last as () => void : undefined
  const positional = callback !== undefined ? args.slice(0, -1) : args
  const [first, second] = positional
  if (typeof first === 'object' && first !== null) {
    const opts = first as { port: number, host?: string }
    return { port: opts.port, host: opts.host, callback }
  }
  return { port: Number(first), host: typeof second === 'string' ? second : undefined, callback }
}

export class Server extends EventEmitter {
  private readonly doListen: NetListenFn
  private readonly socketOptions: ServerOptions
  private handle: TcpServer | null = null
  private reader: ReadableStreamDefaultReader<TcpSocket> | null = null
  private listening = false
  private closing = false
  private pumping = false

  constructor (listenFn: NetListenFn, opts: ServerOptions = {}, connectionListener?: (socket: Socket) => void) {
    super()
    this.doListen = listenFn
    this.socketOptions = opts
    if (connectionListener !== undefined) this.on('connection', connectionListener)
  }

  listen (...args: readonly unknown[]): this {
    const { port, host, callback } = parseListenArgs(args)
    if (!ANY_INTERFACE_HOSTS.has(host)) {
      // 'unimplemented', not 'not-applicable': a host-scoped tcp.listen
      // COULD be added to the capability later (unlike, say, chmod on a
      // POSIX-less fs, which never could be) -- nothing has decided either
      // way, which is exactly what 'unimplemented' names.
      throw refuseShim(
        'net.Server#listen(host)', 'unimplemented',
        `orivon.net.listen has no host parameter and always binds every interface -- binding ` +
        `'${String(host)}' only (loopback or a specific interface) cannot be honoured. Omit ` +
        'the host argument, or pass \'0.0.0.0\', to bind every interface as this shim already does.'
      )
    }
    if (callback !== undefined) this.once('listening', callback)
    // Wrapped in an async IIFE rather than called bare -- node-net-socket.ts's
    // connect() does the same for the identical reason: getOrivon() throws
    // SYNCHRONOUSLY when window.orivon is not present yet, and every other
    // failure here must surface through the 'error' event, never a throw
    // out of listen() itself.
    const promise = (async () => this.doListen({ port }))()
    promise.then((handle) => {
      if (this.closing) { handle.close().catch(() => {}); return }
      this.handle = handle
      this.listening = true
      this.reader = handle.connections.getReader()
      this.emit('listening')
      this._pump()
    }).catch((error) => {
      this.emit('error', toNodeError(error))
    })
    return this
  }

  /**
   * THE PROPERTY THIS FILE EXISTS TO PRESERVE. `TcpServer.connections` is a
   * highWaterMark: 0 stream, so `reader.read()` is itself the unit of accept
   * demand the broker is waiting for -- never called again here until the
   * PREVIOUS call has both resolved and its socket been delivered via
   * 'connection'. An EventEmitter has no backpressure primitive of its own
   * (that is real Node's own limitation too, not one this shim introduces),
   * so the guarantee this loop actually gives is narrower and load-bearing:
   * at most ONE accept is ever outstanding at a time, and the broker never
   * sees a second read() for a connection nothing has asked for yet.
   */
  private _pump (): void {
    if (this.reader === null || this.pumping || this.closing) return
    this.pumping = true
    this.reader.read().then(({ done, value }) => {
      this.pumping = false
      if (done) { this.listening = false; this.emit('close'); return }
      this.emit('connection', Socket.fromAccepted(value, this.socketOptions))
      this._pump()
    }).catch((error) => {
      this.pumping = false
      if (!this.closing) this.emit('error', toNodeError(error))
    })
  }

  address (): { address: string, port: number, family: string } | null {
    if (this.handle === null) return null
    return {
      address: this.handle.localAddress,
      port: this.handle.localPort,
      family: this.handle.localAddress.includes(':') ? 'IPv6' : 'IPv4'
    }
  }

  /**
   * Stops future accepts and closes the underlying handle. Sockets already
   * accepted are NOT this wrapper's responsibility to tear down: they are
   * derived handles that inherit the server's grant, and the broker itself
   * closes every one still open the moment the server handle closes
   * (handle-contracts.md's "TcpServer" section) -- duplicating that here
   * would be a second, competing teardown path for the same sockets.
   */
  close (callback?: (error?: Error) => void): this {
    this.closing = true
    const handle = this.handle
    if (handle === null) {
      this.listening = false
      if (callback !== undefined) callback()
      return this
    }
    if (callback !== undefined) this.once('close', () => callback())
    handle.close().then(() => {
      this.listening = false
      this.emit('close')
    }).catch((error) => {
      this.listening = false
      this.emit('close')
      if (callback !== undefined) callback(toNodeError(error))
    })
    return this
  }
}

/** net.createServer([options][, connectionListener]) -- real Node's own overload: the options object is optional. */
export function createServerFactory (listenFn: NetListenFn): (...args: readonly unknown[]) => Server {
  return function createServer (...args: readonly unknown[]): Server {
    const [first, second] = args
    if (typeof first === 'function') return new Server(listenFn, {}, first as (socket: Socket) => void)
    const opts = (first as ServerOptions | undefined) ?? {}
    const listener = typeof second === 'function' ? second as (socket: Socket) => void : undefined
    return new Server(listenFn, opts, listener)
  }
}
