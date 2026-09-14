// The real network I/O behind A143's third-party reach -- serve.ts's own
// `ReachDial`, wired in by electron-serve.ts. Split into its own file
// (Rule 2) because it is the ONE place in src/loader/ that touches a real
// network socket: serve.ts's own header commits to staying free of that so
// it can go on being tested with nothing but a stub LoaderStorage.
//
// NODE'S OWN `node:https`, deliberately not Electron's `net.fetch` or a
// hand-rolled HTTP/1.1 client, no session/cookie jar anywhere on this path,
// and redirects are never followed -- see README.md's Design notes ("Why
// serve-reach.ts uses Node's own https module") for the full reasoning
// behind each of those, not repeated here.

import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import type { ReachDial } from './serve.js'

/**
 * Mirrors `../broker/adapters/tls-adapter.ts`'s own `DialTlsOptions.ca`
 * exactly -- same shape, same rule: production wiring supplies none,
 * trusting only the runtime's own root store; a test supplies one to trust
 * a throwaway CA generated for that run (there is no other way to hand a
 * local test server a certificate a real trusted root actually signed).
 */
export interface ReachDialOptions {
  readonly ca?: string | Buffer | Array<string | Buffer>
}

/** Generous, not tuned -- a stalled or malicious peer must not hold a request open forever. LIMITS-style tuning is future work, not blocking this lane. */
const REACH_TIMEOUT_MS = 30_000

/** Headers Node's own client computes itself from `host`/`port`/the body it is handed -- forwarding the app's own copy risks it disagreeing with what Node actually sends on the wire. */
const HOP_BY_HOP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length'])

function forwardedRequestHeaders (request: Request, bodyLength: number): Record<string, string> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value
  })
  if (bodyLength > 0) headers['content-length'] = String(bodyLength)
  return headers
}

/** A malformed header from the peer must not fail the whole response -- it is dropped, the same choice `src/preload/fetch-route.ts`'s own `readResponse` makes for the identical case. */
function forwardedResponseHeaders (res: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) {
      try { headers.append(name, one) } catch { /* skip -- see doc above */ }
    }
  }
  return headers
}

/**
 * Builds a `ReachDial` (serve.ts's own type) that performs a real HTTPS
 * request to `host`:`port` over Node's own network stack, forwarding
 * `request`'s method, headers and body, and returning whatever the peer
 * actually answered as a `Response`.
 *
 * THE RESPONSE BODY STREAMS; IT IS NEVER BUFFERED HERE. `Readable.toWeb`
 * hands the incoming message straight to the `Response` constructor, so a
 * large media file is read incrementally by whatever consumes the
 * `Response`, not held whole in this process's memory -- no size cap is
 * needed on this side for the same reason an ordinary browser network
 * response needs none.
 */
export function nodeReachDial (options: ReachDialOptions = {}): ReachDial {
  return async (request, host, port) => {
    const url = new URL(request.url)
    const body = request.body === null ? null : Buffer.from(await request.arrayBuffer())
    const bodyLength = body?.length ?? 0

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpsRequest({
        host,
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardedRequestHeaders(request, bodyLength),
        ca: options.ca,
        timeout: REACH_TIMEOUT_MS
      }, resolve)
      req.once('error', reject)
      req.once('timeout', () => {
        req.destroy(new Error(`reach to ${host}:${String(port)} timed out after ${String(REACH_TIMEOUT_MS)}ms`))
      })
      if (bodyLength > 0 && body !== null) req.end(body)
      else req.end()
    })

    // The five HTTP statuses the Fetch spec calls a "null body status" --
    // mirrors src/preload/fetch-route.ts's own isNullBodyStatus (Rule 3:
    // same idea, not extracted into a shared module -- that file is forced
    // to stay self-contained for contextBridge serialisation, so a second,
    // tiny copy here is the honest cost, not a missed extraction).
    const status = res.statusCode ?? 502
    const nullBody = request.method === 'HEAD' || status === 101 || status === 103 || status === 204 || status === 205 || status === 304
    const responseBody = nullBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>

    return new Response(responseBody, {
      status,
      statusText: res.statusMessage ?? '',
      headers: forwardedResponseHeaders(res)
    })
  }
}
