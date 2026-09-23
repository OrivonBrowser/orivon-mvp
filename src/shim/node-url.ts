// `url` module target (module-map.ts), hand-written: the platform's URL and
// URLSearchParams, Node's file-URL conversions, and the legacy
// parse/format/resolve API older Node code still calls, which the WHATWG URL
// does not replace (it rejects a relative URL and has no Url object).

import { resolve as resolvePath } from 'path'
import { nodeModule } from './node-module-proxy.js'
import { parse as parseQuery, stringify as stringifyQuery, type ParsedUrlQuery } from './node-querystring.js'

export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams

function nodeTypeError (code: string, message: string): TypeError & { code: string } {
  return Object.assign(new TypeError(message), { code })
}

export function fileURLToPath (input: string | URL): string {
  const url = typeof input === 'string' ? new URL(input) : input
  if (url.protocol !== 'file:') throw nodeTypeError('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file')
  if (url.hostname !== '' && url.hostname !== 'localhost') throw nodeTypeError('ERR_INVALID_FILE_URL_HOST', 'File URL host must be "localhost" or empty')
  if (/%2f/i.test(url.pathname)) throw nodeTypeError('ERR_INVALID_FILE_URL_PATH', 'File URL path must not include encoded / characters')
  return decodeURIComponent(url.pathname)
}

/** A relative path resolves against process.cwd(), the virtual root. The URL pathname setter encodes the rest; these five it would leave literal. */
export function pathToFileURL (path: string): URL {
  const url = new URL('file://')
  url.pathname = resolvePath(path).replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09')
  return url
}

export interface Url {
  protocol: string | null
  slashes: boolean | null
  auth: string | null
  host: string | null
  port: string | null
  hostname: string | null
  hash: string | null
  search: string | null
  query: string | ParsedUrlQuery | null
  pathname: string | null
  path: string | null
  href: string
}

const SLASHED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'gopher:', 'file:', 'ws:', 'wss:'])
const HOSTLESS_PROTOCOLS = new Set(['javascript:'])

function splitAt (text: string, marker: string): [string, string | null] {
  const at = text.indexOf(marker)
  return at === -1 ? [text, null] : [text.slice(0, at), text.slice(at)]
}

/** Node's legacy url.parse, over the same field rules. */
export function parse (input: string, parseQueryString = false, slashesDenoteHost = false): Url {
  let [rest, hash] = splitAt(input.trim(), '#')
  let search: string | null
  ;[rest, search] = splitAt(rest, '?')
  const protocolMatch = /^[a-z0-9.+-]+:/i.exec(rest)
  const protocol = protocolMatch === null ? null : protocolMatch[0].toLowerCase()
  if (protocol !== null) rest = rest.slice(protocol.length)
  const slashes = rest.startsWith('//') && (protocol !== null || slashesDenoteHost) && !HOSTLESS_PROTOCOLS.has(protocol ?? '')
  if (slashes) rest = rest.slice(2)

  let auth: string | null = null
  let host: string | null = null
  let hostname: string | null = null
  let port: string | null = null
  if (protocol !== null && !HOSTLESS_PROTOCOLS.has(protocol) && (slashes || !SLASHED_PROTOCOLS.has(protocol))) {
    const [hostPart, remainder] = splitAt(rest, '/')
    rest = remainder ?? ''
    const at = hostPart.lastIndexOf('@')
    if (at !== -1) auth = decodeURIComponent(hostPart.slice(0, at))
    host = hostPart.slice(at + 1).toLowerCase()
    const portMatch = /:(\d*)$/.exec(host)
    port = portMatch === null || portMatch[1] === '' ? null : portMatch[1] ?? null
    hostname = portMatch === null ? host : host.slice(0, portMatch.index)
  }

  let pathname: string | null = rest === '' ? null : rest
  if (pathname === null && hostname !== null && SLASHED_PROTOCOLS.has(protocol ?? '')) pathname = '/'
  const queryText = search === null ? null : search.slice(1)
  const query = parseQueryString ? parseQuery(queryText ?? '') : queryText
  if (parseQueryString && search === null) search = ''
  const path = pathname === null && search === null ? null : (pathname ?? '') + (search ?? '')
  const url: Url = { protocol, slashes: slashes ? true : null, auth, host, port, hostname, hash, search, query, pathname, path, href: '' }
  url.href = format(url)
  return url
}

/** Node's legacy url.format: a Url-shaped object, a WHATWG URL, or a string (parsed first). */
export function format (input: Partial<Url> | URL | string): string {
  if (input instanceof URL) return input.href
  const url = typeof input === 'string' ? parse(input) : input
  const auth = url.auth === undefined || url.auth === null ? '' : encodeURIComponent(url.auth).replace(/%3A/i, ':') + '@'
  let protocol = url.protocol ?? ''
  if (protocol !== '' && !protocol.endsWith(':')) protocol += ':'
  let host = ''
  if (url.host !== undefined && url.host !== null) host = auth + url.host
  else if (url.hostname !== undefined && url.hostname !== null) {
    host = auth + (url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname) + (url.port === undefined || url.port === null ? '' : `:${url.port}`)
  }
  const query = typeof url.query === 'object' && url.query !== null ? stringifyQuery(url.query) : ''
  let search = url.search ?? (query === '' ? '' : `?${query}`)
  let pathname = url.pathname ?? ''
  let hash = url.hash ?? ''
  if (url.slashes === true || SLASHED_PROTOCOLS.has(protocol)) {
    if (url.slashes === true || host !== '') {
      if (pathname !== '' && !pathname.startsWith('/')) pathname = `/${pathname}`
      host = `//${host}`
    }
  }
  if (hash !== '' && !hash.startsWith('#')) hash = `#${hash}`
  if (search !== '' && !search.startsWith('?')) search = `?${search}`
  pathname = pathname.replace(/[?#]/g, (char) => encodeURIComponent(char))
  search = search.replace(/#/g, '%23')
  return protocol + host + pathname + search + hash
}

/** Node's own documented replacement for its legacy resolve, over the WHATWG URL, keeping a relative `from` relative. */
export function resolve (from: string, to: string): string {
  const resolved = new URL(to, new URL(from, 'resolve://'))
  if (resolved.protocol !== 'resolve:') return resolved.toString()
  const { pathname, search, hash } = resolved
  return (from.startsWith('/') ? pathname : pathname.slice(1)) + search + hash
}

export default nodeModule('url', { URL, URLSearchParams, fileURLToPath, format, parse, pathToFileURL, resolve })
