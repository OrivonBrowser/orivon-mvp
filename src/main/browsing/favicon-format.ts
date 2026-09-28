// What bytes an icon actually is, decided by sniffing rather than trusting a
// label: a server's `content-type` (an `.ico` served as
// `application/octet-stream`, or SVG under any label at all, is common), a
// page's own `data:` URL, or a label stored in bookmarks.json. Pure -- no
// Electron import, so favicon.ts and bookmarks.ts stay importable under
// plain vitest.

/** Generous enough for an SVG that embeds a raster image inline -- a real
 * shape (web3compass.net's own icons run 57 KiB doing exactly this), and
 * several times what any bitmap favicon format needs. */
export const MAX_FAVICON_BYTES = 128 * 1024

/** Every format this module will recognise, spelled the way `toDataUrl`
 * emits them -- `.ico`/`.cur` both become `image/x-icon`, the same spelling
 * `loader/serve/content-type.ts`'s own table uses for `.ico` (chosen to
 * agree with it, though the two tables serve different questions -- byte
 * sniffing here, extension lookup there -- and are not otherwise shared). */
export type SniffedImageType =
  | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  | 'image/x-icon' | 'image/bmp' | 'image/avif' | 'image/svg+xml'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const BMP = [0x42, 0x4d]
// ICO is type 1, CUR is type 2 -- both are "an icon" as far as an <img> cares.
const ICO = [0x00, 0x00, 0x01, 0x00]
const CUR = [0x00, 0x00, 0x02, 0x00]

function startsWith (bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false
  return true
}

function ascii (bytes: Uint8Array, start: number, length: number): string {
  if (bytes.length < start + length) return ''
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[start + i]!)
  return out
}

/** RIFF????WEBP -- the four-byte size field in the middle is skipped, not matched. */
function isWebp (bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
}

/** An ISO-BMFF `ftyp` box naming an AVIF brand, still or animated. The box's
 * own length field (bytes 0-3) is not checked: only the brand at a fixed
 * offset decides this, the same way the other sniffs here read fixed bytes
 * rather than parsing a container in full. */
function isAvif (bytes: Uint8Array): boolean {
  if (ascii(bytes, 4, 4) !== 'ftyp') return false
  const brand = ascii(bytes, 8, 4)
  return brand === 'avif' || brand === 'avis'
}

/** True if, after an optional BOM, whitespace, one `<?xml ... ?>` prolog,
 * any number of comments and one `<!DOCTYPE ...>`, the first real element is
 * `<svg`. Deliberately not a full XML parse -- an SVG favicon's own
 * generator emits one of a small number of prefixes, and this only has to
 * tell "this is SVG" from "this is not an image at all", never validate the
 * document. Text, not bytes, because every SVG generator observed writes
 * ASCII-safe UTF-8 for this much of the file. */
export function looksLikeSvg (text: string): boolean {
  let rest = text
  for (;;) {
    // trimStart drops a decoded byte-order mark (U+FEFF) along with whitespace.
    const trimmed = rest.trimStart()
    if (trimmed.startsWith('<?xml')) {
      const end = trimmed.indexOf('?>')
      if (end === -1) return false
      rest = trimmed.slice(end + 2)
      continue
    }
    if (trimmed.startsWith('<!--')) {
      const end = trimmed.indexOf('-->')
      if (end === -1) return false
      rest = trimmed.slice(end + 3)
      continue
    }
    if (/^<!doctype/i.test(trimmed)) {
      const end = doctypeEnd(trimmed)
      if (end === -1) return false
      rest = trimmed.slice(end + 1)
      continue
    }
    return /^<svg[\s>/]/i.test(trimmed)
  }
}

/** The index of the `>` closing the DOCTYPE `text` starts with, or -1 if it
 * never closes or carries an internal subset. The subset
 * (`<!DOCTYPE svg [ <!ENTITY ... > ]>`) is where a "billion laughs" entity
 * bomb is declared -- nested references that expand to gigabytes during
 * parsing, script or no script -- and a real favicon's DOCTYPE never needs
 * one, so its presence alone is refused. Quoted literals are skipped: a
 * SYSTEM literal may hold any character but its own quote, `>` and `[`
 * included, so neither the first `>` nor the first `[` in the text can be
 * trusted to be the DOCTYPE's own. */
function doctypeEnd (text: string): number {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === '\'') {
      quote = char
    } else if (char === '[') {
      return -1
    } else if (char === '>') {
      return i
    }
  }
  return -1
}

/** How much of a candidate is even looked at for the SVG text check --
 * generous enough for a real prolog/doctype/comment, small enough that a
 * non-image response (an HTML error page, say) is rejected without
 * decoding the whole thing as text. */
const SVG_SNIFF_WINDOW = 4 * 1024

/** `null` for anything not recognised -- every caller treats that the same
 * as a fetch failure. */
export function sniffImageType (bytes: Uint8Array): SniffedImageType | null {
  if (startsWith(bytes, PNG)) return 'image/png'
  if (startsWith(bytes, JPEG)) return 'image/jpeg'
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif'
  if (startsWith(bytes, ICO) || startsWith(bytes, CUR)) return 'image/x-icon'
  if (startsWith(bytes, BMP)) return 'image/bmp'
  if (isWebp(bytes)) return 'image/webp'
  if (isAvif(bytes)) return 'image/avif'
  if (looksLikeSvg(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SVG_SNIFF_WINDOW)))) return 'image/svg+xml'
  return null
}

/** `bytes` as a base64 `data:` URL labelled by sniffImageType, or `null` for
 * anything it does not recognise. The only way this codebase builds an
 * icon's `data:` URL, so a label always matches the bytes it names. */
export function toDataUrl (bytes: Uint8Array): string | null {
  const type = sniffImageType(bytes)
  if (type === null) return null
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}

/** A `data:` URL's payload, decoded and capped -- `null` for anything past
 * `cap` bytes or unparseable. The declared media type is not checked here:
 * the caller sniffs the decoded bytes the same way a fetched candidate's
 * bytes are sniffed, rather than trusting a label a page wrote itself. The
 * payload is percent-decoded first, base64 or not, as the fetch spec's
 * `data:` URL processor does; a malformed escape makes this `null`. */
export function decodeDataUrl (url: string, cap: number): Uint8Array | null {
  const match = /^data:([^,]*),(.*)$/is.exec(url)
  if (match === null) return null
  const [, meta = '', payload = ''] = match
  const isBase64 = meta.split(';').some((part) => part.trim().toLowerCase() === 'base64')
  // Refused by length before any decoding: base64 takes 4 characters per 3
  // bytes, and a %XX escape 3 characters per byte, so a longer payload
  // cannot decode to `cap` bytes or fewer.
  const base64Longest = cap * 4 / 3 + 4
  if (payload.length > (isBase64 ? base64Longest : cap) * 3) return null
  const body = percentDecode(payload)
  if (body === null) return null
  if (!isBase64) return body.length > cap ? null : body
  if (body.length > base64Longest) return null
  // Node's base64 decoder skips characters outside the alphabet rather than
  // throwing; whatever that leaves fails sniffImageType instead.
  const bytes = Buffer.from(Buffer.from(body).toString('latin1'), 'base64')
  return bytes.length > cap ? null : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** `text`'s UTF-8 bytes with each `%XX` escape replaced by the byte it names,
 * or `null` for a malformed escape. Bytes, not a string: a percent-encoded
 * binary icon is not valid UTF-8, which decodeURIComponent refuses. */
function percentDecode (text: string): Uint8Array | null {
  const input = Buffer.from(text, 'utf8')
  const out = new Uint8Array(input.length)
  let length = 0
  for (let i = 0; i < input.length; i++) {
    const byte = input[i]!
    if (byte !== 0x25) {
      out[length++] = byte
      continue
    }
    const hex = input.toString('latin1', i + 1, i + 3)
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null
    out[length++] = parseInt(hex, 16)
    i += 2
  }
  return out.subarray(0, length)
}
