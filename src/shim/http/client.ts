// ClientRequest and the request()/get() factory shared by http/http.ts and
// http/https.ts. A request travels over a real net.Socket (a TLSSocket for
// https, or whatever `createConnection` returns), so 'socket', 'upgrade'
// and `res.socket` hand the app the same kind of object Node would.
//
// REQUEST BODIES are buffered until end() and sent with a computed
// Content-Length, unless flushHeaders() or an Expect header commits the
// head first; later writes then stream, chunked where Node would chunk.
//
// ONE CONNECTION PER REQUEST, whatever agent is passed: `Connection: close`
// is sent unless the caller sets Connection, and the socket is closed once
// the response completes. The request never half-closes its own side after
// the body: a FIN there reads as an abort to some servers.

import { Writable, type Duplex } from 'stream'
import { Buffer } from 'buffer'
import { serializeRequestHead, defaultHostHeader, type HeaderBag, type HeaderValue } from './headers.js'
import { HttpResponseParser, concatBytes, type ParsedResponseHead } from './parser.js'
import { IncomingMessage } from './message.js'
import { abortError, codedError, connResetError, toNodeError } from '../node-errors.js'
import { toBytes } from '../stream-bytes.js'
import { Socket, kDial, type NetDialFn } from '../net/socket.js'
import { resolveRequestOptions, type ResolvedRequestOptions } from './options.js'

export type ConnectFn = NetDialFn
export type RequestSocket = Duplex & {
  setTimeout?: (msecs: number) => unknown
  setNoDelay?: (noDelay?: boolean) => unknown
  setKeepAlive?: (enable?: boolean, initialDelay?: number) => unknown
}
export type SocketFactory = (options: ResolvedRequestOptions, dial: NetDialFn) => RequestSocket

/** Node's useChunkedEncodingByDefault is false for these: a flushed head without Content-Length sends later bytes raw. */
const NO_CHUNKING_BY_DEFAULT = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])
/** Methods that get Content-Length even for an empty body, matching common REST convention. */
const BODYFUL_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const LAST_CHUNK = new TextEncoder().encode('0\r\n\r\n')

function chunkFrame (bytes: Uint8Array): Uint8Array {
  const size = new TextEncoder().encode(`${bytes.length.toString(16)}\r\n`)
  return [size, bytes, new Uint8Array([13, 10])].reduce(concatBytes)
}

function informationOf (head: ParsedResponseHead): Record<string, unknown> {
  const [major, minor] = head.httpVersion.split('.')
  return {
    statusCode: head.statusCode,
    statusMessage: head.statusMessage,
    httpVersion: head.httpVersion,
    httpVersionMajor: Number(major),
    httpVersionMinor: Number(minor),
    headers: head.headers,
    rawHeaders: head.rawHeaders
  }
}

export class ClientRequest extends Writable {
  readonly method: string
  readonly path: string
  readonly host: string
  readonly protocol: string
  readonly agent: unknown
  socket: RequestSocket | null = null
  res: IncomingMessage | null = null
  aborted = false
  readonly reusedSocket = false

  private readonly headers: HeaderBag
  private headSent = false
  private framing: 'buffered' | 'raw' | 'chunked' = 'buffered'
  private readonly buffered: Uint8Array[] = []
  private readonly queued: Array<{ bytes: Uint8Array, done: (() => void) | undefined }> = []
  private readonly socketHandlers: Array<[string, (...args: never[]) => void]> = []
  private readonly parser: HttpResponseParser
  private upgraded = false
  private completed = false
  private timeoutMs: number | undefined
  private detachSignal: (() => void) | undefined

  /** `obtainSocket` runs once, synchronously; `createConnection` may instead hand the socket back through its callback. */
  constructor (options: ResolvedRequestOptions, obtainSocket: () => RequestSocket) {
    // autoDestroy stays off: Node's ClientRequest emits 'close' when the
    // whole exchange is over, not when the request body has been sent.
    super({ autoDestroy: false, emitClose: true })
    this.method = options.method
    this.path = options.path
    this.host = options.host
    this.protocol = options.protocol
    this.agent = options.agent
    this.headers = options.headers
    if (options.setHost && !this.headers.has('host')) {
      this.headers.set('Host', defaultHostHeader(options.host, options.port, options.defaultPort))
    }
    if (options.auth !== undefined && !this.headers.has('authorization')) {
      this.headers.set('Authorization', `Basic ${Buffer.from(options.auth).toString('base64')}`)
    }
    this.parser = new HttpResponseParser({
      onInformation: (head) => this.onInformation(head),
      onHead: (head) => this.onResponseHead(head),
      onBody: (chunk) => { if (this.res !== null && !this.res._pushBody(chunk)) this.socket?.pause() },
      onComplete: () => this.onResponseComplete(),
      onError: (error) => this.onParseError(error),
      onUpgrade: (head, rest) => this.onUpgrade(head, rest)
    }, { method: this.method })
    if (options.timeout !== undefined) this.setTimeout(options.timeout)
    this.watchSignal(options.signal)
    if (this.headers.has('expect')) this.flushHeaders()
    this.startSocket(options, obtainSocket)
  }

  private startSocket (options: ResolvedRequestOptions, obtainSocket: () => RequestSocket): void {
    const createConnection = options.createConnection
    if (createConnection === undefined) {
      const socket = obtainSocket()
      queueMicrotask(() => this.onSocket(socket))
      return
    }
    let settled = false
    const returned = createConnection({ ...options.raw, host: options.host, port: options.port }, (error, socket) => {
      if (settled) return
      settled = true
      if (error !== null) this.destroy(toNodeError(error))
      else this.onSocket(socket as RequestSocket)
    })
    if (!settled && typeof returned === 'object' && returned !== null) {
      settled = true
      queueMicrotask(() => this.onSocket(returned as RequestSocket))
    }
  }

  private watchSignal (signal: AbortSignal | undefined): void {
    if (signal === undefined) return
    const onAbort = (): void => { this.destroy(abortError(signal.reason)) }
    if (signal.aborted) { queueMicrotask(onAbort); return }
    signal.addEventListener('abort', onAbort, { once: true })
    this.detachSignal = () => signal.removeEventListener('abort', onAbort)
  }

  private onSocket (socket: RequestSocket): void {
    if (this.destroyed) { socket.destroy(); return }
    this.socket = socket
    this.listen(socket, 'data', (chunk: Uint8Array) => this.parser.write(chunk))
    this.listen(socket, 'end', () => this.parser.end())
    this.listen(socket, 'error', (error: unknown) => this.fail(toNodeError(error)))
    this.listen(socket, 'close', () => { if (!this.completed && !this.upgraded) this.onPrematureClose() })
    this.listen(socket, 'timeout', () => { if (this.timeoutMs !== undefined && !this.destroyed) this.emit('timeout') })
    if (this.timeoutMs !== undefined) socket.setTimeout?.(this.timeoutMs)
    this.emit('socket', socket)
    for (const { bytes, done } of this.queued.splice(0)) this.writeToSocket(socket, bytes, done)
  }

  private listen (socket: RequestSocket, event: string, handler: (...args: never[]) => void): void {
    socket.on(event, handler as (...args: unknown[]) => void)
    this.socketHandlers.push([event, handler])
  }

  private detachSocket (): void {
    const socket = this.socket
    if (socket === null) return
    for (const [event, handler] of this.socketHandlers.splice(0)) socket.removeListener(event, handler as (...args: unknown[]) => void)
  }

  /** Socket write failures are reported once, by the socket's own 'error'; a callback here never carries one. */
  private writeToSocket (socket: RequestSocket, bytes: Uint8Array, done: (() => void) | undefined): void {
    socket.write(bytes, () => done?.())
  }

  private send (bytes: Uint8Array, done?: () => void): void {
    if (this.socket === null) this.queued.push({ bytes, done })
    else this.writeToSocket(this.socket, bytes, done)
  }

  /** Serialises the head, choosing the body framing: Content-Length for a buffered body, Node's chunking rule otherwise. */
  private takeHead (bufferedLength: number | null): Uint8Array {
    if (!this.headers.has('connection')) this.headers.set('Connection', 'close')
    const hasLength = this.headers.has('content-length')
    const chunked = /chunked/i.test(String(this.headers.get('transfer-encoding') ?? ''))
    if (bufferedLength !== null) {
      this.framing = chunked ? 'chunked' : 'buffered'
      if (!hasLength && !chunked && (bufferedLength > 0 || BODYFUL_METHODS.has(this.method))) {
        this.headers.set('Content-Length', String(bufferedLength))
      }
    } else if (hasLength || NO_CHUNKING_BY_DEFAULT.has(this.method)) {
      this.framing = chunked ? 'chunked' : 'raw'
    } else {
      if (!chunked) this.headers.set('Transfer-Encoding', 'chunked')
      this.framing = 'chunked'
    }
    this.headSent = true
    return serializeRequestHead(this.method, this.path, this.headers)
  }

  private frame (bytes: Uint8Array): Uint8Array {
    return this.framing === 'chunked' ? chunkFrame(bytes) : bytes
  }

  flushHeaders (): void {
    if (this.headSent) return
    this.send(this.takeHead(null))
    for (const bytes of this.buffered.splice(0)) this.send(this.frame(bytes))
  }

  override _write (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let bytes: Uint8Array
    try {
      bytes = toBytes(chunk)
    } catch (error) {
      callback(error as Error)
      return
    }
    if (!this.headSent) { this.buffered.push(bytes); callback(); return }
    if (bytes.length === 0) { callback(); return }
    this.send(this.frame(bytes), () => callback())
  }

  override _final (callback: (error?: Error | null) => void): void {
    if (!this.headSent) {
      const body = this.buffered.splice(0).reduce(concatBytes, new Uint8Array(0))
      const head = this.takeHead(body.length)
      if (body.length === 0) { this.send(head, () => callback()); return }
      this.send(head)
      this.send(this.frame(body), this.framing === 'chunked' ? undefined : () => callback())
      if (this.framing === 'chunked') this.send(LAST_CHUNK, () => callback())
      return
    }
    if (this.framing === 'chunked') this.send(LAST_CHUNK, () => callback())
    else callback()
  }

  private onInformation (head: ParsedResponseHead): void {
    if (head.statusCode === 100) this.emit('continue')
    this.emit('information', informationOf(head))
  }

  private onResponseHead (head: ParsedResponseHead): void {
    const res = new IncomingMessage(this.socket)
    res._setHead(head)
    res.req = this
    this.res = res
    // Node dumps a response nobody listens for, so its socket still drains.
    if (!this.emit('response', res)) res.resume()
  }

  private onResponseComplete (): void {
    this.completed = true
    this.res?._pushEnd()
    this.detachSocket()
    this.socket?.destroy()
    this.destroy()
  }

  /** 'upgrade' (or 'connect') hands the socket over, detached from this request, with the bytes read past the head. */
  private onUpgrade (head: ParsedResponseHead, rest: Uint8Array): void {
    const socket = this.socket
    if (socket === null) return
    const res = new IncomingMessage(socket)
    res._setHead(head)
    res.req = this
    res.upgrade = true
    res.complete = true
    this.res = res
    this.detachSocket()
    const event = this.method === 'CONNECT' ? 'connect' : 'upgrade'
    if (this.listenerCount(event) === 0) {
      socket.destroy()
      this.destroy()
      return
    }
    this.upgraded = true
    // Unset "flowing" so the new owner's first 'data' listener starts the
    // flow; until then, bytes wait in the socket's buffer rather than being
    // emitted to nobody.
    ;(socket as { readableFlowing: boolean | null }).readableFlowing = null
    this.emit(event, res, socket, Buffer.from(rest))
    this.destroy()
  }

  private onParseError (error: Error & { code: string }): void {
    if (error.code === 'HPE_PREMATURE_EOF') this.onPrematureClose()
    else this.fail(error)
  }

  /** The socket ended or closed before the response did: 'socket hang up' before a response, an aborted response during one. */
  private onPrematureClose (): void {
    if (this.res === null) this.fail(connResetError('socket hang up'))
    else this.destroy()
  }

  private fail (error: Error): void {
    this.destroy(error)
  }

  /** Idempotent, as Node's is; a second destroy must never surface a second 'error'. */
  override destroy (error?: Error): this {
    if (this.destroyed) return this
    return super.destroy(error)
  }

  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    this.detachSignal?.()
    let reported = error
    if (reported === null && this.res === null && !this.aborted) reported = connResetError('socket hang up')
    if (this.res !== null && !this.res.complete) this.res.destroy(connResetError('aborted'))
    if (!this.upgraded) {
      this.detachSocket()
      this.socket?.destroy()
    }
    callback(reported)
  }

  abort (): void {
    if (this.aborted) return
    this.aborted = true
    queueMicrotask(() => this.emit('abort'))
    this.destroy()
  }

  /** Arms the socket's idle timer; 'timeout' only notifies, and the caller decides whether to destroy, as in Node. */
  setTimeout (msecs: number, callback?: () => void): this {
    if (callback !== undefined) this.once('timeout', callback)
    this.timeoutMs = msecs
    this.socket?.setTimeout?.(msecs)
    return this
  }

  setNoDelay (noDelay = true): void { this.withSocket((socket) => socket.setNoDelay?.(noDelay)) }
  setSocketKeepAlive (enable = false, initialDelay = 0): void { this.withSocket((socket) => socket.setKeepAlive?.(enable, initialDelay)) }

  private withSocket (use: (socket: RequestSocket) => void): void {
    if (this.socket !== null) use(this.socket)
    else this.once('socket', use)
  }

  private assertHeadNotSent (verb: 'set' | 'remove'): void {
    if (this.headSent) throw codedError(Error, 'ERR_HTTP_HEADERS_SENT', `Cannot ${verb} headers after they are sent to the client`)
  }

  setHeader (name: string, value: HeaderValue): this {
    this.assertHeadNotSent('set')
    this.headers.set(name, value)
    return this
  }

  removeHeader (name: string): void {
    this.assertHeadNotSent('remove')
    this.headers.remove(name)
  }

  getHeader (name: string): HeaderValue | undefined { return this.headers.get(name) }
  getHeaders (): Record<string, HeaderValue> { return this.headers.toObject() }
  getHeaderNames (): string[] { return this.headers.names() }
  getRawHeaderNames (): string[] { return this.headers.rawNames() }
  hasHeader (name: string): boolean { return this.headers.has(name) }
  get headersSent (): boolean { return this.headSent }
  get connection (): RequestSocket | null { return this.socket }
}

function plainSocket (options: ResolvedRequestOptions, dial: NetDialFn): RequestSocket {
  return new Socket({ [kDial]: dial }).connect({ host: options.host, port: options.port })
}

export interface HttpModuleOptions {
  /** Dials one connection: orivon.net.connect for http, connectSecure for https. */
  readonly connect: NetDialFn
  readonly defaultPort: number
  readonly protocol?: 'http:' | 'https:'
  /** Builds the socket a request travels over; a plain net.Socket unless given. */
  readonly createSocket?: SocketFactory
}

export function createHttpModule (moduleOpts: HttpModuleOptions): {
  request: (...args: readonly unknown[]) => ClientRequest
  get: (...args: readonly unknown[]) => ClientRequest
} {
  const defaults = { protocol: moduleOpts.protocol ?? 'http:', defaultPort: moduleOpts.defaultPort }
  const createSocket = moduleOpts.createSocket ?? plainSocket

  function request (...args: readonly unknown[]): ClientRequest {
    const { options, callback } = resolveRequestOptions(args, defaults)
    const req = new ClientRequest(options, () => createSocket(options, moduleOpts.connect))
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
