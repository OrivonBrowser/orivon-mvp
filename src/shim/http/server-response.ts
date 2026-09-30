// ServerResponse: an OutgoingMessage that speaks the status line, for one
// request. The server builds it with the request it answers; the request
// decides whether a body is allowed (HEAD) and which framing an HTTP/1.0
// client can take.

import { OutgoingMessage, headersSentError } from './outgoing-message.js'
import { STATUS_CODES } from './status-codes.js'
import { validateHeaderName, validateHeaderValue } from './header-validation.js'
import { codedError } from '../node-errors.js'
import type { HeaderValue } from './headers.js'
import type { IncomingMessage } from './message.js'

type HeaderInput = Record<string, HeaderValue | undefined> | readonly HeaderValue[] | readonly (readonly [string, HeaderValue])[]
type WriteCallback = (error?: Error | null) => void

const TE_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i
const INVALID_STATUS_MESSAGE_CHARACTER = /[^\t\x20-\x7e\x80-\xff]/

export class ServerResponse extends OutgoingMessage {
  statusCode = 200
  statusMessage: string | undefined = undefined
  readonly req: IncomingMessage

  constructor (req: IncomingMessage) {
    super()
    this.req = req
    this.sendDate = true
    if (req.method === 'HEAD') this._hasBody = false
    // An HTTP/1.0 client is answered in HTTP/1.1 syntax, but only chunked when it says it can take it.
    if (req.httpVersionMajor < 1 || (req.httpVersionMajor === 1 && req.httpVersionMinor < 1)) {
      this.useChunkedEncodingByDefault = TE_CHUNKED.test(String(req.headers.te ?? ''))
      this.shouldKeepAlive = false
    }
  }

  override _implicitHeader (): void {
    this.writeHead(this.statusCode)
  }

  writeHead (statusCode: number, headers?: HeaderInput): this
  writeHead (statusCode: number, statusMessage?: string, headers?: HeaderInput): this
  writeHead (statusCode: number, reasonOrHeaders?: string | HeaderInput, maybeHeaders?: HeaderInput): this {
    if (this._header !== null) throw headersSentError('write')
    const code = Number(statusCode) | 0
    if (code < 100 || code > 999) {
      throw codedError(RangeError, 'ERR_HTTP_INVALID_STATUS_CODE', `Invalid status code: ${String(statusCode)}`)
    }
    let headers = maybeHeaders
    if (typeof reasonOrHeaders === 'string') {
      if (INVALID_STATUS_MESSAGE_CHARACTER.test(reasonOrHeaders)) throw codedError(TypeError, 'ERR_INVALID_CHAR', 'Invalid character in statusMessage')
      this.statusMessage = reasonOrHeaders
    } else {
      this.statusMessage ??= STATUS_CODES[code] ?? 'unknown'
      headers ??= reasonOrHeaders
    }
    this.statusCode = code
    if (headers !== undefined && headers !== null) this.applyHeaders(headers)
    if (code === 204 || code === 304 || (code >= 100 && code <= 199)) this._hasBody = false
    this._storeHeader(`HTTP/1.1 ${String(code)} ${this.statusMessage}\r\n`)
    return this
  }

  /** An object sets each header; a flat array of name, value pairs (or an array of pairs) keeps explicit duplicates but replaces what was set before. */
  private applyHeaders (headers: HeaderInput): void {
    if (!Array.isArray(headers)) {
      for (const [name, value] of Object.entries(headers as Record<string, HeaderValue | undefined>)) {
        if (value !== undefined) this.setHeader(name, value)
      }
      return
    }
    const pairs = headers.length > 0 && Array.isArray(headers[0])
      ? headers as readonly (readonly [string, HeaderValue])[]
      : this.pairUp(headers as readonly HeaderValue[])
    for (const [name] of pairs) this.headerBag.remove(name)
    for (const [name, value] of pairs) this.appendHeader(name, value)
  }

  private pairUp (flat: readonly HeaderValue[]): [string, HeaderValue][] {
    if (flat.length % 2 !== 0) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'headers' is invalid. Received an odd number of header entries")
    const pairs: [string, HeaderValue][] = []
    for (let i = 0; i < flat.length; i += 2) {
      validateHeaderName(flat[i])
      validateHeaderValue(String(flat[i]), flat[i + 1])
      pairs.push([String(flat[i]), flat[i + 1] as HeaderValue])
    }
    return pairs
  }

  writeContinue (callback?: WriteCallback): void {
    this._writeRaw('HTTP/1.1 100 Continue\r\n\r\n', callback)
  }

  writeProcessing (callback?: WriteCallback): void {
    this._writeRaw('HTTP/1.1 102 Processing\r\n\r\n', callback)
  }

  writeEarlyHints (hints: Record<string, HeaderValue>, callback?: WriteCallback): void {
    let lines = 'HTTP/1.1 103 Early Hints\r\n'
    for (const [name, value] of Object.entries(hints)) {
      validateHeaderName(name)
      validateHeaderValue(name, value)
      for (const one of Array.isArray(value) ? value as string[] : [value]) lines += `${name}: ${String(one)}\r\n`
    }
    this._writeRaw(`${lines}\r\n`, callback)
  }
}
