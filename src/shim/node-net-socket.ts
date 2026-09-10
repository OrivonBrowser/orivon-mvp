// net.Socket, presented as a real `stream.Duplex` over the WHATWG streams
// orivon.net.connect/connectSecure return (ADR-0008) -- the same
// Node-shape-over-WHATWG-streams pattern node-http-message.ts uses for
// IncomingMessage, applied to a socket that is written to as well as read.
//
// BACKPRESSURE IS REAL HERE, unlike node-http-message.ts's IncomingMessage:
// `_read` only pulls from the underlying reader when Node's stream machinery
// asks for more, and stops the instant `push()` reports the internal buffer
// is full. IncomingMessage could take the simpler eager-push shortcut
// because REST/tracker responses are small; this class backs `.pipe()`
// chains carrying torrent piece data, where that shortcut would defeat the
// whole credit-window design handle-contracts.md's Backpressure section
// specifies.
//
// CONNECT HAS NO EVENT TO WAIT FOR (handles.ts rule 4): unlike real Node,
// where a Socket exists in a "connecting" state before the OS handshake
// finishes, orivon.net.connect's Promise resolving IS the connect event.
// Every method below that needs the handle queues behind `connectPromise`
// rather than assuming `this.handle` is already set.

import { Duplex } from 'stream'
import type { TcpSocket } from '../contracts/handles.js'
import { toNodeError } from './node-http-errors.js'
import { toBytes } from './node-stream-bytes.js'

export type NetDialFn = (opts: { host: string, port: number }) => Promise<TcpSocket>

export interface SocketOptions {
  /** Default false, matching real Node: when the peer's FIN arrives, this side's writable auto-ends too, unless this is true. */
  allowHalfOpen?: boolean
}

export class Socket extends Duplex {
  remoteAddress: string | undefined
  remotePort: number | undefined
  localAddress: string | undefined
  localPort: number | undefined
  connecting = false

  private readonly dial: NetDialFn
  // Duplex already exposes `allowHalfOpen` (set via the constructor option
  // below); a second field with the same name would just shadow it and
  // trip the type checker for no benefit -- `this.allowHalfOpen` below reads
  // the base class's own property.
  private handle: TcpSocket | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private connectPromise: Promise<TcpSocket> | null = null
  private wantsRead = false
  private pumping = false

  constructor (dial: NetDialFn, opts: SocketOptions = {}) {
    super({ allowHalfOpen: opts.allowHalfOpen ?? false })
    this.dial = dial
  }

  connect (opts: { host?: string, port: number }, connectListener?: () => void): this {
    if (connectListener !== undefined) this.once('connect', connectListener)
    this.connecting = true
    const host = opts.host ?? 'localhost'
    // Wrapped in an async IIFE rather than called bare: `dial` can throw
    // synchronously (getOrivon() does, when window.orivon is not present
    // yet), and every other failure here surfaces through the 'error'
    // event, never a throw out of connect() -- node-http-client.ts's
    // ClientRequest constructor does the identical wrap for the same reason.
    const promise = (async () => this.dial({ host, port: opts.port }))()
    this.connectPromise = promise
    promise.then((handle) => {
      if (this.destroyed) { handle.close().catch(() => {}); return }
      this.handle = handle
      this.remoteAddress = handle.remoteAddress
      this.remotePort = handle.remotePort
      this.localAddress = handle.localAddress
      this.localPort = handle.localPort
      this.reader = handle.readable.getReader()
      this.writer = handle.writable.getWriter()
      this.connecting = false
      this.emit('connect')
      this.emit('ready')
      this._maybePump()
    }).catch((error) => {
      this.connecting = false
      this.destroy(toNodeError(error))
    })
    return this
  }

  override _read (): void {
    this.wantsRead = true
    this._maybePump()
  }

  private _maybePump (): void {
    if (this.reader === null || !this.wantsRead || this.pumping) return
    this.wantsRead = false
    this.pumping = true
    this.reader.read().then(({ done, value }) => {
      this.pumping = false
      if (done) {
        this.push(null)
        if (!this.allowHalfOpen) this.end()
        return
      }
      // push() returning true means the internal buffer is still below its
      // high-water mark -- pull the next chunk right away. false means a
      // consumer has not drained it yet; _read() fires again once one has.
      if (this.push(value)) {
        this.wantsRead = true
        this._maybePump()
      }
    }).catch((error) => {
      this.pumping = false
      if (!this.destroyed) this.destroy(toNodeError(error))
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
    if (promise === null) {
      callback(new Error('orivon-node-shim: net.Socket.write() called before connect()'))
      return
    }
    promise.then((handle) => {
      const writer = this.writer ?? handle.writable.getWriter()
      writer.write(bytes).then(() => callback()).catch((error) => callback(toNodeError(error)))
    }).catch((error) => callback(toNodeError(error)))
  }

  override _final (callback: (error?: Error | null) => void): void {
    const promise = this.connectPromise
    if (promise === null) { callback(); return }
    promise.then(() => {
      const writer = this.writer
      if (writer === null) { callback(); return }
      writer.close().then(() => callback()).catch((error) => callback(toNodeError(error)))
    }).catch(() => callback())
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    const handle = this.handle
    if (handle === null) { callback(error); return }
    // An errored destroy resets the wire (RST); a clean one is socket.close()
    // -- handle-contracts.md's TcpSocket close/half-close table, rows
    // `writable.abort(e)` and `socket.close()`.
    const teardown = error !== null && this.writer !== null
      ? this.writer.abort(error)
      : handle.close()
    teardown.catch(() => {}).then(() => callback(error))
  }

  async setNoDelay (on = true): Promise<this> {
    if (this.handle !== null) await this.handle.setNoDelay(on).catch(() => {})
    return this
  }

  async setKeepAlive (on = false, initialDelayMs?: number): Promise<this> {
    if (this.handle !== null) await this.handle.setKeepAlive(on, initialDelayMs).catch(() => {})
    return this
  }
}

/**
 * net.connect()/net.createConnection(): construct a Socket and connect it in
 * one call, matching real Node's factory -- and real Node's overload set:
 * `(port)`, `(port, host)`, `(port, cb)`, `(port, host, cb)`, `(options)`,
 * `(options, cb)`. The connect listener is found by scanning from the END
 * (real Node's own `normalizeArgs`), not by position, which is what lets one
 * arm cover both `(port, cb)` and `(port, host, cb)` instead of needing two.
 *
 * THE BUG THIS REPLACES: `second` was read as the listener only, so
 * `(port, host)` silently dropped `host` and dialled 'localhost' -- the
 * overload every torrent/DHT library uses (bittorrent-dht, k-rpc-socket).
 * The broker then denied the connection against 127.0.0.1, a refusal with no
 * visible connection to what the app actually asked for.
 */
export function createConnectFactory (dial: NetDialFn): (...args: readonly unknown[]) => Socket {
  return function connect (...args: readonly unknown[]): Socket {
    const [first, second] = args
    const last = args[args.length - 1]
    const connectListener = typeof last === 'function' ? last as () => void : undefined
    const opts = typeof first === 'object' && first !== null
      ? first as { host?: string, port: number, allowHalfOpen?: boolean }
      : { port: Number(first), ...(typeof second === 'string' ? { host: second } : {}) }
    const socket = opts.allowHalfOpen !== undefined ? new Socket(dial, { allowHalfOpen: opts.allowHalfOpen }) : new Socket(dial)
    if (connectListener !== undefined) socket.connect(opts, connectListener); else socket.connect(opts)
    return socket
  }
}
