// http.Server: net.Server with an HTTP/1.1 request loop on every accepted
// connection (http/server-connection.ts). It is a net.Server, as Node's is, so
// `server instanceof net.Server` holds and listen()/address()/getConnections()
// are the shim's own.
//
// close() waits for the connections that are still answering a request, as
// Node's does, by holding back the net.Server's close until the last one is
// gone: closing the net.Server at once would take every accepted socket down
// with it (net/server.ts). Idle connections are closed straight away.

import { Server as NetServer, type NetListenFn } from '../net/server.js'
import { getOrivon } from '../orivon-global.js'
import { HttpConnection, type HttpServerHost } from './server-connection.js'
import { IncomingMessage } from './message.js'
import { ServerResponse } from './server-response.js'
import { MAX_HEADER_SIZE } from './request-parser.js'
import type { Socket } from '../net/socket.js'

/** How a server listens. Absent, it is orivon.net.listen, looked up when listen() runs, never at construction. */
export const kListen: unique symbol = Symbol('orivon-node-shim.listen')

export interface HttpServerOptions {
  IncomingMessage?: typeof IncomingMessage
  ServerResponse?: typeof ServerResponse
  keepAliveTimeout?: number
  headersTimeout?: number
  requestTimeout?: number
  timeout?: number
  connectionsCheckingInterval?: number
  requireHostHeader?: boolean
  maxHeaderSize?: number
  noDelay?: boolean
  keepAlive?: boolean
  keepAliveInitialDelay?: number
  [kListen]?: NetListenFn
  [option: string]: unknown
}

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void

export class Server extends NetServer implements HttpServerHost {
  timeout: number
  keepAliveTimeout: number
  headersTimeout: number
  requestTimeout: number
  requireHostHeader: boolean
  maxHeaderSize: number
  /** Stored, never read: this server has no periodic sweep to pace, and it applies no header-count or request-count limit. */
  connectionsCheckingInterval: number
  maxHeadersCount: number | null = null
  maxRequestsPerSocket = 0
  readonly requestClasses: { readonly IncomingMessage: typeof IncomingMessage, readonly ServerResponse: typeof ServerResponse }

  private readonly active = new Set<HttpConnection>()
  private closeRequested = false
  private closeIssued = false
  private closeCallback: ((error?: Error) => void) | undefined

  constructor (listener?: RequestListener)
  constructor (options: HttpServerOptions, listener?: RequestListener)
  constructor (optionsOrListener?: HttpServerOptions | RequestListener, maybeListener?: RequestListener) {
    const options: HttpServerOptions = typeof optionsOrListener === 'function' ? {} : optionsOrListener ?? {}
    const listener = typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener
    super(options[kListen] ?? ((opts) => getOrivon().net.listen(opts)), {
      allowHalfOpen: true,
      noDelay: options.noDelay ?? true,
      ...(options.keepAlive === true ? { keepAlive: true } : {}),
      ...(typeof options.keepAliveInitialDelay === 'number' ? { keepAliveInitialDelay: options.keepAliveInitialDelay } : {})
    })
    this.timeout = options.timeout ?? 0
    this.keepAliveTimeout = options.keepAliveTimeout ?? 5000
    this.headersTimeout = options.headersTimeout ?? 60000
    this.requestTimeout = options.requestTimeout ?? 300000
    this.connectionsCheckingInterval = options.connectionsCheckingInterval ?? 30000
    this.requireHostHeader = options.requireHostHeader ?? true
    this.maxHeaderSize = options.maxHeaderSize ?? MAX_HEADER_SIZE
    this.requestClasses = { IncomingMessage: options.IncomingMessage ?? IncomingMessage, ServerResponse: options.ServerResponse ?? ServerResponse }
    this.on('connection', (socket: Socket) => this.attach(socket))
    if (listener !== undefined) this.on('request', listener)
  }

  get stopping (): boolean { return this.closeRequested }

  override get listening (): boolean { return super.listening && !this.closeRequested }

  override listen (...args: readonly unknown[]): this {
    this.closeRequested = false
    this.closeIssued = false
    return super.listen(...args)
  }

  override address (): { address: string, port: number, family: string } | null {
    return this.closeRequested ? null : super.address()
  }

  private attach (socket: Socket): void {
    if (this.closeRequested) { socket.destroy(); return }
    this.active.add(new HttpConnection(this, socket))
  }

  connectionClosed (connection: HttpConnection): void {
    this.active.delete(connection)
    this.closeWhenDrained()
  }

  /** Stops listening once the connections still answering a request are done; idle ones close now. */
  override close (callback?: (error?: Error) => void): this {
    if (!super.listening || this.closeRequested) return super.close(callback)
    this.closeRequested = true
    this.closeCallback = callback
    this.closeIdleConnections()
    this.closeWhenDrained()
    return this
  }

  private closeWhenDrained (): void {
    if (!this.closeRequested || this.closeIssued || this.active.size > 0) return
    this.closeIssued = true
    super.close(this.closeCallback)
  }

  closeIdleConnections (): void {
    for (const connection of [...this.active]) connection.closeIdle()
  }

  closeAllConnections (): void {
    for (const connection of [...this.active]) connection.socket.destroy()
  }

  setTimeout (msecs = 0, callback?: () => void): this {
    this.timeout = msecs
    if (callback !== undefined) this.on('timeout', callback)
    return this
  }
}

export function createServer (optionsOrListener?: HttpServerOptions | RequestListener, listener?: RequestListener): Server {
  return typeof optionsOrListener === 'function' || optionsOrListener === undefined
    ? new Server(optionsOrListener)
    : new Server(optionsOrListener, listener)
}
