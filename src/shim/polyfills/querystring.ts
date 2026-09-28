// `querystring` module target (module-map.ts), hand-written: Node's legacy
// application/x-www-form-urlencoded parser, with its own rules (repeated keys
// become arrays, '+' is a space, a malformed escape is kept rather than
// thrown) that URLSearchParams does not share.

import { nodeModule } from './module-proxy.js'

export type ParsedUrlQuery = Record<string, string | string[]>

interface ParseOptions { maxKeys?: number, decodeURIComponent?: (text: string) => string }
interface StringifyOptions { encodeURIComponent?: (text: string) => string }

export function escape (text: unknown): string {
  return encodeURIComponent(typeof text === 'string' ? text : String(text))
}

/** decodeURIComponent, falling back to decoding each valid %XX byte and keeping the rest, as Node's does for a malformed escape. */
export function unescape (text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    const bytes: number[] = []
    for (let at = 0; at < text.length; at++) {
      const hex = text.slice(at + 1, at + 3)
      if (text[at] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); at += 2 } else bytes.push(...new TextEncoder().encode(text[at]))
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
}

export function parse (query: string, sep = '&', eq = '=', options: ParseOptions = {}): ParsedUrlQuery {
  const result: ParsedUrlQuery = Object.create(null) as ParsedUrlQuery
  if (typeof query !== 'string' || query.length === 0) return result
  const decode = options.decodeURIComponent ?? unescape
  const maxKeys = options.maxKeys ?? 1000
  let pieces = query.split(sep)
  if (maxKeys > 0) pieces = pieces.slice(0, maxKeys)
  for (const piece of pieces) {
    if (piece.length === 0) continue
    const at = piece.indexOf(eq)
    const rawKey = at === -1 ? piece : piece.slice(0, at)
    const rawValue = at === -1 ? '' : piece.slice(at + eq.length)
    const key = decode(rawKey.replace(/\+/g, ' '))
    const value = decode(rawValue.replace(/\+/g, ' '))
    const existing = result[key]
    if (existing === undefined) result[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else result[key] = [existing, value]
  }
  return result
}

function primitiveText (value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return ''
}

export function stringify (object: unknown, sep = '&', eq = '=', options: StringifyOptions = {}): string {
  if (typeof object !== 'object' || object === null) return ''
  const encode = options.encodeURIComponent ?? escape
  const fields: string[] = []
  for (const [key, value] of Object.entries(object)) {
    const prefix = encode(key) + eq
    if (Array.isArray(value)) for (const item of value) fields.push(prefix + encode(primitiveText(item)))
    else fields.push(prefix + encode(primitiveText(value)))
  }
  return fields.join(sep)
}

export const decode = parse
export const encode = stringify

export default nodeModule('querystring', { decode, encode, escape, parse, stringify, unescape })
