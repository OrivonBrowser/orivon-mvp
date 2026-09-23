// net.Server over orivon.net.listen's TcpServer (handles.ts) -- A114/d-0028's
// Node shape. Node's Server is an EventEmitter; TcpServer.connections is a
// WHATWG stream deliberately run at highWaterMark: 0 (handle-contracts.md's
// "TcpServer" section), so ONE stream read is what authorises the broker to
// accept ONE pending connection -- see `pump` for how that stays true once
// an EventEmitter is layered on top.
//
// HOST IS NOT A CAPABILITY orivon.net.listen HAS: the broker always binds
// every interface. A host meaning "every interface" is accepted; any other,
// loopback included, refuses by name -- README.md's Design notes say why.

import { EventEmitter } from 'events'
import type { TcpServer, TcpSocket } from '../contracts/handles.js'
import { Socket, type SocketOptions } from './node-net-socket.js'
import { codedError, toNodeError } from './node-http-errors.js'
import { validatePort } from './node-net-args.js'
import { refuseShim } from './errors.js'

export type NetListenFn = (opts: { port: number }) => Promise<TcpServer>

export interface ServerOptions extends SocketOptions {}

/** Every host spelling this shim can honour -- orivon.net.listen always binds every interface. */
const ANY_INTERFACE_HOSTS = new Set([undefined, '0.0.0.0', '::', '::0', '0000:0000:0000:0000:0000:0000:0000:0000'])

interface ParsedListen {
  readonly port: number
  readonly host: string | undefined
  readonly path: string | undefined
  readonly callback: (() => void) | undefined
}

/** `.listen([port][, host][, backlog][, cb])`, `.listen(options[, cb])`, `.listen(path[, cb])` -- Node's overloads. A backlog is an OS accept-queue hint, accepted and ignored. */
function parseListenArgs (args: readonly unknown[]): ParsedListen {
  const last = args[args.length - 1]
  const callback = typeof last === 'function' ? last as () => void : undefined
  const positional = callback !== undefined ? args.slice(0, -1) : args
  const [first, second] = positional
  if (typeof first === 'object' && first !== null) {
    const opts = first as { port?: unknown, host?: unknown, path?: unknown }
    return {
      port: opts.port === undefined ? 0 : validatePort(opts.port),
      host: typeof opts.host === 'string' ? opts.host : undefined,
      path: typeof opts.path === 'string' ? opts.path : undefined,
      callback
    }
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { port: 0, host: undefined, path: first, callback }
  return {
    port: first === undefined || first === null ? 0 : validatePort(first),
    host: typeof second === 'string' ? second : undefined,
    path: undefined,
    callback
  }
}

function refuseHost (host: string): Error {
  return refuseShim('net.Server#listen(host)', 'unimplemented',
    `orivon.net.listen has no host parameter and always binds every interface, so binding '${host}' alone ` +
    'cannot be honoured, and binding wider than asked would expose to the network a listener the app meant to ' +
    'keep local. Omit the host, or pass \'0.0.0.0\', to bind every interface.')
}

export class Server extends EventEmitter {
  /** Node's cap on concurrent accepted connections; a connection past it is closed and 'drop' is emitted. */
  maxConnections: number | undefined
  private readonly doListen: NetListenFn
  private readonly socketOptions: ServerOptions
  private handle: TcpServer | null = null
  private reader: ReadableStreamDefaultReader<TcpSocket> | null = null
  private listenPending = false
  private closing = false
  private closeEmitted = false
  private pumping = false
  private readonly connections = new Set<Socket>()

  constructor (listenFn: NetListenFn, opts: ServerOptions = {}, connectionListener?: (socket: Socket) => void) {
    super()
    this.doListen = listenFn
    this.socketOptions = opts
    if (connectionListener !== undefined) this.on('connection', connectionListener)
  }

  get listening (): boolean { return this.handle !== null && !this.closing }

  listen (...args: readonly unknown[]): this {
    const { port, host, path, callback } = parseListenArgs(args)
    if (path !== undefined) {
      throw refuseShim('net.Server#listen(path)', 'not-applicable',
        `listening on the local IPC endpoint '${path}' is not available: orivon.net.listen opens TCP ports only.`)
    }
    if (!ANY_INTERFACE_HOSTS.has(host)) throw refuseHost(host as string)
    if (this.handle !== null || this.listenPending) {
      throw codedError(Error, 'ERR_SERVER_ALREADY_LISTEN', 'Listen method has been called more than once without closing.')
    }
    if (callback !== undefined) this.once('listening', callback)
    this.listenPending = true
    this.closing = false
    this.closeEmitted = false
    // An async IIFE: getOrivon() throws SYNCHRONOUSLY before the preload has
    // run, and that must arrive as 'error', never a throw out of listen().
    const promise = (async () => await this.doListen({ port }))()
    promise.then((handle) => {
      this.listenPending = false
      if (this.closing) { handle.close().catch(() => {}); this.emitCloseOnce(); return }
      this.handle = handle
      this.reader = handle.connections.getReader()
      this.emit('listening')
      this.pump()
    }, (error: unknown) => {
      this.listenPending = false
      if (this.closing) { this.emitCloseOnce(); return }
      this.emit('error', toNodeError(error, { syscall: 'listen', port }))
    })
    return this
  }

  /**
   * THE PROPERTY THIS FILE EXISTS TO PRESERVE. `TcpServer.connections` is a
   * highWaterMark: 0 stream, so `reader.read()` is itself the unit of accept
   * demand the broker is waiting for -- never called again here until the
   * PREVIOUS call has both resolved and its socket been delivered via
   * 'connection'. At most ONE accept is ever outstanding, and the broker
   * never sees a read() for a connection nothing has asked for yet.
   */
  private pump (): void {
    if (this.reader === null || this.pumping || this.closing) return
    this.pumping = true
    this.reader.read().then(({ done, value }) => {
      this.pumping = false
      if (done) { this.handle = null; this.emitCloseOnce(); return }
      this.accept(value)
      this.pump()
    }, (error: unknown) => {
      this.pumping = false
      if (!this.closing) this.emit('error', toNodeError(error, { syscall: 'accept' }))
    })
  }

  private accept (handle: TcpSocket): void {
    const socket = Socket.fromAccepted(handle, this.socketOptions)
    if (this.maxConnections !== undefined && this.connections.size >= this.maxConnections) {
      socket.destroy()
      this.emit('drop', { localAddress: handle.localAddress, localPort: handle.localPort, remoteAddress: handle.remoteAddress, remotePort: handle.remotePort })
      return
    }
    this.connections.add(socket)
    socket.once('close', () => this.connections.delete(socket))
    this.emit('connection', socket)
  }

  private emitCloseOnce (): void {
    if (this.closeEmitted) return
    this.closeEmitted = true
    queueMicrotask(() => this.emit('close'))
  }

  address (): { address: string, port: number, family: string } | null {
    if (this.handle === null) return null
    return {
      address: this.handle.localAddress,
      port: this.handle.localPort,
      family: this.handle.localAddress.includes(':') ? 'IPv6' : 'IPv4'
    }
  }

  /** The number of accepted connections still open, delivered asynchronously as in Node. */
  getConnections (callback: (error: Error | null, count: number) => void): this {
    const count = this.connections.size
    queueMicrotask(() => callback(null, count))
    return this
  }

  /** No event-loop handle exists here; both are Node's documented no-op-returning-this. */
  ref (): this { return this }
  unref (): this { return this }

  /**
   * Stops accepting and closes the underlying handle; 'close' is emitted once.
   * Unlike Node, sockets already accepted close with it: they are derived
   * handles, and the broker closes every one still open when the server
   * handle closes (handle-contracts.md's "TcpServer" section).
   */
  close (callback?: (error?: Error) => void): this {
    const running = this.handle !== null || this.listenPending
    if (callback !== undefined) {
      this.once('close', () => {
        if (running) callback()
        else callback(codedError(Error, 'ERR_SERVER_NOT_RUNNING', 'Server is not running.'))
      })
    }
    this.closing = true
    const handle = this.handle
    this.handle = null
    if (handle !== null) handle.close().catch(() => {}).then(() => this.emitCloseOnce())
    else if (!this.listenPending) this.emitCloseOnce()
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
