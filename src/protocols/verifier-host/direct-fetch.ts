// A GET/HEAD over https to an address pinned in advance, with TLS still
// checked against the real hostname -- the DNS-tamper fallback's actual
// egress (dns-fallback.ts): reached ONLY once a gateway has failed AND the
// system resolver's answer for it disagreed with a DoH one, and only
// through Electron's `net` failing first. `node:https`, not Electron's
// `net`: neither `net.fetch` nor `net.request` can pin a request to a
// chosen address while keeping the real hostname for TLS SNI and the Host
// header (confirmed against electron.d.ts, Electron 44 -- the same gap
// `loader/electron/fetch.ts`'s own header names for the install path).

import { Agent, request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { LookupAddress } from 'node:dns'
import { Readable } from 'node:stream'

export type DirectFetch = (url: string, init: RequestInit | undefined, addresses: readonly string[]) => Promise<Response>

export interface DirectFetchOptions {
  /** Test seam only: a private CA to trust, for a loopback TLS fixture. */
  readonly ca?: string | Buffer
  readonly maxSocketsPerOrigin?: number
}

const DEFAULT_MAX_SOCKETS_PER_ORIGIN = 8
/** No content, or none for this method -- a body would violate the
 * `Response` constructor's own null-body-status rule (the WHATWG spec's
 * "null body status" set, minus 101/103, which a client never receives). */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/** One keep-alive agent per origin, reused across calls -- never the
 * global agent, which every OTHER Electron/Node consumer in this process
 * also draws from. */
const agents = new Map<string, Agent>()

function agentFor (origin: string, maxSockets: number): Agent {
  let agent = agents.get(origin)
  if (agent === undefined) {
    agent = new Agent({ keepAlive: true, maxSockets })
    agents.set(origin, agent)
  }
  return agent
}

function collectHeaders (init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    // A compressed body would fail its own hash check, and would wrongly
    // frame an honest gateway as a liar for something Content-Encoding did.
    'accept-encoding': 'identity'
  }
  if (init?.headers === undefined) return headers
  for (const [key, value] of new Headers(init.headers)) headers[key] = value
  return headers
}

function toWebHeaders (raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (Array.isArray(value)) { for (const one of value) headers.append(key, one) } else headers.set(key, value)
  }
  return headers
}

/**
 * `node:https`'s own `lookup` option, pinned to `addresses` regardless of
 * what the real resolver -- system or Node's built-in -- would say for
 * `hostname`. Node 24's default `autoSelectFamily` asks with `{ all: true
 * }` and expects an array back; a caller not using it asks for one address
 * and a separate `family`. Both forms are answered from the same pinned
 * list, and a request for any hostname but the one this fetch is FOR is
 * refused outright -- this function exists to reach one pinned name, never
 * to become a general resolver a redirect or a subrequest could retarget.
 */
function pinnedLookup (hostname: string, addresses: readonly string[]): (askedHost: string, options: unknown, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => void {
  const entries: LookupAddress[] = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  return (askedHost, options, callback) => {
    if (askedHost !== hostname) { callback(new Error(`pinned to ${hostname}, refusing a lookup for ${askedHost}`), ''); return }
    if ((options as { all?: boolean } | null)?.all === true) { callback(null, entries); return }
    const first = entries[0]
    if (first === undefined) { callback(new Error('no pinned address'), ''); return }
    callback(null, first.address, first.family)
  }
}

/**
 * A direct connection to one of `addresses`, for `url`'s hostname and path
 * -- GET or HEAD only, no redirect ever followed (matches
 * `egress.ts`'s `allowlisted`, which wraps the ordinary path this exists
 * alongside). TLS still verifies the certificate against `url`'s real
 * hostname (`servername`, and no `rejectUnauthorized` override), so a
 * pinned address that cannot present a valid certificate for that name
 * fails exactly as it would over a normal connection.
 */
export function createDirectFetch (options: DirectFetchOptions = {}): DirectFetch {
  const maxSockets = options.maxSocketsPerOrigin ?? DEFAULT_MAX_SOCKETS_PER_ORIGIN
  return async (url, init, addresses) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error(`direct fetch only reaches https, not ${parsed.protocol}`)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') throw new Error(`direct fetch only supports GET/HEAD, not ${method}`)
    if (addresses.length === 0) throw new Error('direct fetch given no pinned address')

    const requestOptions: RequestOptions = {
      method,
      hostname: parsed.hostname,
      servername: parsed.hostname,
      port: parsed.port !== '' ? parsed.port : 443,
      path: `${parsed.pathname}${parsed.search}`,
      headers: collectHeaders(init),
      lookup: pinnedLookup(parsed.hostname, addresses),
      agent: agentFor(parsed.origin, maxSockets),
      ca: options.ca,
      signal: init?.signal ?? undefined
    }

    return await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(requestOptions, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume() // drain so the socket returns to the agent's pool
          reject(new Error(`direct fetch got a ${String(status)} redirect, which it never follows`))
          return
        }
        const encoding = res.headers['content-encoding']
        if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
          res.resume()
          reject(new Error(`asked for accept-encoding: identity but got content-encoding: ${encoding}`))
          return
        }
        const body = method === 'HEAD' || NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
        if (body === null) res.resume()
        resolve(new Response(body, { status, headers: toWebHeaders(res.headers) }))
      })
      req.on('error', reject)
      req.end()
    })
  }
}
