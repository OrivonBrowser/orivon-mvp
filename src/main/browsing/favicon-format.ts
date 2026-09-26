// What bytes an icon actually is, decided by sniffing rather than trusting a
// server's `content-type` header (favicon.ts's own header explains why: an
// `.ico` served as `application/octet-stream`, or SVG served with any label
// at all, is common and today refused only because the header didn't say
// the right thing). Pure -- no Electron import, so `favicon.ts` stays
// importable under plain vitest the same way its own header requires.

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
  if (rest.charCodeAt(0) === 0xfeff) rest = rest.slice(1) // UTF-8 BOM, decoded
  for (;;) {
    const trimmed = rest.replace(/^[\s﻿]+/, '')
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
      const end = trimmed.indexOf('>')
      if (end === -1) return false
      const subset = trimmed.indexOf('[')
      // A DOCTYPE's internal subset (`<!DOCTYPE svg [ <!ENTITY ... > ]>`) is
      // where a "billion laughs" entity bomb is declared -- nested entity
      // references that expand to gigabytes during parsing, script or no
      // script. A real favicon's DOCTYPE never needs one (a bare PUBLIC/
      // SYSTEM reference, as every generator observed here emits, has none),
      // so its mere presence is refused rather than parsed any further.
      if (subset !== -1 && subset < end) return false
      rest = trimmed.slice(end + 1)
      continue
    }
    return /^<svg[\s>/]/i.test(trimmed)
  }
}

/** How much of a candidate is even looked at for the SVG text check --
 * generous enough for a real prolog/doctype/comment, small enough that a
 * non-image response (an HTML error page, say) is rejected without
 * decoding the whole thing as text. */
const SVG_SNIFF_WINDOW = 4 * 1024

/** `null` for anything not recognised -- treated the same as a fetch
 * failure by every caller, same as an unrecognised `content-type` was
 * before this file existed. */
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

/** A `data:` URL's payload, decoded and capped -- `null` for anything past
 * `cap` bytes or unparseable. The declared media type is not checked here:
 * the caller sniffs the decoded bytes the same way a fetched candidate's
 * bytes are sniffed, rather than trusting a label a page wrote itself.
 * Percent-encoded data (rare for an image, but valid per the URL spec) is
 * decoded as UTF-8 text; a malformed escape makes this `null` rather than
 * throw, matching every other function here that reports failure by
 * returning `null`. */
export function decodeDataUrl (url: string, cap: number): Uint8Array | null {
  const match = /^data:([^,]*),(.*)$/is.exec(url)
  if (match === null) return null
  const [, meta = '', payload = ''] = match
  const isBase64 = meta.split(';').some((part) => part.trim().toLowerCase() === 'base64')
  if (isBase64) {
    if (payload.length > cap * 4 / 3 + 4) return null // reject before the (potentially huge) decode
    let bytes: Buffer
    try {
      bytes = Buffer.from(payload, 'base64')
    } catch {
      return null
    }
    return bytes.length > cap ? null : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  // Reject before the decode, the same way the base64 branch above does:
  // a %XX escape is 3 source characters per output byte, the most
  // compact a percent-encoded payload can ever be, so nothing shorter
  // than that ratio could decode to `cap` bytes or fewer regardless of
  // content -- a page-declared candidate never gets a full decode/encode
  // pass just to be rejected for size.
  if (payload.length > cap * 3) return null
  let text: string
  try {
    text = decodeURIComponent(payload)
  } catch {
    return null
  }
  const bytes = new TextEncoder().encode(text)
  return bytes.length > cap ? null : bytes
}
