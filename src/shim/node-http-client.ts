// ClientRequest and the request()/get() factory shared by node-http.ts and
// node-https.ts -- the only difference between the two modules is which
// orivon.net method connects and which port defaults, both supplied by the
// caller here, never read from a global.
//
// SCOPE, NOT AN OVERSIGHT: request bodies are buffered in full and sent with
// a computed Content-Length once `.end()` is called -- there is no chunked
// *request* encoding. Real callers here are tracker announces and small API
// bodies (see README.md's binding requirement 1 and this file's own PR),
// never a streamed upload, so buffering is simpler and never wrong for the
// shape of body this queue item targets. `.write()` still works; it just
// accumulates rather than flushing incrementally.
//
// EVERY SOCKET IS ONE REQUEST: no Agent, no keep-alive, no pooling.
// `Connection: close` is sent unless the caller overrides it, and the
// TcpSocket is closed once the response completes. Reusing a connection
// across requests is future work with no confirmed caller asking for it yet.

import { Writable } from 'stream'
import type { TcpSocket } from '../contracts/handles.js'
import { HeaderBag, type HeaderValue, serializeRequestHead, defaultHostHeader } from './node-http-headers.js'
import { HttpResponseParser, concatBytes } from './node-http-parser.js'
import { IncomingMessage } from './node-http-message.js'
import { toNodeError } from './node-http-errors.js'
import { toBytes } from './node-stream-bytes.js'

export type ConnectFn = (opts: { host: string, port: number }) => Promise<TcpSocket>

export interface RequestOptions {
  host?: string
  hostname?: string
  port?: number | string
  path?: string
  method?: string
  headers?: Record<string, HeaderValue>
}

interface ResolvedOptions {
  host: string
  port: number
  path: string
  method: string
  headers: HeaderBag
}

/** A body written before Content-Length is required to carry one, matching common REST convention. */
const BODYFUL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export class ClientRequest extends Writable {
  readonly method: string
  readonly path: string
  socket: TcpSocket | null = null

  private readonly headers: HeaderBag
  private readonly host: string
  private readonly port: number
  private readonly connectPromise: Promise<TcpSocket>
  private readonly bodyChunks: Uint8Array[] = []

  constructor (connect: ConnectFn, opts: ResolvedOptions, private readonly defaultPort: number) {
    super()
    this.method = opts.method
    this.path = opts.path
    this.headers = opts.headers
    this.host = opts.host
    this.port = opts.port
    // Wrapped in an async IIFE rather than called bare: `connect` can throw
    // synchronously (getOrivon() does, when window.orivon is not present
    // yet), and every other failure in this class surfaces through the
    // 'error' event, never a throw out of the constructor. This makes that
    // true for this failure too, instead of being the one exception.
    this.connectPromise = (async () => connect({ host: opts.host, port: opts.port }))()
    // _final is the real handler; this only stops an unhandled-rejection
    // warning if the request is destroyed before end() ever calls it.
    this.connectPromise.catch(() => {})
  }

  setHeader (name: string, value: HeaderValue): this {
    this.headers.set(name, value)
    return this
  }

  getHeader (name: string): HeaderValue | undefined {
    return this.headers.get(name)
  }

  removeHeader (name: string): void {
    this.headers.remove(name)
  }

  override _write (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.bodyChunks.push(toBytes(chunk))
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _final (callback: (error?: Error | null) => void): void {
    this.send(callback).catch(callback)
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket?.close().catch(() => {})
    callback(error)
  }

  // Both catches below hand the mapped error to `callback` and stop --
  // never also `this.emit('error', ...)` here. A Writable's own machinery
  // already emits 'error' (and destroys the stream) when `_final`'s
  // callback receives one; emitting it a second time ourselves fired it
  // twice, and the second fire had no listener left to catch it.
  private async send (callback: (error?: Error | null) => void): Promise<void> {
    let socket: TcpSocket
    try {
      socket = await this.connectPromise
    } catch (error) {
      callback(toNodeError(error))
      return
    }
    this.socket = socket
    this.emit('socket', socket)

    const body = this.bodyChunks.reduce(concatBytes, new Uint8Array(0))
    this.applyDefaultHeaders(body.length)
    const head = serializeRequestHead(this.method, this.path, this.headers)

    const writer = socket.writable.getWriter()
    try {
      await writer.write(head)
      if (body.length > 0) await writer.write(body)
      await writer.close()
    } catch (error) {
      callback(toNodeError(error))
      return
    }

    this.readResponse(socket)
    callback()
  }

  private applyDefaultHeaders (bodyLength: number): void {
    if (!this.headers.has('host')) {
      this.headers.set('Host', defaultHostHeader(this.host, this.port, this.defaultPort))
    }
    if (!this.headers.has('connection')) this.headers.set('Connection', 'close')
    if (!this.headers.has('content-length') && !this.headers.has('transfer-encoding')) {
      if (bodyLength > 0 || BODYFUL_METHODS.has(this.method)) {
        this.headers.set('Content-Length', String(bodyLength))
      }
    }
  }

  private readResponse (socket: TcpSocket): void {
    const res = new IncomingMessage()
    res._setSocket(socket)
    let headEmitted = false

    const parser = new HttpResponseParser({
      onHead: (head) => {
        res._setHead(head)
        headEmitted = true
        this.emit('response', res)
      },
      onBody: (chunk) => { res._pushBody(chunk) },
      onComplete: () => {
        res._pushEnd()
        socket.close().catch(() => {})
      },
      onError: (error) => {
        if (headEmitted) res.emit('error', error); else this.emit('error', error)
      }
    }, { method: this.method })

    const reader = socket.readable.getReader()
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) { parser.end(); return }
          parser.write(value)
        }
      } catch (error) {
        const nodeError = toNodeError(error)
        if (headEmitted) res.emit('error', nodeError); else this.emit('error', nodeError)
      }
    })()
  }
}

function resolveOptions (defaultPort: number, args: readonly unknown[]): { options: ResolvedOptions, callback?: (res: IncomingMessage) => void } {
  let raw: RequestOptions = {}
  const [first, second, third] = args

  if (typeof first === 'string' || first instanceof URL) {
    const url = typeof first === 'string' ? new URL(first) : first
    raw.hostname = url.hostname
    if (url.port !== '') raw.port = url.port
    raw.path = `${url.pathname}${url.search}`
    if (second !== undefined && typeof second !== 'function') Object.assign(raw, second)
  } else {
    raw = { ...(first as RequestOptions | undefined) }
  }

  const callback = [second, third].find((value): value is (res: IncomingMessage) => void => typeof value === 'function')

  const headers = new HeaderBag()
  headers.setAll(raw.headers)
  const options: ResolvedOptions = {
    host: raw.hostname ?? raw.host ?? 'localhost',
    port: raw.port !== undefined ? Number(raw.port) : defaultPort,
    path: raw.path ?? '/',
    method: (raw.method ?? 'GET').toUpperCase(),
    headers
  }
  const result: { options: ResolvedOptions, callback?: (res: IncomingMessage) => void } = { options }
  if (callback !== undefined) result.callback = callback
  return result
}

export function createHttpModule (moduleOpts: { connect: ConnectFn, defaultPort: number }): {
  request: (...args: readonly unknown[]) => ClientRequest
  get: (...args: readonly unknown[]) => ClientRequest
} {
  function request (...args: readonly unknown[]): ClientRequest {
    const { options, callback } = resolveOptions(moduleOpts.defaultPort, args)
    const req = new ClientRequest(moduleOpts.connect, options, moduleOpts.defaultPort)
    if (callback !== undefined) req.once('response', callback)
    return req
  }

  function get (...args: readonly unknown[]): ClientRequest {
    const req = request(...args)
    req.end()
    return req
  }

  return { request, get }
}
