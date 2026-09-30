// A byte-oriented, incremental HTTP/1.1 message parser: the body framing every
// message shares (chunked decode, Content-Length, connection-close-terminated
// bodies) lives in HttpMessageParser, and HttpResponseParser adds the response
// head; http/request-parser.ts adds the request head for the server. Pure and
// transport-free on purpose -- it knows nothing about TcpSocket, orivon.*,
// or WHATWG streams; http/client.ts feeds it bytes read from a
// TcpSocket's `readable` and its own EOF, and it drives the four callbacks
// below. Kept separate so the framing logic (chunked decode, Content-Length,
// connection-close-terminated bodies, header-combining rules) is testable
// with plain byte arrays, no fake socket required.
//
// Header-combining matches Node's own default: duplicates join with ", ",
// except `set-cookie`, which becomes an array -- the one case a real caller
// (any cookie-aware library) would notice getting collapsed into a string.
// A response keeps the ", "-joined fallback for Node's "discrete" headers
// (age, host, ... which keep only the first value); a request applies them
// (http/request-parser.ts), since a server reads `host` and `content-type` as one value.

const CRLF = [13, 10]
export const CRLFCRLF = [13, 10, 13, 10]
const MAX_HEAD_BYTES = 32 * 1024
// Bounds a single chunk-size or trailer line, mirroring Node's own
// maxHeaderSize guard. Unlike MAX_HEAD_BYTES this is checked against the
// line itself (see findLineOrFail), never against the whole buffer -- a
// legitimate large body can sit right behind an already-terminated line in
// the same write(), and bounding on total buffer length would fail that
// traffic instead of the runaway line it is meant to catch.
const MAX_LINE_BYTES = 8 * 1024

export interface ParsedResponseHead {
  readonly httpVersion: string
  readonly statusCode: number
  readonly statusMessage: string
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly rawHeaders: readonly string[]
}

export interface HttpBodyCallbacks {
  onBody(chunk: Uint8Array): void
  onComplete(): void
  /** The trailer section of a chunked body, as raw `name: value` lines, delivered just before onComplete. */
  onTrailers?(lines: readonly string[]): void
  onError(error: Error & { code: string }): void
}

export interface HttpResponseParserCallbacks extends HttpBodyCallbacks {
  onHead(head: ParsedResponseHead): void
  /** A 1xx other than an upgrade (100 Continue, 103 Early Hints); parsing carries on to the final response. */
  onInformation?(head: ParsedResponseHead): void
  /**
   * A 101 carrying an Upgrade header, or any response to CONNECT: the
   * connection now speaks another protocol, so parsing stops and `rest`
   * holds the bytes that followed the head. Without this callback such a
   * response is treated as an ordinary bodyless one.
   */
  onUpgrade?(head: ParsedResponseHead, rest: Uint8Array): void
}

export type ParserState =
  | { kind: 'head' }
  | { kind: 'body-length', remaining: number }
  | { kind: 'body-chunk-size' }
  | { kind: 'body-chunk-data', remaining: number }
  | { kind: 'body-chunk-crlf' }
  | { kind: 'body-chunk-trailer' }
  | { kind: 'body-until-close' }
  | { kind: 'done' }

export function indexOfSubarray (haystack: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Exported for http/client.ts's request-body assembly -- same idea, same function (Rule 3). */
export function concatBytes (a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** Header lines to a lowercase-keyed bag and the ordered raw list: duplicates join with ", ", `set-cookie` collects into an array. */
export function combineHeaders (lines: readonly string[], options: CombineOptions = {}): { headers: Record<string, string | string[]>, rawHeaders: string[] } {
  const headers: Record<string, string | string[]> = {}
  const rawHeaders: string[] = []
  for (const line of lines) {
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    rawHeaders.push(name, value)

    const lower = name.toLowerCase()
    const existing = headers[lower]
    if (lower === 'set-cookie') {
      headers[lower] = existing === undefined ? [value] : [...(existing as string[]), value]
    } else if (existing === undefined) {
      headers[lower] = value
    } else if (options.discrete?.has(lower) !== true) {
      headers[lower] = `${existing as string}${lower === 'cookie' && options.cookieJoin !== undefined ? options.cookieJoin : ', '}${value}`
    }
  }
  return { headers, rawHeaders }
}

export interface CombineOptions {
  /** Header names that keep only their first value, as Node does for a request. */
  readonly discrete?: ReadonlySet<string>
  /** How duplicate `cookie` headers join; Node joins a request's with "; ". */
  readonly cookieJoin?: string
}

/** The message-independent half: everything after a head, and the head's own cap on unterminated lines. */
export abstract class HttpMessageParser {
  protected buf: Uint8Array = new Uint8Array(0)
  protected state: ParserState = { kind: 'head' }
  private trailerLines: string[] = []
  private trailerBytes = 0

  /** `maxTrailerBytes` bounds the whole trailer section, as llhttp counts it against the header size. */
  constructor (private readonly bodyCb: HttpBodyCallbacks, private readonly maxTrailerBytes = MAX_HEAD_BYTES) {}

  write (chunk: Uint8Array): void {
    if (this.state.kind === 'done') return
    // Nothing held over: keep the chunk itself, so a run of pipelined requests is not re-copied for each one.
    this.buf = this.buf.length === 0 ? chunk : concatBytes(this.buf, chunk)
    this.pump()
  }

  /** True once the message is complete or has failed: further bytes are ignored until `takeRest()`. */
  get finished (): boolean { return this.state.kind === 'done' }

  /** True while a message is part-way: some of its head or body has arrived and the rest has not. */
  get midMessage (): boolean { return this.state.kind !== 'done' && (this.state.kind !== 'head' || this.buf.length > 0) }

  /** The bytes read past the end of the message, which belong to whatever follows it on the connection. */
  takeRest (): Uint8Array {
    const rest = this.buf
    this.buf = new Uint8Array(0)
    return rest
  }

  /** Parses the head at the front of `buf`; true when it consumed something and the loop should carry on. */
  protected abstract tryParseHead (): boolean

  /** `code` follows Node's llhttp names (HPE_*), so a caller branching on it sees the same values Node's parser gives. */
  protected fail (message: string, code = 'HPE_INVALID_CONSTANT'): void {
    this.state = { kind: 'done' }
    this.bodyCb.onError(Object.assign(new Error(`orivon-node-shim: ${message}`), { code }))
  }

  private pump (): void {
    let progressed = true
    while (progressed && this.state.kind !== 'done') {
      switch (this.state.kind) {
        case 'head': progressed = this.tryParseHead(); break
        case 'body-length': progressed = this.consumeLengthBody(); break
        case 'body-chunk-size': progressed = this.tryParseChunkSize(); break
        case 'body-chunk-data': progressed = this.consumeChunkData(); break
        case 'body-chunk-crlf': progressed = this.consumeChunkCrlf(); break
        case 'body-chunk-trailer': progressed = this.tryConsumeTrailerLine(); break
        case 'body-until-close': progressed = this.flushUntilCloseBody(); break
      }
    }
  }

  private consumeLengthBody (): boolean {
    if (this.state.kind !== 'body-length' || this.buf.length === 0) return false
    const take = Math.min(this.buf.length, this.state.remaining)
    this.bodyCb.onBody(this.buf.subarray(0, take))
    this.buf = this.buf.subarray(take)
    const remaining = this.state.remaining - take
    if (remaining === 0) {
      this.state = { kind: 'done' }
      this.bodyCb.onComplete()
    } else {
      this.state = { kind: 'body-length', remaining }
    }
    return true
  }

  /**
   * Finds a CRLF-terminated line, failing the parser if one grows past
   * MAX_LINE_BYTES without a terminator ever showing up. Returns -1 both
   * when more data is needed and when the parser just failed -- callers
   * only need to bail out on a negative index either way.
   */
  private findLineOrFail (label: string, limit = MAX_LINE_BYTES, code?: string): number {
    const idx = indexOfSubarray(this.buf, CRLF)
    if (idx === -1) {
      if (this.buf.length > limit) this.fail(`${label} exceeded ${limit} bytes without a terminator`, code)
      return -1
    }
    if (idx > limit) {
      this.fail(`${label} exceeded ${limit} bytes`, code)
      return -1
    }
    return idx
  }

  private tryParseChunkSize (): boolean {
    const idx = this.findLineOrFail('chunk size line')
    if (idx === -1) return false
    const line = new TextDecoder('latin1').decode(this.buf.subarray(0, idx))
    this.buf = this.buf.subarray(idx + 2)

    const sizeHex = (line.split(';')[0] ?? '').trim()
    const size = /^[0-9a-fA-F]+$/.test(sizeHex) ? parseInt(sizeHex, 16) : Number.NaN
    if (!Number.isFinite(size) || size < 0) {
      this.fail(`malformed chunk size: ${JSON.stringify(line)}`, 'HPE_INVALID_CHUNK_SIZE')
      return false
    }
    this.state = size === 0 ? { kind: 'body-chunk-trailer' } : { kind: 'body-chunk-data', remaining: size }
    return true
  }

  private consumeChunkData (): boolean {
    if (this.state.kind !== 'body-chunk-data' || this.buf.length === 0) return false
    const take = Math.min(this.buf.length, this.state.remaining)
    this.bodyCb.onBody(this.buf.subarray(0, take))
    this.buf = this.buf.subarray(take)
    const remaining = this.state.remaining - take
    this.state = remaining === 0 ? { kind: 'body-chunk-crlf' } : { kind: 'body-chunk-data', remaining }
    return true
  }

  /** The CRLF Node's chunked encoding requires after every chunk's data, before the next size line. */
  private consumeChunkCrlf (): boolean {
    if (this.buf.length < 2) return false
    this.buf = this.buf.subarray(2)
    this.state = { kind: 'body-chunk-size' }
    return true
  }

  /** Trailer lines are collected until the terminating blank line, then handed to `onTrailers`. */
  private tryConsumeTrailerLine (): boolean {
    const idx = this.findLineOrFail('trailer section', this.maxTrailerBytes - this.trailerBytes, 'HPE_HEADER_OVERFLOW')
    if (idx === -1) return false
    const line = new TextDecoder('latin1').decode(this.buf.subarray(0, idx))
    this.buf = this.buf.subarray(idx + 2)
    this.trailerBytes += idx + 2
    if (idx > 0 && this.trailerBytes > this.maxTrailerBytes) {
      this.fail(`trailer section exceeded ${this.maxTrailerBytes} bytes`, 'HPE_HEADER_OVERFLOW')
      return false
    }
    if (idx === 0) {
      this.state = { kind: 'done' }
      if (this.trailerLines.length > 0) this.bodyCb.onTrailers?.(this.trailerLines)
      this.bodyCb.onComplete()
    } else {
      this.trailerLines.push(line)
    }
    return true
  }

  private flushUntilCloseBody (): boolean {
    if (this.buf.length === 0) return false
    this.bodyCb.onBody(this.buf)
    this.buf = new Uint8Array(0)
    return true
  }
}

export class HttpResponseParser extends HttpMessageParser {
  private readonly method: string

  constructor (private readonly cb: HttpResponseParserCallbacks, opts: { readonly method: string }) {
    super(cb)
    this.method = opts.method.toUpperCase()
  }

  /** The underlying TcpSocket's readable side ended (peer FIN). */
  end (): void {
    if (this.state.kind === 'body-until-close') {
      if (this.buf.length > 0) {
        this.cb.onBody(this.buf)
        this.buf = new Uint8Array(0)
      }
      this.state = { kind: 'done' }
      this.cb.onComplete()
    } else if (this.state.kind !== 'done') {
      this.fail('HTTP response socket ended before the response was complete (premature EOF)', 'HPE_PREMATURE_EOF')
    }
  }

  protected override tryParseHead (): boolean {
    // Measured against the TERMINATOR'S POSITION, not `this.buf.length`: a
    // small head can share one `write()` chunk with a large body (both land
    // in the same accumulated buffer before the head is stripped off below),
    // and the cap must not fire on bytes that are body, never head.
    const idx = indexOfSubarray(this.buf, CRLFCRLF)
    if (idx === -1) {
      if (this.buf.length > MAX_HEAD_BYTES) {
        this.fail(`response head exceeded ${MAX_HEAD_BYTES} bytes without a terminator`, 'HPE_HEADER_OVERFLOW')
      }
      return false
    }
    if (idx > MAX_HEAD_BYTES) {
      this.fail(`response head exceeded ${MAX_HEAD_BYTES} bytes without a terminator`, 'HPE_HEADER_OVERFLOW')
      return false
    }

    const headText = new TextDecoder('latin1').decode(this.buf.subarray(0, idx))
    this.buf = this.buf.subarray(idx + 4)

    const lines = headText.split('\r\n')
    const statusLine = lines[0] ?? ''
    const match = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(statusLine)
    if (match === null) {
      this.fail(`malformed status line: ${JSON.stringify(statusLine)}`)
      return false
    }

    const httpVersion = match[1] ?? '1.1'
    const statusCode = Number(match[2])
    const statusMessage = match[3] ?? ''

    const { headers, rawHeaders } = combineHeaders(lines.slice(1))
    const head: ParsedResponseHead = { httpVersion, statusCode, statusMessage, headers, rawHeaders }

    if (this.cb.onUpgrade !== undefined && this.isUpgrade(statusCode, headers)) {
      this.state = { kind: 'done' }
      const rest = this.buf
      this.buf = new Uint8Array(0)
      this.cb.onUpgrade(head, rest)
      return false
    }

    // 1xx (100 Continue, 103 Early Hints, ...) is an informational prelude,
    // not the response -- RFC 9110 SS15.2 requires reading past any number of
    // them for the real final status line. `state` stays at 'head' so
    // pump()'s loop retries the rest of `buf` as the next head. Handing a
    // 1xx to onHead would make the caller treat it as the whole response
    // and discard the real one that follows on the same connection.
    if (statusCode >= 100 && statusCode < 200 && statusCode !== 101) {
      this.cb.onInformation?.(head)
      return true
    }

    this.cb.onHead(head)
    this.state = this.decideBodyFraming(statusCode, headers)
    if (this.state.kind === 'done') this.cb.onComplete()
    return true
  }

  /** Node's rule: every response to CONNECT, and a 101 that names the protocol it switches to. */
  private isUpgrade (statusCode: number, headers: Readonly<Record<string, string | readonly string[]>>): boolean {
    return this.method === 'CONNECT' || (statusCode === 101 && headers.upgrade !== undefined)
  }

  private decideBodyFraming (statusCode: number, headers: Readonly<Record<string, string | readonly string[]>>): ParserState {
    // Only a 101 without an Upgrade header reaches here among the 1xx
    // codes; like Node, it is a response with no body.
    const noBody = this.method === 'HEAD' || statusCode === 204 || statusCode === 304 || statusCode === 101
    if (noBody) return { kind: 'done' }

    const transferEncoding = headers['transfer-encoding']
    if (typeof transferEncoding === 'string' && transferEncoding.toLowerCase().includes('chunked')) {
      return { kind: 'body-chunk-size' }
    }

    const contentLength = headers['content-length']
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength)) {
      const length = Number(contentLength)
      return length === 0 ? { kind: 'done' } : { kind: 'body-length', remaining: length }
    }

    return { kind: 'body-until-close' }
  }
}
