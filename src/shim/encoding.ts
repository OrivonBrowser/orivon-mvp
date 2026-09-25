// Node's fs encodings, through the page's own `buffer` package (module-map.ts)
// rather than TextDecoder: TextDecoder knows character sets, not Node's
// encoding table, and throws on 'binary', 'ucs2', 'hex' and the rest.

import { Buffer } from 'buffer'
import { toBytes } from './stream-bytes.js'

/** The `buffer` package predates Node's base64url; it is base64 with a URL-safe alphabet and no padding. */
const BASE64URL = 'base64url'

function invalidEncoding (encoding: string): TypeError & { code: string } {
  return Object.assign(
    new TypeError(`The argument 'encoding' is invalid encoding. Received '${encoding}'`),
    { code: 'ERR_INVALID_ARG_VALUE' }
  )
}

function bufferEncoding (encoding: string): BufferEncoding {
  if (!Buffer.isEncoding(encoding)) throw invalidEncoding(encoding)
  return encoding.toLowerCase() as BufferEncoding
}

/** `null` and `undefined` both mean "give me the bytes", as in Node. */
export function decode (bytes: Uint8Array, encoding: string | null | undefined): Uint8Array | string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (encoding === undefined || encoding === null) return Buffer.from(buffer)
  if (encoding.toLowerCase() === BASE64URL) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return buffer.toString(bufferEncoding(encoding))
}

/** writeFile's mirror of decode(): a string in `encoding` (utf8 by default), or any TypedArray/DataView as its bytes. */
export function encode (data: unknown, encoding: string | null | undefined): Uint8Array {
  if (typeof data !== 'string') {
    if (ArrayBuffer.isView(data) && !(data instanceof Uint8Array)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return toBytes(data)
  }
  if (encoding === undefined || encoding === null) return Buffer.from(data, 'utf8')
  if (encoding.toLowerCase() === BASE64URL) return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return Buffer.from(data, bufferEncoding(encoding))
}

/** The encoding from an fs options argument: Node takes it bare (`'utf8'`) or as `{ encoding }`. */
export function encodingOf (options: { encoding?: string | null } | string | null | undefined): string | null | undefined {
  return typeof options === 'string' ? options : options?.encoding
}
