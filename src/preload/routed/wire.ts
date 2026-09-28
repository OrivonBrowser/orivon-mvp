// The HTTP/1.1 codec the routed network path speaks over `orivon.net`:
// request heads, response heads, body framing and content decoding.
// `installRoutedWire` is SERIALISED into the main world
// (Function.prototype.toString(), re-run there by
// contextBridge.executeInMainWorld), so it may reference nothing outside its
// own body; it publishes its work on the shared slot README.md's Design
// notes describe, where ./dial.ts and ./core.ts pick it up.
import type { ExtractedBody, Framer, FetchRouteTarget, ResponseHead, RoutedSlot } from './types.js'

/**
 * Mirrors the literal `installRoutedWire` keeps inside its own body (its
 * serialisation forbids importing it). Exported so tests build boundary
 * cases against it; they assert the boundary itself, so a value changed only
 * inside the function fails a test rather than passing silently.
 */
export const ROUTED_MAX_HEAD_BYTES = 256 * 1024

export function installRoutedWire (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const holder = target as Record<symbol, RoutedSlot | undefined>
  const key = Symbol.for('orivon.routed-network')
  const slot = holder[key] ?? (holder[key] = {})

  // Chromium's own cap on a response head; a head this large is not real traffic.
  const MAX_HEAD_BYTES = 256 * 1024

  const brotli = ((): boolean => {
    try { void new DecompressionStream('brotli' as CompressionFormat); return true } catch { return false }
  })()

  /** The shape a real fetch() network error has -- `is-network-error`-style retry logic matches the message exactly. The detail rides on `cause`. */
  function networkError (detail: string): TypeError {
    return new TypeError('Failed to fetch', { cause: new Error(`orivon: ${detail}`) })
  }

  function abortReason (signal: AbortSignal | undefined): unknown {
    if (signal !== undefined && signal.reason !== undefined && signal.reason !== null) return signal.reason
    return new DOMException('The operation was aborted.', 'AbortError')
  }

  function headerValue (pairs: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
    const values = pairs.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v)
    return values.length === 0 ? undefined : values.join(', ')
  }

  /** Header bytes are isomorphic-decoded, as a browser does: one byte, one code unit. */
  function isoDecode (bytes: Uint8Array): string {
    let out = ''
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return out
  }

  function requestHead (method: string, url: URL, headers: ReadonlyArray<readonly [string, string]>, body: ExtractedBody | undefined): Uint8Array {
    const path = `${url.pathname}${url.search}`
    if (/[\r\n ]/.test(method) || /[\r\n]/.test(path)) throw new TypeError('orivon: invalid request line')
    const has = (name: string): boolean => headerValue(headers, name) !== undefined
    const lines = [`${method} ${path} HTTP/1.1`]
    if (!has('host')) lines.push(`Host: ${url.host}`)
    if (!has('connection')) lines.push('Connection: close')
    if (body?.type !== undefined && !has('content-type')) lines.push(`Content-Type: ${body.type}`)
    // A null body still declares zero for POST/PUT, as the Fetch spec does.
    const length = body !== undefined ? body.bytes.byteLength : (method === 'POST' || method === 'PUT' ? 0 : undefined)
    if (length !== undefined && !has('content-length') && !has('transfer-encoding')) lines.push(`Content-Length: ${length}`)
    for (const [name, value] of headers) {
      if (/[\r\n:]/.test(name) || name === '' || /[\r\n]/.test(value)) throw new TypeError(`orivon: invalid header: ${name}`)
      lines.push(`${name}: ${value}`)
    }
    lines.push('', '')
    return new TextEncoder().encode(lines.join('\r\n'))
  }

  function parseHead (text: string): { status: number, statusText: string, headers: Array<[string, string]> } {
    const lines = text.split(/\r?\n/)
    const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(lines[0] ?? '')
    if (match === null) throw networkError(`malformed status line ${JSON.stringify(lines[0])}`)
    const headers: Array<[string, string]> = []
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
    }
    return { status: Number(match[1]), statusText: match[2] ?? '', headers }
  }

  /** The end of the head: the index just past the blank line, or -1. Accepts bare LF line ends, as browsers do. */
  function headEnd (buf: Uint8Array, length: number, from: number): number {
    for (let i = Math.max(0, from); i < length; i++) {
      if (buf[i] !== 10) continue
      if (i + 1 < length && buf[i + 1] === 10) return i + 2
      if (i + 2 < length && buf[i + 1] === 13 && buf[i + 2] === 10) return i + 3
    }
    return -1
  }

  /** Reads one final response head, skipping 1xx interim heads (100 Continue, 103 Early Hints) as HTTP requires. */
  async function readHead (read: () => Promise<Uint8Array | undefined>, leftover: Uint8Array): Promise<ResponseHead> {
    // A doubling buffer: amortised linear however small the chunks arrive.
    let buf = new Uint8Array(Math.max(4096, leftover.byteLength))
    buf.set(leftover)
    let length = leftover.byteLength
    let scanned = 0
    for (;;) {
      const end = headEnd(buf, length, scanned - 3)
      if (end === -1) {
        if (length > MAX_HEAD_BYTES) throw networkError(`response head exceeded ${MAX_HEAD_BYTES} bytes`)
        scanned = length
        const chunk = await read()
        if (chunk === undefined) throw networkError('the connection closed before the response head completed')
        if (length + chunk.byteLength > buf.byteLength) {
          const grown = new Uint8Array(Math.max(buf.byteLength * 2, length + chunk.byteLength))
          grown.set(buf.subarray(0, length))
          buf = grown
        }
        buf.set(chunk, length)
        length += chunk.byteLength
        continue
      }
      if (end > MAX_HEAD_BYTES) throw networkError(`response head exceeded ${MAX_HEAD_BYTES} bytes`)
      const head = parseHead(isoDecode(buf.subarray(0, end)).replace(/\r?\n\r?\n$/, ''))
      const rest = buf.slice(end, length)
      if (head.status >= 100 && head.status < 200 && head.status !== 101) {
        buf = new Uint8Array(Math.max(4096, rest.byteLength))
        buf.set(rest)
        length = rest.byteLength
        scanned = 0
        continue
      }
      return { ...head, rest }
    }
  }

  function lengthFramer (total: number): Framer {
    let remaining = total
    return {
      get done () { return remaining === 0 },
      endsAtClose: false,
      feed (bytes) {
        const n = Math.min(remaining, bytes.byteLength)
        remaining -= n
        return n === 0 ? [] : [bytes.subarray(0, n)]
      }
    }
  }

  /** `<hex size>[;ext]CRLF <data> CRLF ... 0 CRLF [trailers] CRLF`, decoded incrementally: data is handed on as it arrives, never collected first. */
  function chunkedFramer (): Framer {
    let state: 'size' | 'data' | 'data-end' | 'trailer' | 'done' = 'size'
    let line = ''
    let remaining = 0
    return {
      get done () { return state === 'done' },
      endsAtClose: false,
      feed (bytes) {
        const out: Uint8Array[] = []
        let i = 0
        while (i < bytes.byteLength && state !== 'done') {
          if (state === 'data') {
            const n = Math.min(remaining, bytes.byteLength - i)
            out.push(bytes.subarray(i, i + n))
            i += n
            remaining -= n
            if (remaining === 0) state = 'data-end'
            continue
          }
          if (state === 'data-end') {
            const byte = bytes[i++]
            if (byte === 10) state = 'size'
            else if (byte !== 13) throw networkError('malformed chunked body (no CRLF after chunk data)')
            continue
          }
          const lf = bytes.indexOf(10, i)
          line += isoDecode(bytes.subarray(i, lf === -1 ? bytes.byteLength : lf))
          if (line.length > MAX_HEAD_BYTES) throw networkError('malformed chunked body (line too long)')
          if (lf === -1) break
          i = lf + 1
          const text = line.endsWith('\r') ? line.slice(0, -1) : line
          line = ''
          if (state === 'trailer') {
            if (text === '') state = 'done'
            continue
          }
          const hex = (text.split(';')[0] ?? '').trim()
          if (!/^[0-9a-fA-F]{1,13}$/.test(hex)) throw networkError(`malformed chunk size ${JSON.stringify(text)}`)
          remaining = parseInt(hex, 16)
          state = remaining === 0 ? 'trailer' : 'data'
        }
        return out
      }
    }
  }

  function framer (head: ResponseHead): Framer {
    const transfer = headerValue(head.headers, 'transfer-encoding')
    if (transfer !== undefined && /(^|,)\s*chunked\s*$/i.test(transfer)) return chunkedFramer()
    const declared = headerValue(head.headers, 'content-length')
    // Repeated identical values (a proxy's doing) are one length; differing ones are an error.
    const lengths = declared === undefined ? [] : [...new Set(declared.split(',').map((v) => v.trim()))]
    if (lengths.length > 1 || (lengths.length === 1 && !/^\d+$/.test(lengths[0] ?? ''))) throw networkError('invalid Content-Length')
    if (lengths.length === 1) return lengthFramer(Number(lengths[0]))
    return { done: false, endsAtClose: true, feed: (bytes) => [bytes] }
  }

  /** Undoes each Content-Encoding in reverse order of application, through the platform's own DecompressionStream. An unknown coding stops decoding there, as a browser passes an unknown coding through. */
  function decode (stream: ReadableStream<Uint8Array>, contentEncoding: string): ReadableStream<Uint8Array> {
    const codings = contentEncoding.split(',').map((c) => c.trim().toLowerCase()).filter((c) => c !== '' && c !== 'identity')
    let current = stream
    for (const coding of codings.reverse()) {
      const format = coding === 'gzip' || coding === 'x-gzip' ? 'gzip' : coding === 'deflate' ? 'deflate' : coding === 'br' ? 'brotli' : undefined
      if (format === undefined) break
      if (format === 'brotli' && !brotli) throw networkError('the response is brotli-encoded, which this platform cannot decode')
      // lib.dom types the writable side as BufferSource; the runtime pair is exactly what pipeThrough needs.
      current = current.pipeThrough(new DecompressionStream(format as CompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    }
    return current
  }

  slot.wire = {
    acceptEncoding: brotli ? 'gzip, deflate, br' : 'gzip, deflate',
    networkError,
    abortReason,
    headerValue,
    requestHead,
    readHead,
    framer,
    decode
  }
}
