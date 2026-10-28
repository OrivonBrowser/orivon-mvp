// A fetch for the Ethereum servers the person runs on this computer or on their home network, at an address literal they
// typed in Settings. Node sockets straight to that address: never a proxy and never the tunnel, so a request can not reach
// the network of a tunnel's exit, and nothing the person did not name is reachable. It is the reverse of direct-fetch.ts's
// fence (public addresses only) and keeps its own: only localhost, a loopback literal or a private one is dialled, and
// only by a request `allowlisted` already admitted.

import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import { collectHeaders, pinnedLookup, sendNodeRequest } from './direct-fetch.js'
import type { WebFetch } from './egress.js'
import { isLocalLiteral, maskEndpoint } from './light-client/endpoint-mask.js'

export interface LocalRpcFetchOptions {
  readonly idleTimeoutMs?: number
  /** The most bytes an answer may hold; a node's answers are small, so a larger one is a server gone wrong. */
  readonly maxResponseBytes?: number
  /** Test builds only: trusts a private CA for an https fixture. */
  readonly ca?: string | Buffer
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_SOCKETS = 8
/** `localhost` is pinned to the loopback addresses, so a resolver's answer for it can not send the request elsewhere. */
const LOOPBACK = ['127.0.0.1', '::1'] as const

export interface LocalTarget {
  /** The host without brackets. */
  readonly hostname: string
  readonly addresses: readonly string[]
}

/** Where a request to `url` may go, or why not. Names the host masked: the refusal is read on screen and in a log. */
export function localTargetOf (url: string): LocalTarget {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`a local fetch only reaches http and https, not ${parsed.protocol}`)
  if (parsed.username !== '' || parsed.password !== '') throw new Error('a local fetch does not take credentials in the address')
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!isLocalLiteral(hostname)) throw new Error(`a local fetch refuses to reach ${maskEndpoint(url)}: it is neither this computer nor an address on a home network`)
  return { hostname, addresses: hostname === 'localhost' ? LOOPBACK : [hostname] }
}

function bodyOf (body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('a local fetch carries a string or bytes as its body')
}

/** `response` with its body ended by an error once it holds more than `max` bytes. */
function capped (response: Response, max: number): Response {
  // A HEAD, or a status with no content, has a length header and no body: nothing to hold back.
  if (response.body === null) return response
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    response.body.cancel().catch((error: unknown) => { console.error('[verifier] a local node\'s oversized answer could not be dropped:', error) })
    throw new Error(`a local node's answer is larger than ${String(max)} bytes`)
  }
  let seen = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform (chunk, controller) {
      seen += chunk.byteLength
      if (seen > max) controller.error(new Error(`a local node's answer is larger than ${String(max)} bytes`))
      else controller.enqueue(chunk)
    }
  })
  return new Response(response.body.pipeThrough(counter), { status: response.status, headers: response.headers })
}

/**
 * A `fetch` that reaches only localhost and loopback or private address literals: GET, HEAD or POST over http or https, a
 * redirect handed back as a response and never followed (`allowlisted` turns it into the refusal), no cookie, no cache and
 * no proxy (Node's own sockets read no Chromium proxy setting). A certificate is checked as any client checks it.
 */
export function createLocalRpcFetch (options: LocalRpcFetchOptions = {}): WebFetch {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const plain = new HttpAgent({ keepAlive: true, maxSockets: MAX_SOCKETS })
  const secure = new HttpsAgent({ keepAlive: true, maxSockets: MAX_SOCKETS, ...(options.ca !== undefined && { ca: options.ca }) })
  return async (url, init) => {
    const target = localTargetOf(url)
    const parsed = new URL(url)
    const https = parsed.protocol === 'https:'
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new Error(`a local fetch only supports GET, HEAD and POST, not ${method}`)
    const body = method === 'POST' ? bodyOf(init?.body) : undefined
    const headers = collectHeaders(init)
    if (body !== undefined) headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength)
    const requestOptions: RequestOptions = {
      method,
      hostname: target.hostname,
      port: parsed.port !== '' ? parsed.port : https ? 443 : 80,
      path: `${parsed.pathname}${parsed.search}`,
      headers,
      ...(target.hostname === 'localhost' && { lookup: pinnedLookup('localhost', target.addresses) }),
      agent: https ? secure : plain,
      signal: init?.signal ?? undefined,
      timeout: idleTimeoutMs
    }
    const response = await sendNodeRequest({ request: https ? httpsRequest : httpRequest, options: requestOptions, method, body, hostname: target.hostname, idleTimeoutMs, allowRedirect: true, label: 'local fetch' })
    return capped(response, maxBytes)
  }
}
