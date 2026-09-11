// `installFetchRoute` below is handed to `contextBridge.executeInMainWorld`
// (see ./main-world-socket.ts's own header for why: SERIALISED via
// Function.prototype.toString() and re-run fresh in the main world -- no
// imports, no module-level consts, no closures over anything outside its
// own body). `exposeFetchRoute` at the bottom is the ordinary,
// non-serialised wiring shared by preload/app.ts and preload/newtab.ts.
//
// ADR-0017: an app's own `fetch()` is routed through `window.orivon.net`
// for any cross-origin http(s) request, carrying whatever headers the app
// set -- including ones a page normally cannot (`Origin`, `Cookie`, ...).
// No cookie jar, no ambient credential: every byte comes from the app.
//
// GATED ON `isAppTab`, decided SYNCHRONOUSLY in main before this ever runs
// -- see this directory's README.md's Design notes for why, and why it is
// not enough that `orivon.net` merely exists (it does, on every ordinary
// tab, registered app or not).
//
// Known divergences from a real browser's fetch() -- redirects unfollowed,
// a response body capped -- are catalogued in README.md's Design notes
// (ADR-0017: "a silent divergence in a web platform API is a trap").
import { contextBridge } from 'electron'

/** The one shape this file needs from `window.orivon` -- a subset of `../contracts/capability-api.js`'s `Orivon`, repeated here because a serialised main-world function cannot import that type's runtime companions across the boundary (only used for typechecking; erased at compile time). */
export interface FetchRouteSocket {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  close: () => Promise<void>
}

export interface FetchRouteTarget {
  orivon?: {
    net?: {
      connect: (opts: { host: string, port: number }) => Promise<FetchRouteSocket>
      connectSecure: (opts: { host: string, port: number }) => Promise<FetchRouteSocket>
    }
  }
  fetch?: (input: unknown, init?: unknown) => Promise<Response>
  location?: { origin: string, href: string }
}

/**
 * Mirrors the two literal caps `installFetchRoute` keeps INSIDE its own
 * body -- required by its serialisation contract above, so they cannot be
 * imported into it and have to be typed twice. Exported so tests build
 * boundary cases against these instead of a third drifting copy; the tests
 * assert actual boundary behaviour, so a value changed only inside
 * `installFetchRoute` fails a test rather than passing silently.
 */
export const ROUTED_FETCH_MAX_HEAD_BYTES = 32 * 1024
export const ROUTED_FETCH_MAX_BODY_BYTES = 16 * 1024 * 1024

export function installFetchRoute (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const netOrUndefined = target.orivon?.net
  if (netOrUndefined === undefined) return
  // Re-bound to its own const so its non-undefined type is fixed here --
  // TypeScript does not carry a narrowing of a captured variable into a
  // nested function declared below (routedFetch), only a fresh binding's
  // own declared type.
  const net = netOrUndefined

  const nativeFetch = typeof target.fetch === 'function' ? target.fetch.bind(target) : undefined

  // Mirrors node-http-parser.ts's own MAX_HEAD_BYTES and fail-closed
  // direction -- see readHead below for why this is measured against the
  // head bytes seen so far, not the whole buffer (that sibling's own bug).
  const MAX_HEAD_BYTES = 32 * 1024

  // A conservative PLACEHOLDER, not an owner decision -- README.md's
  // Design notes. Closes the unbounded-buffering hole now; whether this
  // should instead be a manifest-declared, user-visible limit (A80's
  // pattern) is an open question, not settled here.
  const MAX_BODY_BYTES = 16 * 1024 * 1024

  function concatBytes (a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  /** `signal.reason` when set (the custom value an app's own `controller.abort(reason)` passed), else the same DOMException shape a real fetch() constructs on a plain `controller.abort()`. */
  function abortReason (signal: AbortSignal | undefined): unknown {
    if (signal !== undefined && signal.reason !== undefined && signal.reason !== null) return signal.reason
    return new DOMException('The operation was aborted.', 'AbortError')
  }

  /** Races `promise` against `signal` firing, so an await rejects promptly even if the underlying read/write never settles -- a signal cannot force a foreign promise to release what it holds, which is why routedFetch ALSO closes the socket directly on abort, below. */
  function raceAbort<T> (promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise
    if (signal.aborted) return Promise.reject(abortReason(signal))
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => { reject(abortReason(signal)) }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) }
      )
    })
  }

  /** Every shape `init.headers`/a Request-like `.headers` can arrive as. Deliberately NEVER routed through the real `Headers` class -- its guard filters exactly the request headers ADR-0017 exists to let an app set (`Origin`, `Cookie`, ...), which is the one thing a routed request must not lose. */
  function headerPairsFrom (raw: unknown): Array<[string, string]> {
    if (raw === null || raw === undefined) return []
    // Array is checked BEFORE the generic `.entries` duck-type below:
    // Array.prototype has its own `.entries()` (index/value pairs), which
    // would otherwise match first and turn `[['X-Test','v1']]` into a
    // single bogus `[0, ['X-Test','v1']]` pair.
    if (Array.isArray(raw)) return (raw as Array<[unknown, unknown]>).map(([k, v]) => [String(k), String(v)])
    const iterable = raw as { entries?: () => Iterable<[string, string]> }
    if (typeof iterable.entries === 'function') return Array.from(iterable.entries())
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
  }

  function hasHeader (pairs: Array<[string, string]>, name: string): boolean {
    const lower = name.toLowerCase()
    return pairs.some(([k]) => k.toLowerCase() === lower)
  }

  function findHeader (pairs: Array<[string, string]>, name: string): string | undefined {
    const lower = name.toLowerCase()
    const values = pairs.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v)
    return values.length === 0 ? undefined : values.join(', ')
  }

  /** `null`/`undefined` and every body shape `RequestOptions.body` accepts, EXCEPT `FormData`/`Blob`/a readable stream -- multipart and streamed-upload bodies are not built here (v0 scope; see README.md's Design notes). `contentType` mirrors the Fetch "extract a body" algorithm's own defaults for a string or `URLSearchParams`, applied only when the app did not already set one. */
  async function extractBody (body: unknown): Promise<{ bytes: Uint8Array, contentType: string | undefined }> {
    if (body === null || body === undefined) return { bytes: new Uint8Array(0), contentType: undefined }
    if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), contentType: 'text/plain;charset=UTF-8' }
    if (body instanceof Uint8Array) return { bytes: body, contentType: undefined }
    if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body), contentType: undefined }
    if (ArrayBuffer.isView(body)) {
      return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType: undefined }
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return { bytes: new TextEncoder().encode(body.toString()), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' }
    }
    throw new TypeError('orivon: routed fetch supports string/Uint8Array/ArrayBuffer/URLSearchParams bodies only')
  }

  function buildRequestHead (
    method: string, path: string, host: string, port: number, defaultPort: number,
    headerPairs: Array<[string, string]>, bodyLength: number, defaultContentType: string | undefined
  ): Uint8Array {
    if (/[\r\n]/.test(method) || /[\r\n]/.test(path)) throw new TypeError('orivon: invalid request line')
    const lines = [`${method} ${path} HTTP/1.1`]
    if (!hasHeader(headerPairs, 'host')) lines.push(`Host: ${port === defaultPort ? host : `${host}:${port}`}`)
    if (!hasHeader(headerPairs, 'connection')) lines.push('Connection: close')
    if (bodyLength > 0 && defaultContentType !== undefined && !hasHeader(headerPairs, 'content-type')) {
      lines.push(`Content-Type: ${defaultContentType}`)
    }
    if (bodyLength > 0 && !hasHeader(headerPairs, 'content-length') && !hasHeader(headerPairs, 'transfer-encoding')) {
      lines.push(`Content-Length: ${bodyLength}`)
    }
    for (const [name, value] of headerPairs) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new TypeError(`orivon: invalid header (contains a raw CR or LF): ${name}`)
      lines.push(`${name}: ${value}`)
    }
    lines.push('', '')
    return new TextEncoder().encode(lines.join('\r\n'))
  }

  function indexOfCrLfCrLf (buf: Uint8Array): number {
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
    }
    return -1
  }

  function indexOfCrLf (buf: Uint8Array): number {
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10) return i
    }
    return -1
  }

  function parseHead (headBytes: Uint8Array): { status: number, statusText: string, headerPairs: Array<[string, string]> } {
    const text = new TextDecoder('latin1').decode(headBytes)
    const lines = text.split('\r\n')
    const match = /^HTTP\/\d\.\d (\d{3})(?: (.*))?$/.exec(lines[0] ?? '')
    if (match === null) throw new TypeError(`orivon: malformed HTTP status line: ${JSON.stringify(lines[0])}`)
    const headerPairs: Array<[string, string]> = []
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      headerPairs.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
    }
    return { status: Number(match[1]), statusText: match[2] ?? '', headerPairs }
  }

  /** Reads until `\r\n\r\n`, capped at MAX_HEAD_BYTES measured against the head bytes seen SO FAR, never the whole buffer -- a peer can send the head and a large body in one chunk, and bytes past the terminator are body, not head (node-http-parser.ts's own bug, deliberately not copied here). */
  async function readHead (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ buf: Uint8Array, headEnd: number }> {
    let buf: Uint8Array = new Uint8Array(0)
    let headEnd = -1
    while (headEnd === -1) {
      const { done, value } = await reader.read()
      if (done) throw new TypeError('orivon: the connection closed before the response headers completed')
      buf = concatBytes(buf, value)
      headEnd = indexOfCrLfCrLf(buf)
      const headBytesSoFar = headEnd === -1 ? buf.length : headEnd + 4
      if (headBytesSoFar > MAX_HEAD_BYTES) {
        throw new TypeError(`orivon: response headers exceeded ${String(MAX_HEAD_BYTES)} bytes (MAX_HEAD_BYTES) before terminating`)
      }
    }
    return { buf, headEnd }
  }

  /** Reads a stream to completion, rejecting the instant the running total would exceed MAX_BODY_BYTES -- never buffers past the cap first. Used for the connection-close-terminated response body, the one case with no declared length to pre-check before reading. */
  async function readAllCapped (
    reader: ReadableStreamDefaultReader<Uint8Array>, label: string, initial: Uint8Array = new Uint8Array(0)
  ): Promise<Uint8Array> {
    let buf = initial
    if (buf.length > MAX_BODY_BYTES) {
      throw new TypeError(`orivon: ${label} exceeds the routed-fetch body cap of ${String(MAX_BODY_BYTES)} bytes (MAX_BODY_BYTES)`)
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) return buf
      buf = concatBytes(buf, value)
      if (buf.length > MAX_BODY_BYTES) {
        throw new TypeError(`orivon: ${label} exceeds the routed-fetch body cap of ${String(MAX_BODY_BYTES)} bytes (MAX_BODY_BYTES)`)
      }
    }
  }

  async function readFixedLength (reader: ReadableStreamDefaultReader<Uint8Array>, initial: Uint8Array, length: number): Promise<Uint8Array> {
    let buf = initial
    while (buf.length < length) {
      const { done, value } = await reader.read()
      if (done) throw new TypeError('orivon: the connection closed before the declared Content-Length was received')
      buf = concatBytes(buf, value)
    }
    return buf.subarray(0, length)
  }

  /** Node's chunked-transfer framing: `<size-hex>[;ext]\r\n<size bytes>\r\n`, repeated, terminated by a `0` size line and an (unread-for) trailer block. The running total is checked against MAX_BODY_BYTES as soon as a chunk's size is known, BEFORE waiting for that many bytes to arrive -- a peer cannot buffer this past the cap merely by declaring one oversized chunk. */
  async function readChunked (reader: ReadableStreamDefaultReader<Uint8Array>, initial: Uint8Array): Promise<Uint8Array> {
    let buf = initial
    const pieces: Uint8Array[] = []
    let total = 0

    async function fill (min: number): Promise<void> {
      while (buf.length < min) {
        const { done, value } = await reader.read()
        if (done) throw new TypeError('orivon: the connection closed mid chunked response body')
        buf = concatBytes(buf, value)
      }
    }
    async function nextLine (): Promise<string> {
      let idx = indexOfCrLf(buf)
      while (idx === -1) {
        const { done, value } = await reader.read()
        if (done) throw new TypeError('orivon: the connection closed mid chunk framing')
        buf = concatBytes(buf, value)
        idx = indexOfCrLf(buf)
      }
      const line = new TextDecoder('latin1').decode(buf.subarray(0, idx))
      buf = buf.subarray(idx + 2)
      return line
    }

    while (true) {
      const sizeLine = await nextLine()
      const size = parseInt((sizeLine.split(';')[0] ?? '').trim(), 16)
      if (!Number.isFinite(size) || size < 0) throw new TypeError(`orivon: malformed chunk size: ${JSON.stringify(sizeLine)}`)
      if (size === 0) {
        while ((await nextLine()) !== '') { /* trailer headers, discarded */ }
        break
      }
      total += size
      if (total > MAX_BODY_BYTES) {
        throw new TypeError(`orivon: chunked response body exceeds the routed-fetch body cap of ${String(MAX_BODY_BYTES)} bytes (MAX_BODY_BYTES)`)
      }
      await fill(size + 2)
      pieces.push(buf.subarray(0, size))
      buf = buf.subarray(size + 2)
    }
    const totalOut = pieces.reduce((sum, piece) => sum + piece.length, 0)
    const out = new Uint8Array(totalOut)
    let offset = 0
    for (const piece of pieces) { out.set(piece, offset); offset += piece.length }
    return out
  }

  /** The five HTTP statuses the Fetch spec calls a "null body status" -- a non-empty body at one of these makes the real `Response` constructor throw, so the actual bytes are discarded rather than risk that. */
  function isNullBodyStatus (status: number): boolean {
    return status === 101 || status === 103 || status === 204 || status === 205 || status === 304
  }

  /** Kept distinct so the catch below can re-throw it untouched. */
  class DecompressedTooLarge extends TypeError {
    constructor () { super(`orivon: fetch response decompressed past the ${MAX_BODY_BYTES}-byte limit`) }
  }

  /** Real fetch() transparently decompresses gzip/deflate/br (ADR-0017: "a silent divergence... is a trap"). Uses the platform's own DecompressionStream -- native in Chromium, no dependency, Rule 8 unaffected. `br` has no DecompressionStream format in Chromium, so decompressBody below fails loudly rather than pass compressed bytes through as content. Content-Encoding is left on the Response unstripped, matching a real browser's own behaviour here. */
  async function decompress (bytes: Uint8Array, format: 'gzip' | 'deflate'): Promise<Uint8Array> {
    const source = new ReadableStream<Uint8Array>({
      start (controller) { controller.enqueue(bytes); controller.close() }
    })
    try {
      // lib.dom.d.ts types DecompressionStream.writable as WritableStream<BufferSource>,
      // not <Uint8Array> -- a real mismatch in the .d.ts, not this code; the
      // runtime pair is exactly what pipeThrough needs.
      const pair = new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
      // Read and count, never `new Response(...).arrayBuffer()`: the wire cap
      // stops being the same number once bytes are decompressed (about 1000:1
      // for a run of repeated bytes, measured), and arrayBuffer() has already
      // allocated everything before it could be asked for a size. Cancel
      // rather than abandon -- an abandoned reader leaves the stream inflating.
      const reader = source.pipeThrough(pair).getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > MAX_BODY_BYTES) {
            await reader.cancel()
            throw new DecompressedTooLarge()
          }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const out = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) { out.set(chunk, at); at += chunk.length }
      return out
    } catch (error) {
      // Unwrapped: hitting the cap is not a decode failure, and rewrapping it
      // would blame the server for what this browser refused to hold.
      if (error instanceof DecompressedTooLarge) throw error
      throw new TypeError(`orivon: fetch response claimed Content-Encoding: ${format} but failed to decompress (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  async function decompressBody (bytes: Uint8Array, contentEncoding: string): Promise<Uint8Array> {
    const codings = contentEncoding.split(',').map((c) => c.trim().toLowerCase()).filter((c) => c.length > 0)
    let current = bytes
    for (const coding of codings) {
      if (coding === 'identity') continue
      if (coding === 'gzip' || coding === 'x-gzip') { current = await decompress(current, 'gzip'); continue }
      if (coding === 'deflate') { current = await decompress(current, 'deflate'); continue }
      if (coding === 'br') {
        throw new TypeError('orivon: fetch response used Content-Encoding: br (brotli), which this platform\'s DecompressionStream cannot decode -- brotli is unsupported here')
      }
      // Any other/unrecognised coding is left as-is, the same permissive
      // handling a real fetch() gives a coding it does not itself know.
    }
    return current
  }

  async function readResponse (
    reader: ReadableStreamDefaultReader<Uint8Array>, method: string
  ): Promise<{ status: number, statusText: string, headerPairs: Array<[string, string]>, body: Uint8Array }> {
    const { buf, headEnd } = await readHead(reader)
    const { status, statusText, headerPairs } = parseHead(buf.subarray(0, headEnd))
    const rest = buf.subarray(headEnd + 4)

    if (method === 'HEAD' || isNullBodyStatus(status)) return { status, statusText, headerPairs, body: new Uint8Array(0) }

    const transferEncoding = findHeader(headerPairs, 'transfer-encoding')
    if (transferEncoding !== undefined && transferEncoding.toLowerCase().includes('chunked')) {
      return { status, statusText, headerPairs, body: await readChunked(reader, rest) }
    }
    const contentLength = findHeader(headerPairs, 'content-length')
    if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
      const length = Number(contentLength)
      if (length > MAX_BODY_BYTES) {
        throw new TypeError(`orivon: response Content-Length (${String(length)}) exceeds the routed-fetch body cap of ${String(MAX_BODY_BYTES)} bytes (MAX_BODY_BYTES)`)
      }
      return { status, statusText, headerPairs, body: await readFixedLength(reader, rest, length) }
    }
    return { status, statusText, headerPairs, body: await readAllCapped(reader, 'response body', rest) }
  }

  async function routedFetch (input: unknown, init?: { method?: string, headers?: unknown, body?: unknown, signal?: AbortSignal }): Promise<Response> {
    const requestLike = input as { url?: string, method?: string, headers?: unknown }
    const rawUrl = typeof input === 'string' ? input : requestLike?.url
    if (typeof rawUrl !== 'string') {
      throw new TypeError('orivon: fetch requires a URL string, or an object with a string .url property')
    }
    const base = typeof target.location?.href === 'string' ? target.location.href : undefined
    const url = new URL(rawUrl, base)

    const routable = url.protocol === 'http:' || url.protocol === 'https:'
    const crossOrigin = target.location === undefined || url.origin !== target.location.origin
    if (!routable || !crossOrigin) {
      if (nativeFetch !== undefined) return await nativeFetch(input, init)
      throw new TypeError(`orivon: fetch routing cannot reach ${url.origin} (no native fetch fallback available)`)
    }

    const signal = init?.signal
    // A plain `signal?.aborted === true` re-check further down narrows to a
    // stale `false` across the awaits below (TS treats AbortSignal.aborted,
    // a readonly getter, as immutable) -- routed through a function call so
    // each check re-reads the live value instead.
    function isAborted (): boolean { return signal !== undefined && signal.aborted }
    if (isAborted()) throw abortReason(signal)

    const method = (init?.method ?? (typeof requestLike?.method === 'string' ? requestLike.method : 'GET')).toUpperCase()
    const headerPairs = headerPairsFrom(init?.headers ?? requestLike?.headers)
    const { bytes: requestBodyBytes, contentType } = await extractBody(init?.body)

    const defaultPort = url.protocol === 'https:' ? 443 : 80
    const port = url.port !== '' ? Number(url.port) : defaultPort
    const dial = url.protocol === 'https:' ? net.connectSecure : net.connect

    // Closes whichever socket is actually live the moment `signal` fires --
    // the dialled socket once it exists, or (dial still in flight) the one
    // it eventually produces -- so an abort can never leak a connection.
    let currentSocket: FetchRouteSocket | undefined
    let dialPromise: Promise<FetchRouteSocket> | undefined
    const onAbort = (): void => {
      if (currentSocket !== undefined) { currentSocket.close().catch(() => {}); return }
      dialPromise?.then((socket) => { socket.close().catch(() => {}) }, () => {})
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })

    try {
      dialPromise = dial({ host: url.hostname, port })
      try {
        currentSocket = await raceAbort(dialPromise, signal)
      } catch (error) {
        if (isAborted()) throw abortReason(signal)
        const message = error instanceof Error ? error.message : String(error)
        throw new TypeError(`orivon: fetch to ${url.host} refused (${message})`)
      }
      const socket = currentSocket

      const head = buildRequestHead(method, `${url.pathname}${url.search}`, url.hostname, port, defaultPort, headerPairs, requestBodyBytes.length, contentType)
      const writer = socket.writable.getWriter()
      try {
        await raceAbort(writer.write(head), signal)
        if (requestBodyBytes.length > 0) await raceAbort(writer.write(requestBodyBytes), signal)
        await raceAbort(writer.close(), signal)
      } catch (error) {
        await socket.close().catch(() => {})
        if (isAborted()) throw abortReason(signal)
        throw new TypeError(`orivon: fetch to ${url.host} failed while sending the request (${error instanceof Error ? error.message : String(error)})`)
      }

      let result
      try {
        result = await raceAbort(readResponse(socket.readable.getReader(), method), signal)
      } catch (error) {
        await socket.close().catch(() => {})
        if (isAborted()) throw abortReason(signal)
        throw error instanceof TypeError ? error : new TypeError(String(error))
      }
      await socket.close().catch(() => {})

      let responseBodyBytes = result.body
      const contentEncoding = findHeader(result.headerPairs, 'content-encoding')
      if (contentEncoding !== undefined && responseBodyBytes.length > 0) {
        responseBodyBytes = await decompressBody(responseBodyBytes, contentEncoding)
      }

      // A constructed Response's `.headers` does NOT hide Set-Cookie the way a
      // real network response does (measured: `new Headers()` carries no such
      // guard here) -- so the app DOES see it, which is correct for ADR-0017's
      // "closer to a command-line tool" model: an app managing its own session
      // must be able to read what the peer sent. The no-jar guarantee is that
      // nothing ELSE here ever stores or replays it -- each socket is used for
      // exactly one request and then closed, above.
      const headers = new Headers()
      for (const [name, value] of result.headerPairs) {
        try { headers.append(name, value) } catch { /* a malformed header from the peer -- skip it, don't fail the whole response */ }
      }
      const body = isNullBodyStatus(result.status) ? null : responseBodyBytes as Uint8Array<ArrayBuffer>
      const response = new Response(body, {
        status: result.status, statusText: result.statusText, headers
      })
      try {
        Object.defineProperty(response, 'url', { value: url.toString(), configurable: true })
      } catch { /* not fatal -- response.url just reads "", as an ordinary constructed Response's already does */ }
      return response
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  // SYNCHRONOUS, no round trip -- `isAppTab` was already decided in main
  // before this function ever ran (this file's own header). A page script
  // that runs immediately cannot outrun this the way it could outrun the
  // async `orivon.app.manifest()` check this replaced.
  Object.defineProperty(target, 'fetch', { value: routedFetch, writable: false, configurable: false, enumerable: true })
}
