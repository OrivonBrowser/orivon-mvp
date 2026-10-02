// The one place a served type comes from the bytes: a root that is itself a
// file has no name to take an extension from. Mirrors the HTML signatures of
// the WHATWG MIME Sniffing standard; nothing else is ever guessed.

const SIGNATURES = [
  '<!DOCTYPE HTML', '<HTML', '<HEAD', '<SCRIPT', '<IFRAME', '<H1', '<DIV', '<FONT', '<TABLE', '<A', '<STYLE',
  '<TITLE', '<B', '<BODY', '<BR', '<P'
].map((signature) => new TextEncoder().encode(signature))
const COMMENT = new TextEncoder().encode('<!--')

/** The bytes an HTML sniff reads; a longer prefix changes no answer. */
export const SNIFF_BYTES = 512

const isWhitespace = (byte: number): boolean => byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20

function matchesAt (bytes: Uint8Array, at: number, signature: Uint8Array, needsTerminator: boolean): boolean {
  if (at + signature.length + (needsTerminator ? 1 : 0) > bytes.length) return false
  for (let i = 0; i < signature.length; i++) {
    let byte = bytes[at + i]!
    if (byte >= 0x61 && byte <= 0x7a) byte -= 0x20
    if (byte !== signature[i]) return false
  }
  if (!needsTerminator) return true
  const next = bytes[at + signature.length]!
  return next === 0x20 || next === 0x3e
}

/** True when `bytes` start like an HTML document: optional BOM and whitespace, then a known tag or a comment. */
export function looksLikeHtml (bytes: Uint8Array): boolean {
  let at = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3
  while (at < bytes.length && isWhitespace(bytes[at]!)) at++
  if (matchesAt(bytes, at, COMMENT, false)) return true
  return SIGNATURES.some((signature) => matchesAt(bytes, at, signature, true))
}
