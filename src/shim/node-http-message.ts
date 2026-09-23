// IncomingMessage: a real Node `stream.Readable` subclass, so `.pipe()`,
// `.setEncoding()` and every other Readable method work as they do on
// Node's own IncomingMessage.
//
// BACKPRESSURE: node-http-client.ts pushes body bytes through `_pushBody`
// and pauses the socket when it returns false; `_read` resumes it once a
// consumer drains. A slow consumer therefore slows the socket, and through
// it the broker's credit window, instead of buffering the whole body here.
//
// autoDestroy/emitClose are explicit for the same reason as
// node-net-socket.ts's: readable-stream 3 defaults autoDestroy to false.

import { Readable, type Duplex } from 'stream'
import type { ParsedResponseHead } from './node-http-parser.js'

type ResponseSocket = Duplex & {
  remoteAddress?: string
  remotePort?: number
  setTimeout?: (msecs: number, callback?: () => void) => unknown
}

export class IncomingMessage extends Readable {
  statusCode: number | null = null
  statusMessage: string | null = null
  httpVersion = ''
  httpVersionMajor = 0
  httpVersionMinor = 0
  headers: Readonly<Record<string, string | readonly string[]>> = {}
  rawHeaders: readonly string[] = []
  trailers: Readonly<Record<string, string>> = {}
  rawTrailers: readonly string[] = []
  complete = false
  aborted = false
  upgrade = false
  url = ''
  method: string | null = null
  /** The net.Socket (a TLSSocket for https) this response arrived over. */
  socket: ResponseSocket | null
  req: unknown = null

  constructor (socket: ResponseSocket | null = null) {
    super({ autoDestroy: true, emitClose: true })
    this.socket = socket
  }

  get connection (): ResponseSocket | null { return this.socket }

  override _read (): void {
    // An upgrade response owns no bytes: its socket now belongs to whoever
    // took the 'upgrade' event, and resuming it here would drop their data.
    if (!this.upgrade) this.socket?.resume()
  }

  /** node-http-client.ts calls this once, when the parser finishes the status line and headers. */
  _setHead (head: ParsedResponseHead): void {
    this.statusCode = head.statusCode
    this.statusMessage = head.statusMessage
    this.httpVersion = head.httpVersion
    const [major, minor] = head.httpVersion.split('.')
    this.httpVersionMajor = Number(major)
    this.httpVersionMinor = Number(minor)
    this.headers = head.headers
    this.rawHeaders = head.rawHeaders
  }

  /** False once the consumer is behind: the caller pauses the socket until `_read` resumes it. */
  _pushBody (chunk: Uint8Array): boolean {
    return this.push(chunk)
  }

  _pushEnd (): void {
    this.complete = true
    this.push(null)
  }

  setTimeout (msecs: number, callback?: () => void): this {
    this.socket?.setTimeout?.(msecs, callback)
    return this
  }

  /** Idempotent, as Node's is: readable-stream 3 re-emits 'error' on a second errored destroy. */
  override destroy (error?: Error): this {
    if (this.destroyed) return this
    return super.destroy(error)
  }

  /**
   * An unfinished response is 'aborted', and takes its socket down with it,
   * as Node's does. The error reaches 'error' only when someone listens:
   * Node's own backward-compatible rule, and what keeps a response the app
   * never attached a handler to from throwing an uncaught 'aborted'.
   */
  override _destroy (error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.complete) {
      this.aborted = true
      this.emit('aborted')
      if (this.socket !== null && !this.socket.destroyed) this.socket.destroy()
    }
    callback(this.listenerCount('error') > 0 ? error : null)
  }
}
