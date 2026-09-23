// http.request()'s argument handling: the `(url[, options][, cb])` and
// `(options[, cb])` overloads, the URL-to-options conversion, and the
// validation Node performs synchronously before any socket exists.

import { HeaderBag, type HeaderValue } from './node-http-headers.js'
import { codedError } from './node-http-errors.js'
import { validatePort } from './node-net-args.js'

export interface RequestDefaults {
  readonly protocol: 'http:' | 'https:'
  readonly defaultPort: number
}

export type CreateConnection = (options: Record<string, unknown>, oncreate: (error: Error | null, socket?: unknown) => void) => unknown

export interface ResolvedRequestOptions {
  readonly protocol: string
  /** The host to dial: IPv6 brackets stripped. */
  readonly host: string
  readonly port: number
  readonly defaultPort: number
  readonly path: string
  readonly method: string
  readonly headers: HeaderBag
  readonly setHost: boolean
  readonly auth: string | undefined
  readonly timeout: number | undefined
  readonly signal: AbortSignal | undefined
  readonly agent: unknown
  readonly createConnection: CreateConnection | undefined
  /** Every option the caller passed, for createConnection and the TLS socket, as Node forwards them. */
  readonly raw: Readonly<Record<string, unknown>>
}

/** Node's checkIsHttpToken. */
const HTTP_TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/
/** Node's INVALID_PATH_REGEX: anything outside visible latin1 must be escaped. */
const INVALID_PATH = /[^!-ÿ]/

function stripBrackets (host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Node's urlToHttpOptions. */
function urlToOptions (url: URL): Record<string, unknown> {
  const options: Record<string, unknown> = {
    protocol: url.protocol,
    hostname: stripBrackets(url.hostname),
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname}${url.search}`,
    href: url.href
  }
  if (url.port !== '') options.port = Number(url.port)
  if (url.username !== '' || url.password !== '') {
    options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
  }
  return options
}

function headerBagFrom (headers: unknown): HeaderBag {
  const bag = new HeaderBag()
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) bag.set(String(headers[i]), headers[i + 1] as HeaderValue)
  } else if (typeof headers === 'object' && headers !== null) {
    bag.setAll(headers as Record<string, HeaderValue>)
  }
  return bag
}

function stringOption (raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.${key}" property must be of type string. Received ${typeof value}`)
  }
  return value
}

export function resolveRequestOptions (args: readonly unknown[], defaults: RequestDefaults): { options: ResolvedRequestOptions, callback: ((res: unknown) => void) | undefined } {
  const [first, second, third] = args
  let raw: Record<string, unknown>
  let callbackArg: unknown
  if (typeof first === 'string' || first instanceof URL) {
    raw = urlToOptions(typeof first === 'string' ? new URL(first) : first)
    if (typeof second === 'object' && second !== null) { raw = { ...raw, ...second }; callbackArg = third } else callbackArg = second
  } else {
    raw = { ...(first as Record<string, unknown> | undefined) }
    callbackArg = second
  }

  const protocol = stringOption(raw, 'protocol') ?? defaults.protocol
  if (protocol !== defaults.protocol) {
    throw codedError(TypeError, 'ERR_INVALID_PROTOCOL', `Protocol "${protocol}" not supported. Expected "${defaults.protocol}"`)
  }
  const defaultPort = typeof raw.defaultPort === 'number' ? raw.defaultPort : defaults.defaultPort
  const host = stripBrackets(stringOption(raw, 'hostname') ?? stringOption(raw, 'host') ?? 'localhost')
  const portValue = raw.port === undefined || raw.port === null || raw.port === '' || raw.port === 0 ? defaultPort : raw.port
  const path = stringOption(raw, 'path') ?? '/'
  if (INVALID_PATH.test(path)) throw codedError(TypeError, 'ERR_UNESCAPED_CHARACTERS', 'Request path contains unescaped characters')
  const method = (stringOption(raw, 'method') ?? 'GET').toUpperCase()
  if (!HTTP_TOKEN.test(method)) throw codedError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `Method must be a valid HTTP token ["${method}"]`)

  const options: ResolvedRequestOptions = {
    protocol,
    host,
    port: validatePort(portValue),
    defaultPort,
    path,
    method,
    headers: headerBagFrom(raw.headers),
    setHost: raw.setHost !== false,
    auth: stringOption(raw, 'auth'),
    timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    signal: raw.signal instanceof AbortSignal ? raw.signal : undefined,
    agent: raw.agent,
    createConnection: typeof raw.createConnection === 'function' ? raw.createConnection as CreateConnection : undefined,
    raw
  }
  return { options, callback: typeof callbackArg === 'function' ? callbackArg as (res: unknown) => void : undefined }
}
