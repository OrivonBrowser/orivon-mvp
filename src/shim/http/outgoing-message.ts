// OutgoingMessage: the header store and the write/end machinery a server
// response stands on -- Node's own base of ServerResponse, with the same
// underscore-named internals (`_header`, `_hasBody`, `_last`, `_implicitHeader`)
// that middleware reaches for. Not a stream.Writable: Node's is a legacy
// `Stream` with write()/end()/'drain'/'finish', and that is the shape kept.
//
// The message goes out over the socket the server hands it. Its head is written
// with the first bytes that follow it (one socket write for a small response),
// chunk framing is added when no length was given, and `write()` answers the
// socket's own backpressure: false once the socket is behind, 'drain' when it
// catches up.

import { Stream, type Duplex } from 'stream'
import { Buffer } from 'buffer'
import { HeaderBag, type HeaderValue } from './headers.js'
import { validateHeaderName, validateHeaderValue } from './header-validation.js'
import { codedError } from '../node-errors.js'
import { toBytesJoined } from '../stream-bytes.js'

export type OutgoingSocket = Duplex & { cork?: () => void, uncork?: () => void, setTimeout?: (msecs: number, callback?: () => void) => unknown }
type WriteCallback = (error?: Error | null) => void

/** Below this a head and its body go out as one socket write; above it the body is not copied. */
const COALESCE_LIMIT = 64 * 1024
const CONNECTION_CLOSE = /(?:^|\W)close(?:$|\W)/i
const TE_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i
const LAST_CHUNK = '0\r\n'
const NOOP = (): void => {}

export function headersSentError (verb: 'set' | 'remove' | 'append' | 'write'): Error {
  return codedError(Error, 'ERR_HTTP_HEADERS_SENT', `Cannot ${verb} headers after they are sent to the client`)
}

function encodeChunk (chunk: string | Uint8Array, encoding: BufferEncoding | undefined): Uint8Array {
  if (typeof chunk !== 'string') return chunk
  return encoding === undefined || encoding === 'utf8' || (encoding as string) === 'utf-8'
    ? new TextEncoder().encode(chunk)
    : Buffer.from(chunk, encoding)
}

function checkChunk (chunk: unknown): asserts chunk is string | Uint8Array {
  if (chunk === null) throw codedError(TypeError, 'ERR_STREAM_NULL_VALUES', 'May not write null values to stream')
  if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
    const received = typeof chunk === 'object' ? `an instance of ${(chunk as object).constructor?.name ?? 'Object'}` : `type ${typeof chunk} (${String(chunk)})`
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "chunk" argument must be of type string or an instance of Buffer or Uint8Array. Received ${received}`)
  }
}

interface HeaderState { connection: boolean, contentLength: boolean, transferEncoding: boolean, date: boolean, trailer: boolean }

export class OutgoingMessage extends Stream {
  sendDate = false
  shouldKeepAlive = true
  useChunkedEncodingByDefault = true
  chunkedEncoding = false
  finished = false
  strictContentLength = false
  writable = true
  destroyed = false
  socket: OutgoingSocket | null = null
  /** The head as it will be written, set once headers are stored; `headersSent` is whether it exists. */
  _header: string | null = null
  _headerSent = false
  _hasBody = true
  /** The connection closes once this message is written. */
  _last = false
  _closed = false
  /** Milliseconds advertised as `Keep-Alive: timeout=`, when the server keeps the connection. */
  _keepAliveTimeout = 0

  protected readonly headerBag = new HeaderBag()
  private contentLength: number | null = null
  private removedContentLength = false
  private removedTransferEncoding = false
  private trailer = ''
  private pendingWrites = 0
  private needDrain = false
  private finishEmitted = false
  private lastChunkQueued = false
  private readonly onSocketDrain = (): void => {
    if (!this.needDrain) return
    this.needDrain = false
    this.emit('drain')
  }

  get connection (): OutgoingSocket | null { return this.socket }
  get headersSent (): boolean { return this._header !== null }
  get writableEnded (): boolean { return this.finished }
  get writableLength (): number { return this.socket?.writableLength ?? 0 }
  get writableHighWaterMark (): number { return this.socket?.writableHighWaterMark ?? 16384 }
  get writableNeedDrain (): boolean { return !this.destroyed && !this.finished && this.needDrain }
  get writableFinished (): boolean { return this.finished && this.pendingWrites === 0 && !this.destroyed }

  /** Called by the server once, before anything is written. */
  assignSocket (socket: OutgoingSocket): void {
    this.socket = socket
    socket.on('drain', this.onSocketDrain)
  }

  /** The socket now belongs to whoever takes it; nothing more is written to it. */
  detachSocket (): void {
    this.socket?.removeListener('drain', this.onSocketDrain)
    this.socket = null
  }

  _implicitHeader (): void {
    throw codedError(Error, 'ERR_METHOD_NOT_IMPLEMENTED', 'The _implicitHeader() method is not implemented')
  }

  setHeader (name: string, value: HeaderValue): this {
    if (this._header !== null) throw headersSentError('set')
    validateHeaderName(name)
    validateHeaderValue(name, value)
    this.headerBag.set(name, value)
    return this
  }

  appendHeader (name: string, value: HeaderValue): this {
    if (this._header !== null) throw headersSentError('append')
    validateHeaderName(name)
    validateHeaderValue(name, value)
    this.headerBag.append(name, value)
    return this
  }

  /** Node's `setHeaders` takes a `Headers` or a `Map`. */
  setHeaders (headers: Iterable<readonly [string, HeaderValue]>): this {
    if (this._header !== null) throw headersSentError('set')
    if (typeof headers?.[Symbol.iterator] !== 'function') {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "headers" argument must be an instance of Headers or Map.')
    }
    for (const [name, value] of headers) this.setHeader(name, value)
    return this
  }

  getHeader (name: string): HeaderValue | undefined { return this.headerBag.get(name) }
  hasHeader (name: string): boolean { return this.headerBag.has(name) }
  getHeaderNames (): string[] { return this.headerBag.names() }
  getRawHeaderNames (): string[] { return this.headerBag.rawNames() }
  getHeaders (): Record<string, HeaderValue> { return this.headerBag.toObject() }

  removeHeader (name: string): void {
    if (this._header !== null) throw headersSentError('remove')
    switch (name.toLowerCase()) {
      case 'content-length': this.removedContentLength = true; break
      case 'transfer-encoding': this.removedTransferEncoding = true; break
    }
    this.headerBag.remove(name)
  }

  addTrailers (headers: Record<string, HeaderValue>): void {
    let trailer = ''
    for (const [name, value] of Object.entries(headers)) {
      validateHeaderName(name, 'Trailer name')
      validateHeaderValue(name, value)
      for (const one of Array.isArray(value) ? value as string[] : [value]) trailer += `${name}: ${String(one)}\r\n`
    }
    this.trailer = trailer
  }

  /** Builds and stores the head: the header bag, then Date, Connection and the body framing Node adds when the app did not. */
  _storeHeader (firstLine: string): void {
    const state: HeaderState = { connection: false, contentLength: false, transferEncoding: false, date: false, trailer: false }
    let head = firstLine
    for (const { name, value } of this.headerBag.entries()) {
      for (const one of Array.isArray(value) ? value as string[] : [value]) head += `${name}: ${String(one)}\r\n`
      this.noteHeader(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value), state)
    }
    if (!state.date && this.sendDate) head += `Date: ${new Date().toUTCString()}\r\n`
    if (!state.connection) head += this.connectionLine(state)
    head += this.framingLine(state)
    this._header = `${head}\r\n`
  }

  private noteHeader (lower: string, value: string, state: HeaderState): void {
    switch (lower) {
      case 'connection':
        state.connection = true
        if (CONNECTION_CLOSE.test(value)) this._last = true
        else this.shouldKeepAlive = true
        break
      case 'transfer-encoding':
        state.transferEncoding = true
        this.removedTransferEncoding = false
        if (TE_CHUNKED.test(value)) this.chunkedEncoding = true
        break
      case 'content-length':
        state.contentLength = true
        this.removedContentLength = false
        this.contentLength = Number(value)
        break
      case 'date': state.date = true; break
      case 'trailer': state.trailer = true; break
    }
  }

  private connectionLine (state: HeaderState): string {
    if (!(this.shouldKeepAlive && (state.contentLength || this.useChunkedEncodingByDefault))) {
      this._last = true
      return 'Connection: close\r\n'
    }
    const seconds = Math.floor(this._keepAliveTimeout / 1000)
    return `Connection: keep-alive\r\n${this._keepAliveTimeout > 0 ? `Keep-Alive: timeout=${String(seconds)}\r\n` : ''}`
  }

  private framingLine (state: HeaderState): string {
    if (state.contentLength || state.transferEncoding) return ''
    if (!this._hasBody) { this.chunkedEncoding = false; return '' }
    if (!this.useChunkedEncodingByDefault) { this._last = true; return '' }
    if (!state.trailer && !this.removedContentLength && typeof this.contentLength === 'number') return `Content-Length: ${String(this.contentLength)}\r\n`
    if (!this.removedTransferEncoding) { this.chunkedEncoding = true; return 'Transfer-Encoding: chunked\r\n' }
    this._last = true
    return ''
  }

  /** Puts the head on the wire now, without waiting for the first byte of the body. */
  flushHeaders (): void {
    if (this._header === null) this._implicitHeader()
    this.sendHead(null, undefined)
  }

  write (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
    const [encoding, done] = typeof encodingOrCallback === 'function' ? [undefined, encodingOrCallback] : [encodingOrCallback, callback]
    return this.writeBody(chunk, encoding, done ?? NOOP, false)
  }

  end (chunk?: string | Uint8Array | WriteCallback | null, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): this {
    const data = typeof chunk === 'function' ? null : chunk ?? null
    const done = [chunk, encodingOrCallback, callback].find((argument): argument is WriteCallback => typeof argument === 'function')
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
    if (this.finished) {
      if (data !== null) this.writeBody(data, encoding, done ?? NOOP, true)
      else if (done !== undefined) queueMicrotask(() => done(codedError(Error, 'ERR_STREAM_ALREADY_FINISHED', 'Cannot call end after a stream was finished')))
      return this
    }
    if (done !== undefined) this.once('finish', done)
    if (data !== null) this.writeBody(data, encoding, NOOP, true)
    else if (this._header === null) { this.contentLength = 0; this._implicitHeader() }
    this.finished = true
    this.sendEnd()
    return this
  }

  private writeBody (chunk: unknown, encoding: BufferEncoding | undefined, callback: WriteCallback, fromEnd: boolean): boolean {
    checkChunk(chunk)
    const failure = this.finished
      ? codedError(Error, 'ERR_STREAM_WRITE_AFTER_END', 'write after end')
      : this.destroyed ? codedError(Error, 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed') : null
    if (failure !== null) {
      queueMicrotask(() => { if (!this.destroyed) this.emit('error', failure); callback(failure) })
      return false
    }
    const bytes = encodeChunk(chunk, encoding)
    if (this._header === null) {
      this.contentLength = fromEnd ? bytes.length : null
      this._implicitHeader()
    }
    if (!this._hasBody || bytes.length === 0) { queueMicrotask(() => callback()); return true }
    if (!this.chunkedEncoding) return this.sendHead(bytes, callback)
    // The last chunk rides with the body of an end(): one socket write for a whole small response.
    if (fromEnd) { this.lastChunkQueued = true; return this.sendHead(toBytesJoined([this.frameChunk(bytes), this.lastChunk()]), callback) }
    return this.sendHead(this.frameChunk(bytes), callback)
  }

  private lastChunk (): Uint8Array {
    return new TextEncoder().encode(`${LAST_CHUNK}${this.trailer}\r\n`)
  }

  private frameChunk (bytes: Uint8Array): Uint8Array {
    return toBytesJoined([`${bytes.length.toString(16)}\r\n`, bytes, '\r\n'])
  }

  private sendEnd (): void {
    if (this.chunkedEncoding && this._hasBody && !this.lastChunkQueued) this.sendHead(this.lastChunk(), undefined)
    else this.sendHead(null, undefined)
    queueMicrotask(() => this.checkFinished())
  }

  /** Writes `body`, preceded by the head when it has not gone out yet. */
  private sendHead (body: Uint8Array | null, callback: WriteCallback | undefined): boolean {
    const parts: Uint8Array[] = []
    if (!this._headerSent && this._header !== null) {
      this._headerSent = true
      parts.push(Buffer.from(this._header, 'latin1'))
    }
    if (body !== null) parts.push(body)
    if (parts.length === 0) { if (callback !== undefined) queueMicrotask(() => callback()); return true }
    if (parts.length === 2 && (parts[1] as Uint8Array).length > COALESCE_LIMIT) {
      const [head, rest] = parts as [Uint8Array, Uint8Array]
      this.writeSocket(head, undefined)
      return this.writeSocket(rest, callback)
    }
    return this.writeSocket(parts.length === 1 ? parts[0] as Uint8Array : toBytesJoined(parts), callback)
  }

  /** Text straight onto the socket, outside the message: an interim `100 Continue` status line. */
  _writeRaw (text: string, callback?: WriteCallback): boolean {
    return this.writeSocket(Buffer.from(text, 'latin1'), callback)
  }

  private writeSocket (bytes: Uint8Array, callback: WriteCallback | undefined): boolean {
    const socket = this.socket
    if (socket === null || socket.destroyed) {
      if (callback !== undefined) queueMicrotask(() => callback(codedError(Error, 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed')))
      return false
    }
    this.pendingWrites++
    const flushed = socket.write(bytes, (error?: Error | null) => {
      this.pendingWrites--
      callback?.(error)
      this.checkFinished()
    })
    if (!flushed) this.needDrain = true
    return flushed
  }

  /** 'finish' once end() ran and every byte has reached the socket, then the socket is let go and 'close' follows. */
  private checkFinished (): void {
    if (!this.finished || this.finishEmitted || this.pendingWrites > 0 || this.destroyed) return
    this.finishEmitted = true
    this.emit('finish')
    this.detachSocket()
    queueMicrotask(() => this._socketClosed())
  }

  /** The connection is gone, or the response is complete: 'close' once. */
  _socketClosed (): void {
    if (this._closed) return
    this._closed = true
    this.destroyed = true
    this.emit('close')
  }

  destroy (error?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    if (this.socket !== null) this.socket.destroy(error)
    else this._socketClosed()
    return this
  }

  setTimeout (msecs: number, callback?: () => void): this {
    if (callback !== undefined) this.once('timeout', callback)
    this.socket?.setTimeout?.(msecs)
    return this
  }

  cork (): void { this.socket?.cork?.() }
  uncork (): void { this.socket?.uncork?.() }
}
