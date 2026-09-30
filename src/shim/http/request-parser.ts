// The request half of the HTTP/1.1 parser: a request line and header block on
// top of http/parser.ts's shared body framing. The server feeds it one
// connection's bytes; each request is a fresh parser, and `takeRest()` hands
// back what a pipelined client sent behind it.
//
// Strictness follows Node's own parser: an unknown method, a version other than
// 1.0 and 1.1, a header without a colon or with a space before it, folded
// headers, a repeated Content-Length, and a body length given twice all fail
// with llhttp's HPE_* names, which the server answers with 400 (431 for an
// oversized head).

import { METHODS } from './status-codes.js'
import {
  CRLFCRLF, HttpMessageParser, combineHeaders, indexOfSubarray,
  type HttpBodyCallbacks, type ParserState
} from './parser.js'

/** Node's `http.maxHeaderSize`. */
export const MAX_HEADER_SIZE = 16 * 1024

/** Headers Node keeps only the first value of when a request repeats them. */
const DISCRETE_HEADERS: ReadonlySet<string> = new Set([
  'age', 'authorization', 'content-length', 'content-type', 'etag', 'expires', 'from', 'host',
  'if-modified-since', 'if-unmodified-since', 'last-modified', 'location', 'max-forwards',
  'proxy-authorization', 'referer', 'retry-after', 'server', 'user-agent'
])

const KNOWN_METHODS: ReadonlySet<string> = new Set(METHODS)
const REQUEST_LINE = /^([A-Za-z-]+) (\S+) HTTP\/(\d)\.(\d)$/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const CONTROL_CHARACTER = /[\0\r\n]/

export interface ParsedRequestHead {
  readonly method: string
  readonly url: string
  readonly httpVersion: string
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly rawHeaders: readonly string[]
}

export interface HttpRequestParserCallbacks extends HttpBodyCallbacks {
  onHead(head: ParsedRequestHead): void
  /**
   * Asked once per head. True hands the connection over: parsing stops and
   * `onUpgrade` receives the bytes that followed the head. Absent or false,
   * an `Upgrade` header is an ordinary request's header, as Node treats one
   * nobody listens for.
   */
  isUpgrade?(head: ParsedRequestHead): boolean
  onUpgrade?(head: ParsedRequestHead, rest: Uint8Array): void
}

type ParseFailure = readonly [message: string, code: string]

export class HttpRequestParser extends HttpMessageParser {
  private readonly maxHeaderSize: number

  constructor (private readonly cb: HttpRequestParserCallbacks, options: { readonly maxHeaderSize?: number } = {}) {
    super(cb)
    this.maxHeaderSize = options.maxHeaderSize ?? MAX_HEADER_SIZE
  }

  protected override tryParseHead (): boolean {
    this.skipLeadingBlankLines()
    const idx = indexOfSubarray(this.buf, CRLFCRLF)
    if (idx === -1 ? this.buf.length > this.maxHeaderSize : idx > this.maxHeaderSize) {
      this.fail(`request head exceeded ${this.maxHeaderSize} bytes`, 'HPE_HEADER_OVERFLOW')
      return false
    }
    if (idx === -1) return false

    const headText = new TextDecoder('latin1').decode(this.buf.subarray(0, idx))
    this.buf = this.buf.subarray(idx + 4)
    const lines = headText.split('\r\n')

    const requestLine = REQUEST_LINE.exec(lines[0] ?? '')
    const failure = requestLine === null ? malformedRequestLine(lines[0] ?? '') : this.checkRequestLine(requestLine)
    if (requestLine === null || failure !== undefined) {
      const [message, code] = failure ?? ['malformed request line', 'HPE_INVALID_METHOD']
      this.fail(message, code)
      return false
    }

    const headerFailure = checkHeaderLines(lines.slice(1))
    if (headerFailure !== undefined) { this.fail(headerFailure[0], headerFailure[1]); return false }

    const { headers, rawHeaders } = combineHeaders(lines.slice(1), { discrete: DISCRETE_HEADERS, cookieJoin: '; ' })
    const head: ParsedRequestHead = {
      method: requestLine[1] ?? '', url: requestLine[2] ?? '', httpVersion: `${requestLine[3] ?? ''}.${requestLine[4] ?? ''}`, headers, rawHeaders
    }
    const framing = decideFraming(headers, rawHeaders)
    if ('code' in framing) { this.fail(framing.message, framing.code); return false }

    if (this.cb.isUpgrade?.(head) === true) {
      this.state = { kind: 'done' }
      this.cb.onUpgrade?.(head, this.takeRest())
      return false
    }
    // The state is set before the app's listener runs, so a listener that throws leaves a parser that is still coherent.
    this.state = framing
    this.cb.onHead(head)
    if (framing.kind === 'done') this.cb.onComplete()
    return true
  }

  /** llhttp skips CRLFs a client left between two requests. */
  private skipLeadingBlankLines (): void {
    let skip = 0
    while (this.buf[skip] === 13 && this.buf[skip + 1] === 10) skip += 2
    if (skip > 0) this.buf = this.buf.subarray(skip)
  }

  private checkRequestLine (match: RegExpExecArray): ParseFailure | undefined {
    if (!KNOWN_METHODS.has(match[1] ?? '')) return [`unknown method ${JSON.stringify(match[1])}`, 'HPE_INVALID_METHOD']
    const version = `${match[3] ?? ''}.${match[4] ?? ''}`
    if (version !== '1.0' && version !== '1.1') return [`unsupported HTTP version ${version}`, 'HPE_INVALID_VERSION']
    return undefined
  }
}

function malformedRequestLine (line: string): ParseFailure {
  const method = line.split(' ', 1)[0] ?? ''
  return KNOWN_METHODS.has(method) ? [`malformed request line ${JSON.stringify(line)}`, 'HPE_INVALID_URL'] : [`unknown method ${JSON.stringify(method)}`, 'HPE_INVALID_METHOD']
}

function checkHeaderLines (lines: readonly string[]): ParseFailure | undefined {
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon === -1 || !HEADER_NAME.test(line.slice(0, colon)) || CONTROL_CHARACTER.test(line)) {
      return [`malformed header line ${JSON.stringify(line)}`, 'HPE_INVALID_HEADER_TOKEN']
    }
  }
  return undefined
}

function decideFraming (
  headers: Readonly<Record<string, string | readonly string[]>>,
  rawHeaders: readonly string[]
): ParserState | { readonly message: string, readonly code: string } {
  const contentLengths = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length').length
  const transferEncoding = headers['transfer-encoding']
  const contentLength = headers['content-length']
  if (transferEncoding !== undefined) {
    if (contentLength !== undefined) return { message: 'both Content-Length and Transfer-Encoding', code: 'HPE_UNEXPECTED_CONTENT_LENGTH' }
    const codings = String(transferEncoding).split(',').map((coding) => coding.trim().toLowerCase())
    if (codings[codings.length - 1] !== 'chunked') return { message: 'a request body must end in the chunked coding', code: 'HPE_INVALID_TRANSFER_ENCODING' }
    return { kind: 'body-chunk-size' }
  }
  if (contentLength === undefined) return { kind: 'done' }
  if (contentLengths > 1) return { message: 'duplicate Content-Length', code: 'HPE_UNEXPECTED_CONTENT_LENGTH' }
  if (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength)) return { message: 'invalid Content-Length', code: 'HPE_INVALID_CONTENT_LENGTH' }
  const length = Number(contentLength)
  return length === 0 ? { kind: 'done' } : { kind: 'body-length', remaining: length }
}
