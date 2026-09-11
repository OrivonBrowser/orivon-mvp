// IncomingMessage: a real Node `stream.Readable` subclass, not a hand-rolled
// EventEmitter -- so `.pipe()`, `.setEncoding()` and every other Readable
// method a real caller might use work for free, exactly as they do on
// Node's own IncomingMessage (which is the same subclass relationship).
//
// BACKPRESSURE, NARROWED ON PURPOSE: `_read` is a no-op, and the parser
// feeds `_pushBody` eagerly as bytes arrive from the underlying TcpSocket,
// rather than propagating this Readable's own high-water mark back to the
// socket reader. Correct and simple for the REST/tracker-sized responses
// this queue item targets; a bulk-transfer consumer (torrent piece data)
// reads a TcpSocket directly today and is unaffected. Flagged in the PR
// rather than built now -- no confirmed caller needs a bounded buffer here.

import { Readable } from 'stream'
import type { ParsedResponseHead } from './node-http-parser.js'
import type { TcpSocket } from '../contracts/handles.js'

export class IncomingMessage extends Readable {
  statusCode: number | null = null
  statusMessage: string | null = null
  httpVersion = ''
  headers: Readonly<Record<string, string | readonly string[]>> = {}
  rawHeaders: readonly string[] = []
  complete = false
  /**
   * The real TcpSocket this response arrived over -- not a fake, and not a
   * Node net.Socket lookalike. node-https.ts's header already documents the
   * gap this implies: `res.socket.getPeerCertificate()` and friends are not
   * here, because the broker terminates TLS and there is no certificate to
   * hand back. What IS real: `remoteAddress`/`remotePort`/etc, the same
   * fields every caller reading `res.socket` for connection info wants.
   */
  socket: TcpSocket | null = null

  override _read (): void {
    // Intentionally empty -- see this file's header.
  }

  /** node-http-client.ts calls this once, when the socket that will carry the response is known -- before any bytes have necessarily arrived. */
  _setSocket (socket: TcpSocket): void {
    this.socket = socket
  }

  /** node-http-client.ts calls this once, when the parser finishes the status line and headers. */
  _setHead (head: ParsedResponseHead): void {
    this.statusCode = head.statusCode
    this.statusMessage = head.statusMessage
    this.httpVersion = head.httpVersion
    this.headers = head.headers
    this.rawHeaders = head.rawHeaders
  }

  _pushBody (chunk: Uint8Array): void {
    this.push(chunk)
  }

  _pushEnd (): void {
    this.complete = true
    this.push(null)
  }
}
