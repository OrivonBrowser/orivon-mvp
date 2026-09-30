// One accepted connection of an http.Server: it feeds the socket's bytes to a
// request parser, builds the IncomingMessage and ServerResponse of each
// request, and keeps the connection to one request at a time.
//
// SEQUENTIAL BY DESIGN. A request is answered before the next one on the same
// connection is parsed: bytes a pipelining client sent behind a request wait
// in `backlog` (the socket is paused once that grows) until the response has
// finished. A response that finishes before its request body was read
// discards the rest of the body, as Node does, so the next request is reached.
//
// The socket stays in flowing mode for the whole connection, which is how a
// peer's FIN or reset is noticed while a handler is still working.

import type { EventEmitter } from 'events'
import { Buffer } from 'buffer'
import { concatBytes } from './parser.js'
import { CONNECTION_CLOSE, CONNECTION_KEEP_ALIVE, CONNECTION_UPGRADE } from './header-tokens.js'
import { HttpRequestParser, type ParsedRequestHead } from './request-parser.js'
import type { IncomingMessage } from './message.js'
import type { ServerResponse } from './server-response.js'
import { codedError, connResetError } from '../node-errors.js'
import type { Socket } from '../net/socket.js'

/** What a connection needs from its server: the timeouts, the classes to build, and the events to raise. */
export interface HttpServerHost extends EventEmitter {
  timeout: number
  keepAliveTimeout: number
  headersTimeout: number
  requestTimeout: number
  requireHostHeader: boolean
  maxHeaderSize: number
  readonly requestClasses: { readonly IncomingMessage: typeof IncomingMessage, readonly ServerResponse: typeof ServerResponse }
  readonly stopping: boolean
  connectionClosed (connection: HttpConnection): void
}

/** Bytes held for a pipelined request before the socket is paused. */
const BACKLOG_LIMIT = 64 * 1024
type Timer = ReturnType<typeof setTimeout>

function keepsConnectionAlive (head: ParsedRequestHead): boolean {
  const connection = String(head.headers.connection ?? '')
  return head.httpVersion === '1.0' ? CONNECTION_KEEP_ALIVE.test(connection) && !CONNECTION_CLOSE.test(connection) : !CONNECTION_CLOSE.test(connection)
}

function refusalFor (code: string | undefined): string {
  const status = code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request'
  return `HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`
}

export class HttpConnection {
  private parser: HttpRequestParser | null = null
  private req: IncomingMessage | null = null
  private res: ServerResponse | null = null
  private requestDone = false
  private responseFinished = false
  private backlog: Uint8Array[] = []
  private backlogBytes = 0
  private hold = false
  private failed = false
  private upgraded = false
  private gone = false
  private headersTimer: Timer | undefined
  private requestTimer: Timer | undefined
  private keepAliveTimer: Timer | undefined

  constructor (private readonly host: HttpServerHost, readonly socket: Socket) {
    ;(socket as { server?: unknown }).server = host
    socket.on('data', this.onData)
    socket.on('end', this.onEnd)
    socket.on('error', this.onError)
    socket.on('timeout', this.onTimeout)
    socket.on('close', this.onClose)
    if (host.timeout > 0) socket.setTimeout(host.timeout)
    this.startHeadersClock()
  }

  /** Not in the middle of a request, and not waiting to send a response. */
  get idle (): boolean {
    return !this.gone && !this.upgraded && this.req === null && this.parser?.midMessage !== true && this.backlogBytes === 0
  }

  /** Bytes read from the socket that belong to requests after the current one. Read by tests, through `kConnections`. */
  get heldBytes (): number { return this.backlogBytes }

  closeIdle (): void { if (this.idle) this.socket.destroy() }

  private readonly onData = (chunk: Uint8Array): void => {
    if (this.gone || this.upgraded || this.failed) return
    if (this.hold) {
      this.backlog.push(chunk)
      this.backlogBytes += chunk.length
      if (this.backlogFull) this.socket.pause()
      return
    }
    this.feed(chunk)
  }

  private get backlogFull (): boolean { return this.backlogBytes > BACKLOG_LIMIT }

  /** A reader wants request bytes: read on, unless the bytes held for later requests are already over the cap. */
  private readonly resumeUnlessFull = (): void => {
    if (!this.backlogFull) this.socket.resume()
  }

  private feed (chunk: Uint8Array): void {
    if (this.parser === null) {
      this.parser = this.newParser()
      this.startRequestClock()
    }
    const parser = this.parser
    parser.write(chunk)
    if (this.gone || this.upgraded || this.failed) return
    if (parser.finished) {
      const rest = parser.takeRest()
      this.backlog = rest.length > 0 ? [rest] : []
      this.backlogBytes = rest.length
      this.parser = null
      this.hold = true
      this.settle()
    }
  }

  private newParser (): HttpRequestParser {
    return new HttpRequestParser({
      onHead: (head) => this.onHead(head),
      onBody: (chunk) => {
        const req = this.req
        if (req !== null && !req.destroyed && !req._pushBody(chunk)) this.socket.pause()
      },
      onTrailers: (lines) => this.req?._setTrailers(lines),
      onComplete: () => {
        this.requestDone = true
        this.stopTimer('requestTimer')
        this.req?._pushEnd()
      },
      onError: (error) => this.clientError(error),
      isUpgrade: (head) => this.isUpgrade(head),
      onUpgrade: (head, rest) => this.onUpgrade(head, rest)
    }, { maxHeaderSize: this.host.maxHeaderSize })
  }

  private isUpgrade (head: ParsedRequestHead): boolean {
    if (head.method === 'CONNECT') return true
    return head.headers.upgrade !== undefined && CONNECTION_UPGRADE.test(String(head.headers.connection ?? '')) && this.host.listenerCount('upgrade') > 0
  }

  private onHead (head: ParsedRequestHead): void {
    this.stopTimer('headersTimer')
    const { IncomingMessage: RequestClass, ServerResponse: ResponseClass } = this.host.requestClasses
    const req = new RequestClass(this.socket)
    req._setRequestHead(head)
    req._onRead = this.resumeUnlessFull
    const res = new ResponseClass(req)
    res.shouldKeepAlive = keepsConnectionAlive(head)
    res._keepAliveTimeout = this.host.keepAliveTimeout
    res.assignSocket(this.socket)
    res.once('finish', () => this.onResponseFinish(res))
    this.req = req
    this.res = res
    this.requestDone = false
    this.responseFinished = false

    if (this.host.requireHostHeader && head.httpVersion === '1.1' && head.headers.host === undefined) {
      res.writeHead(400, ['Connection', 'close'])
      res.end()
      return
    }
    const expect = head.headers.expect
    if (expect === undefined || head.httpVersion === '1.0') this.raise('request', req, res)
    else if (/^100-continue$/i.test(String(expect))) this.answerContinue(req, res)
    else if (this.host.listenerCount('checkExpectation') > 0) this.raise('checkExpectation', req, res)
    else { res.writeHead(417); res.end() }
  }

  private answerContinue (req: IncomingMessage, res: ServerResponse): void {
    if (this.host.listenerCount('checkContinue') > 0) { this.raise('checkContinue', req, res); return }
    res.writeContinue()
    this.raise('request', req, res)
  }

  /** An app listener that throws is an uncaught error, but must not leave this connection half-parsed. */
  private raise (event: string, ...args: unknown[]): void {
    try {
      this.host.emit(event, ...args)
    } catch (error) {
      queueMicrotask(() => { throw error })
    }
  }

  private onResponseFinish (res: ServerResponse): void {
    if (res !== this.res) return
    this.responseFinished = true
    if (res._last) { this.hold = true; this.destroySoon(); return }
    const req = this.req
    if (req !== null && !this.requestDone && !req._consuming) req.resume()
    this.settle()
  }

  /** Both halves of the current request are done: close, or go on to the next one. */
  private settle (): void {
    if (this.req === null || !this.requestDone || !this.responseFinished) return
    const last = this.res?._last === true
    this.req = null
    this.res = null
    this.requestDone = false
    this.responseFinished = false
    if (last || this.host.stopping) { this.hold = true; this.destroySoon(); return }
    this.hold = false
    const pending = this.takeBacklog()
    this.socket.resume()
    if (pending.length > 0) this.feed(pending)
    else this.armKeepAlive()
  }

  private takeBacklog (): Uint8Array {
    const chunks = this.backlog
    this.backlog = []
    this.backlogBytes = 0
    return chunks.length === 1 ? chunks[0] as Uint8Array : chunks.reduce(concatBytes, new Uint8Array(0))
  }

  private onUpgrade (head: ParsedRequestHead, rest: Uint8Array): void {
    this.upgraded = true
    this.clearTimers()
    const event = head.method === 'CONNECT' ? 'connect' : 'upgrade'
    const socket = this.socket
    for (const [name, listener] of [['data', this.onData], ['end', this.onEnd], ['error', this.onError], ['timeout', this.onTimeout]] as const) {
      socket.removeListener(name, listener)
    }
    socket.setTimeout(0)
    // Node hands the socket over unread: nothing is delivered until the app attaches a listener or resumes it.
    const state = (socket as unknown as { _readableState?: { flowing: boolean | null } })._readableState
    if (state !== undefined) state.flowing = null
    const req = new this.host.requestClasses.IncomingMessage(socket)
    req._setRequestHead(head)
    req.upgrade = true
    req._pushEnd()
    if (event === 'connect' && this.host.listenerCount('connect') === 0) { socket.destroy(); return }
    this.raise(event, req, socket, Buffer.from(rest))
  }

  private clientError (error: Error & { code?: string }): void {
    if (this.failed || this.gone) return
    this.failed = true
    this.hold = true
    this.clearTimers()
    if (this.host.listenerCount('clientError') > 0) { this.raise('clientError', error, this.socket); return }
    // Node's test is whether the current response's head went out, not whether the connection ever wrote: a bad request behind a good one is still answered.
    if (this.res?._headerSent !== true) this.socket.write(refusalFor(error.code))
    this.destroySoon()
  }

  /**
   * The peer's FIN. As Node's server does not keep a half-open connection, a
   * request still waiting for its response is aborted and the socket ends; a
   * request cut off part-way gets the clientError treatment instead.
   */
  private readonly onEnd = (): void => {
    if (this.gone || this.upgraded || this.failed) return
    if (this.parser?.midMessage === true) { this.clientError(codedError(Error, 'HPE_INVALID_EOF_STATE', 'Parse Error')); return }
    this.hold = true
    if (this.req !== null && !this.responseFinished) this.req.destroy(connResetError('aborted'))
    this.socket.end()
  }

  private readonly onError = (error: Error): void => {
    if (this.host.listenerCount('clientError') > 0) this.raise('clientError', error, this.socket)
    else this.socket.destroy()
  }

  /** Node's order: the request while it is still arriving, the response, then the server; nobody handling it closes the socket. */
  private readonly onTimeout = (): void => {
    const req = this.req
    const handledByRequest = req !== null && !this.requestDone && req.emit('timeout', this.socket)
    const handledByResponse = this.res?.emit('timeout', this.socket) === true
    const handledByServer = this.host.emit('timeout', this.socket)
    if (!handledByRequest && !handledByResponse && !handledByServer) this.socket.destroy()
  }

  private readonly onClose = (): void => {
    this.gone = true
    this.clearTimers()
    this.res?._socketClosed()
    const req = this.req
    if (req !== null && !req.complete) req.destroy(connResetError('aborted'))
    this.host.connectionClosed(this)
  }

  /** The end of a connection Node closes once its writes are flushed. */
  private destroySoon (): void {
    this.clearTimers()
    const socket = this.socket
    socket.end(() => socket.destroy())
  }

  /** Node measures the first request's headers from the connection's start, so a connection that never speaks is answered 408. */
  private startHeadersClock (): void {
    if (this.headersTimer === undefined && this.host.headersTimeout > 0) this.headersTimer = setTimeout(() => this.expire(), this.host.headersTimeout)
  }

  private startRequestClock (): void {
    this.stopTimer('keepAliveTimer')
    this.startHeadersClock()
    if (this.host.requestTimeout > 0) this.requestTimer = setTimeout(() => this.expire(), this.host.requestTimeout)
  }

  private expire (): void {
    this.clientError(codedError(Error, 'ERR_HTTP_REQUEST_TIMEOUT', 'Request timeout'))
  }

  private armKeepAlive (): void {
    this.stopTimer('keepAliveTimer')
    if (this.host.keepAliveTimeout > 0) this.keepAliveTimer = setTimeout(() => this.socket.destroy(), this.host.keepAliveTimeout)
  }

  private stopTimer (name: 'headersTimer' | 'requestTimer' | 'keepAliveTimer'): void {
    clearTimeout(this[name])
    this[name] = undefined
  }

  private clearTimers (): void {
    this.stopTimer('headersTimer')
    this.stopTimer('requestTimer')
    this.stopTimer('keepAliveTimer')
  }
}
