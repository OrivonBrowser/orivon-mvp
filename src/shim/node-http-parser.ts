// A byte-oriented, incremental HTTP/1.1 response parser. Pure and
// transport-free on purpose -- it knows nothing about TcpSocket, orivon.*,
// or WHATWG streams; node-http-client.ts feeds it bytes read from a
// TcpSocket's `readable` and its own EOF, and it drives the four callbacks
// below. Kept separate so the framing logic (chunked decode, Content-Length,
// connection-close-terminated bodies, header-combining rules) is testable
// with plain byte arrays, no fake socket required.
//
// Header-combining matches Node's own default: duplicates join with ", ",
// except `set-cookie`, which becomes an array -- the one case a real caller
// (any cookie-aware library) would notice getting collapsed into a string.
// Everything else Node treats specially (age, host, ... "discrete" headers
// that keep only the first value) is not implemented: no confirmed caller in
// this repo's dependency graph relies on it, and the ", "-joined fallback is
// never silently wrong, only imprecise for those specific header names.

const CRLF = [13, 10]
const CRLFCRLF = [13, 10, 13, 10]
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

export interface HttpResponseParserCallbacks {
  onHead(head: ParsedResponseHead): void
  onBody(chunk: Uint8Array): void
  onComplete(): void
  onError(error: Error): void
}

type ParserState =
  | { kind: 'head' }
  | { kind: 'body-length', remaining: number }
  | { kind: 'body-chunk-size' }
  | { kind: 'body-chunk-data', remaining: number }
  | { kind: 'body-chunk-crlf' }
  | { kind: 'body-chunk-trailer' }
  | { kind: 'body-until-close' }
  | { kind: 'done' }

function indexOfSubarray (haystack: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Exported for node-http-client.ts's request-body assembly -- same idea, same function (Rule 3). */
export function concatBytes (a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export class HttpResponseParser {
  private buf: Uint8Array = new Uint8Array(0)
  private state: ParserState = { kind: 'head' }
  private readonly method: string

  constructor (private readonly cb: HttpResponseParserCallbacks, opts: { readonly method: string }) {
    this.method = opts.method.toUpperCase()
  }

  write (chunk: Uint8Array): void {
    if (this.state.kind === 'done') return
    this.buf = concatBytes(this.buf, chunk)
    this.pump()
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
      this.fail('HTTP response socket ended before the response was complete (premature EOF)')
    }
  }

  private fail (message: string): void {
    this.state = { kind: 'done' }
    this.cb.onError(new Error(`orivon-node-shim: ${message}`))
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

  private tryParseHead (): boolean {
    // Measured against the TERMINATOR'S POSITION, not `this.buf.length`: a
    // small head can share one `write()` chunk with a large body (both land
    // in the same accumulated buffer before the head is stripped off below),
    // and the cap must not fire on bytes that are body, never head.
    const idx = indexOfSubarray(this.buf, CRLFCRLF)
    if (idx === -1) {
      if (this.buf.length > MAX_HEAD_BYTES) {
        this.fail(`response head exceeded ${MAX_HEAD_BYTES} bytes without a terminator`)
      }
      return false
    }
    if (idx > MAX_HEAD_BYTES) {
      this.fail(`response head exceeded ${MAX_HEAD_BYTES} bytes without a terminator`)
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

    // 1xx (100 Continue, 103 Early Hints, ...) is an informational prelude,
    // not the response -- RFC 9110 SS15.2 requires reading past any number of
    // them for the real final status line. `state` is left at 'head' (never
    // assigned here) so pump()'s loop immediately retries parsing the rest
    // of `buf` as the next head. Surfacing a 1xx to onHead would make the
    // caller treat it as the whole response -- observed as node-http-client.ts
    // emitting statusCode 103 with an empty body, closing the socket, and
    // discarding the real 200 that followed on the same connection.
    if (statusCode >= 100 && statusCode < 200) return true

    const { headers, rawHeaders } = this.combineHeaders(lines.slice(1))
    this.cb.onHead({ httpVersion, statusCode, statusMessage, headers, rawHeaders })
    this.state = this.decideBodyFraming(statusCode, headers)
    if (this.state.kind === 'done') this.cb.onComplete()
    return true
  }

  private combineHeaders (lines: readonly string[]): { headers: Record<string, string | string[]>, rawHeaders: string[] } {
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
      } else {
        headers[lower] = existing === undefined ? value : `${existing as string}, ${value}`
      }
    }
    return { headers, rawHeaders }
  }

  private decideBodyFraming (statusCode: number, headers: Readonly<Record<string, string | readonly string[]>>): ParserState {
    // 1xx never reaches here -- tryParseHead() consumes it before calling
    // this method at all (see the comment there).
    const noBody = this.method === 'HEAD' || statusCode === 204 || statusCode === 304
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

  private consumeLengthBody (): boolean {
    if (this.state.kind !== 'body-length' || this.buf.length === 0) return false
    const take = Math.min(this.buf.length, this.state.remaining)
    this.cb.onBody(this.buf.subarray(0, take))
    this.buf = this.buf.subarray(take)
    const remaining = this.state.remaining - take
    if (remaining === 0) {
      this.state = { kind: 'done' }
      this.cb.onComplete()
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
  private findLineOrFail (label: string): number {
    const idx = indexOfSubarray(this.buf, CRLF)
    if (idx === -1) {
      if (this.buf.length > MAX_LINE_BYTES) this.fail(`${label} exceeded ${MAX_LINE_BYTES} bytes without a terminator`)
      return -1
    }
    if (idx > MAX_LINE_BYTES) {
      this.fail(`${label} exceeded ${MAX_LINE_BYTES} bytes`)
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
    const size = sizeHex === '' ? Number.NaN : parseInt(sizeHex, 16)
    if (!Number.isFinite(size) || size < 0) {
      this.fail(`malformed chunk size: ${JSON.stringify(line)}`)
      return false
    }
    this.state = size === 0 ? { kind: 'body-chunk-trailer' } : { kind: 'body-chunk-data', remaining: size }
    return true
  }

  private consumeChunkData (): boolean {
    if (this.state.kind !== 'body-chunk-data' || this.buf.length === 0) return false
    const take = Math.min(this.buf.length, this.state.remaining)
    this.cb.onBody(this.buf.subarray(0, take))
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

  /** Trailer headers (rare in practice) are read and discarded until the terminating blank line. */
  private tryConsumeTrailerLine (): boolean {
    const idx = this.findLineOrFail('trailer line')
    if (idx === -1) return false
    const isBlank = idx === 0
    this.buf = this.buf.subarray(idx + 2)
    if (isBlank) {
      this.state = { kind: 'done' }
      this.cb.onComplete()
    }
    return true
  }

  private flushUntilCloseBody (): boolean {
    if (this.buf.length === 0) return false
    this.cb.onBody(this.buf)
    this.buf = new Uint8Array(0)
    return true
  }
}
