// net.Socket, presented as a real `stream.Duplex` over the WHATWG streams
// orivon.net.connect/connectSecure return (ADR-0008).
//
// BACKPRESSURE IS REAL HERE: `_read` only pulls from the underlying reader
// when Node's stream machinery asks for more, and stops the instant `push()`
// reports the internal buffer is full. This class backs `.pipe()` chains
// carrying torrent piece data, where an eager pull would defeat the
// credit-window design handle-contracts.md's Backpressure section specifies.
//
// CONNECT HAS NO EVENT TO WAIT FOR (handles.ts rule 4): orivon.net.connect's
// Promise resolving IS the connect event. Every method that needs the
// handle queues behind `connectPromise` or a pending field rather than
// assuming `this.handle` is already set.
//
// autoDestroy and emitClose are passed explicitly: the renderer's `stream`
// is readable-stream 3, which defaults autoDestroy to false, and without it
// a socket whose both sides ended never emits 'close' and never releases
// its broker handle.

import { Duplex } from 'stream'
import type { TcpSocket } from '../contracts/handles.js'
import { abortError, codedError, systemError, toNodeError } from './node-http-errors.js'
import { toBytes } from './node-stream-bytes.js'
import { refuseShim } from './errors.js'
import { getOrivon } from './orivon-global.js'
import { isIP } from './node-net-isip.js'
import { connectPort, normalizeConnectArgs, type ConnectTarget } from './node-net-args.js'

export type NetDialFn = (opts: { host: string, port: number }) => Promise<TcpSocket>

/** How a socket dials. Absent, it is orivon.net.connect, looked up when connect() runs, never at construction. */
export const kDial: unique symbol = Symbol('orivon-node-shim.dial')

export interface SocketOptions {
  /** Default false, matching real Node: when the peer's FIN arrives, this side's writable auto-ends too, unless this is true. */
  allowHalfOpen?: boolean
  signal?: AbortSignal
  noDelay?: boolean
  keepAlive?: boolean
  keepAliveInitialDelay?: number
  [kDial]?: NetDialFn
}

function familyOf (address: string | undefined): 'IPv4' | 'IPv6' | undefined {
  if (address === undefined) return undefined
  return isIP(address) === 6 ? 'IPv6' : 'IPv4'
}

function socketClosedError (): Error & { code: string } {
  return codedError(Error, 'ERR_SOCKET_CLOSED', 'Socket is closed')
}

export class Socket extends Duplex {
  remoteAddress: string | undefined
  remotePort: number | undefined
  localAddress: string | undefined
  localPort: number | undefined
  connecting = false
  bytesRead = 0
  /** Node's `socket.timeout`: the idle timeout last set with setTimeout(), undefined until one is. */
  timeout: number | undefined

  protected readonly dial: NetDialFn
  private handle: TcpSocket | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private connectPromise: Promise<TcpSocket> | null = null
  private wantsRead = false
  private pumping = false
  private written = 0
  private idleTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  private hadError = false
  private resetOnDestroy = false
  private pendingNoDelay: boolean | undefined
  private pendingKeepAlive: { enable: boolean, initialDelay: number } | undefined

  constructor (options: SocketOptions & { fd?: unknown } = {}) {
    super({ allowHalfOpen: options.allowHalfOpen ?? false, autoDestroy: true, emitClose: true })
    if (options.fd !== undefined) {
      throw refuseShim('net.Socket({ fd })', 'not-applicable',
        'wrapping an existing file descriptor is not available: a renderer holds no OS descriptors, only orivon.net handles.')
    }
    this.dial = options[kDial] ?? ((opts) => getOrivon().net.connect(opts))
    if (options.noDelay === true) this.setNoDelay(true)
    if (options.keepAlive === true) this.setKeepAlive(true, options.keepAliveInitialDelay)
    const signal = options.signal
    if (signal !== undefined) {
      if (signal.aborted) queueMicrotask(() => this.destroy(abortError(signal.reason)))
      else signal.addEventListener('abort', () => this.destroy(abortError(signal.reason)), { once: true })
    }
  }

  /** `connect(options[, cb])`, `connect(path[, cb])`, `connect(port[, host][, cb])` -- Node's own overloads and argument errors. */
  connect (...args: readonly unknown[]): this {
    const { options, callback } = normalizeConnectArgs(args)
    if (this.destroyed) throw socketClosedError()
    if (typeof options.path === 'string') return this.refusePath(options.path, callback)
    const port = connectPort(options)
    const host = typeof options.host === 'string' && options.host !== '' ? options.host : 'localhost'
    if (this.connecting || this.handle !== null) {
      this.destroy(systemError('EISCONN', 'connect', { address: host, port }))
      return this
    }
    if (callback !== undefined) this.once('connect', callback)
    this.connecting = true
    this.refreshIdleTimer()
    // An async IIFE, never a bare call: `dial` can throw synchronously
    // (getOrivon() does before the preload has run), and that must still
    // arrive as an 'error' event, never a throw out of connect().
    const promise = (async () => await this.dial({ host, port }))()
    this.connectPromise = promise
    // Two-argument then(): a throw from a 'connect' listener must stay the
    // app's own uncaught error, not be caught here and destroy the socket.
    promise.then((handle) => {
      if (this.destroyed) { handle.close().catch(() => {}); return }
      this.attachHandle(handle)
      this.connecting = false
      this.refreshIdleTimer()
      this.onConnected()
    }, (error: unknown) => {
      this.connecting = false
      this.destroy(this.connectFailure(error, host, port))
    })
    return this
  }

  /** What a subclass announces once connected; a TLS socket adds 'secureConnect'. */
  protected onConnected (): void {
    this.emit('connect')
    this.emit('ready')
  }

  /** How a failed dial reads to the app; a TLS socket adds what its options could not change. */
  protected connectFailure (error: unknown, host: string, port: number): Error {
    return toNodeError(error, { syscall: 'connect', address: host, port })
  }

  private refusePath (path: string, callback: (() => void) | undefined): this {
    if (callback !== undefined) this.once('connect', callback)
    this.connecting = true
    queueMicrotask(() => {
      this.connecting = false
      this.destroy(refuseShim('net.Socket#connect(path)', 'not-applicable',
        `connecting to the local IPC endpoint '${path}' (a Unix domain socket or named pipe) is not available: ` +
        'orivon.net reaches TCP and UDP peers only, and a host filesystem endpoint has no capability to grant.'))
    })
    return this
  }

  /** The one place a resolved TcpSocket becomes this instance's live handle, for connect() and fromAccepted() alike. */
  private attachHandle (handle: TcpSocket): void {
    this.handle = handle
    this.remoteAddress = handle.remoteAddress
    this.remotePort = handle.remotePort
    this.localAddress = handle.localAddress
    this.localPort = handle.localPort
    this.reader = handle.readable.getReader()
    this.writer = handle.writable.getWriter()
    this.connectPromise = Promise.resolve(handle)
    // A reset or revocation rejects `closed` as well as the streams; the
    // streams are what report it, so this copy must not go unhandled.
    handle.closed.catch(() => {})
    if (this.pendingNoDelay !== undefined) this.setNoDelay(this.pendingNoDelay)
    if (this.pendingKeepAlive !== undefined) this.setKeepAlive(this.pendingKeepAlive.enable, this.pendingKeepAlive.initialDelay)
    this.maybePump()
  }

  /**
   * Wraps an ALREADY-CONNECTED handle -- net.createServer's accepted
   * connections (node-net-server.ts) -- without connect()'s dial or its
   * 'connect' event: real Node's server-side sockets never fire 'connect'.
   */
  static fromAccepted (handle: TcpSocket, opts: SocketOptions = {}): Socket {
    const socket = new Socket(opts)
    socket.attachHandle(handle)
    return socket
  }

  override _read (): void {
    this.wantsRead = true
    this.maybePump()
  }

  private maybePump (): void {
    if (this.reader === null || !this.wantsRead || this.pumping) return
    this.wantsRead = false
    this.pumping = true
    this.reader.read().then(({ done, value }) => {
      this.pumping = false
      if (done) { this.push(null); return }
      this.bytesRead += value.length
      this.refreshIdleTimer()
      // true: still below the high-water mark, pull the next chunk now.
      // false: wait for _read(), which fires once a consumer drains.
      if (this.push(value)) {
        this.wantsRead = true
        this.maybePump()
      }
    }, (error: unknown) => {
      this.pumping = false
      this.destroy(toNodeError(error, { syscall: 'read' }))
    })
  }

  override _write (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let bytes: Uint8Array
    try {
      bytes = toBytes(chunk)
    } catch (error) {
      callback(error as Error)
      return
    }
    const promise = this.connectPromise
    if (promise === null) { callback(socketClosedError()); return }
    this.refreshIdleTimer()
    promise.then(async (handle) => { await (this.writer ?? handle.writable.getWriter()).write(bytes) }).then(() => {
      this.written += bytes.length
      this.refreshIdleTimer()
      callback()
    }, (error: unknown) => callback(toNodeError(error, { syscall: 'write' })))
  }

  override _final (callback: (error?: Error | null) => void): void {
    const promise = this.connectPromise
    if (promise === null) { callback(); return }
    // A failed connect already destroyed this socket with the real error;
    // _final has nothing to add to it.
    promise.then(async () => { await this.writer?.close() }, () => {})
      .then(() => callback(), (error: unknown) => callback(toNodeError(error, { syscall: 'shutdown' })))
  }

  /** Idempotent, as Node's is: readable-stream 3 re-emits 'error' when a destroyed stream is destroyed again with one. */
  override destroy (error?: Error): this {
    if (this.destroyed) return this
    return super.destroy(error)
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearIdleTimer()
    this.hadError = error !== null
    this.connecting = false
    const handle = this.handle
    if (handle === null) { callback(error); return }
    // An errored or reset destroy puts an RST on the wire; a clean one is
    // socket.close() (FIN). handle-contracts.md's TcpSocket close table.
    const writer = this.writer
    const teardown = (error !== null || this.resetOnDestroy) && writer !== null
      ? writer.abort(error ?? socketClosedError())
      : handle.close()
    teardown.catch(() => {})
      .then(async () => { await handle.close() })
      .catch(() => {})
      .then(() => callback(error))
  }

  /** readable-stream emits 'close' bare; Node's net.Socket listeners receive `hadError`. */
  override emit (event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'close' && args.length === 0) return super.emit('close', this.hadError)
    return super.emit(event, ...args)
  }

  /** Node's idle timeout: 'timeout' fires after `msecs` with no read or write, once per idle period, and never destroys. 0 disables it. */
  setTimeout (msecs: number, callback?: () => void): this {
    if (typeof msecs !== 'number' || !Number.isFinite(msecs) || msecs < 0) {
      throw codedError(RangeError, 'ERR_OUT_OF_RANGE',
        `The value of "msecs" is out of range. It must be a non-negative finite number. Received ${String(msecs)}`)
    }
    this.timeout = msecs
    if (msecs === 0) {
      this.clearIdleTimer()
      if (callback !== undefined) this.removeListener('timeout', callback)
      return this
    }
    if (callback !== undefined) this.once('timeout', callback)
    this.refreshIdleTimer()
    return this
  }

  private refreshIdleTimer (): void {
    this.clearIdleTimer()
    const msecs = this.timeout
    if (msecs === undefined || msecs === 0 || this.destroyed) return
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = undefined
      this.emit('timeout')
    }, msecs)
  }

  private clearIdleTimer (): void {
    if (this.idleTimer !== undefined) globalThis.clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Synchronous and chainable, as in Node; applied to the handle once connected. */
  setNoDelay (noDelay = true): this {
    if (this.handle === null) this.pendingNoDelay = noDelay
    else this.handle.setNoDelay(noDelay).catch(() => {})
    return this
  }

  setKeepAlive (enable = false, initialDelay = 0): this {
    if (this.handle === null) this.pendingKeepAlive = { enable, initialDelay }
    else this.handle.setKeepAlive(enable, initialDelay).catch(() => {})
    return this
  }

  /** Real Node's event-loop keep-alive controls: no libuv handle exists here, so both are no-ops returning `this`, exactly Node's contract. */
  ref (): this { return this }
  unref (): this { return this }

  /** Sends an RST instead of a FIN, once connected. */
  resetAndDestroy (): this {
    if (this.handle !== null) {
      this.resetOnDestroy = true
      this.destroy()
    } else if (this.connecting) {
      this.once('connect', () => { this.resetOnDestroy = true; this.destroy() })
    } else {
      this.destroy(socketClosedError())
    }
    return this
  }

  /** The local end, as Node reports it: `{}` until connected. */
  address (): { address: string, family: string, port: number } | Record<string, never> {
    if (this.handle === null || this.localAddress === undefined || this.localPort === undefined) return {}
    return { address: this.localAddress, family: familyOf(this.localAddress) ?? 'IPv4', port: this.localPort }
  }

  get remoteFamily (): 'IPv4' | 'IPv6' | undefined { return familyOf(this.remoteAddress) }
  get localFamily (): 'IPv4' | 'IPv6' | undefined { return familyOf(this.localAddress) }
  get bytesWritten (): number { return this.written }
  get pending (): boolean { return this.handle === null || this.connecting }

  get readyState (): 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed' {
    if (this.connecting) return 'opening'
    if (this.readable && this.writable) return 'open'
    if (this.readable) return 'readOnly'
    if (this.writable) return 'writeOnly'
    return 'closed'
  }
}

/** The options net.connect()/createConnection() read before handing the rest to socket.connect(). */
export function socketOptionsFrom (options: ConnectTarget, dial: NetDialFn): SocketOptions {
  const picked: SocketOptions = { [kDial]: dial }
  if (typeof options.allowHalfOpen === 'boolean') picked.allowHalfOpen = options.allowHalfOpen
  if (options.signal !== undefined) picked.signal = options.signal as AbortSignal
  if (options.noDelay === true) picked.noDelay = true
  if (options.keepAlive === true) picked.keepAlive = true
  if (typeof options.keepAliveInitialDelay === 'number') picked.keepAliveInitialDelay = options.keepAliveInitialDelay
  return picked
}

/** net.connect()/net.createConnection(): construct a Socket and connect it in one call, with Node's overloads and its `timeout` option. */
export function createConnectFactory (dial: NetDialFn): (...args: readonly unknown[]) => Socket {
  return function connect (...args: readonly unknown[]): Socket {
    const { options, callback } = normalizeConnectArgs(args)
    const socket = new Socket(socketOptionsFrom(options, dial))
    if (typeof options.timeout === 'number') socket.setTimeout(options.timeout)
    return socket.connect(options, callback)
  }
}
