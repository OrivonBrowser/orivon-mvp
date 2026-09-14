// The real network I/O behind A143's third-party reach -- serve.ts's own
// `ReachDial`, wired in by electron-serve.ts. Split into its own file
// (Rule 2) because it is the ONE place in src/loader/ that touches a real
// network socket: serve.ts's own header commits to staying free of that so
// it can go on being tested with nothing but a stub LoaderStorage.
//
// NODE'S OWN `node:https`, NOT ELECTRON'S `net.fetch`, AND NOT A HAND-ROLLED
// HTTP CLIENT. `test/e2e-fetch-routing.test.ts`'s own header records why an
// unmodified Electron build cannot be made to trust a locally generated
// test certificate -- which is why that file proves its own byte round trip
// over plain HTTP rather than HTTPS. Node's own `https` module takes a
// per-request `ca` override (`../broker/adapters/tls-adapter.ts`'s own
// established seam, same shape, same "testing only" rule), so THIS
// mechanism can be proven end to end over a real TLS handshake in a real
// Electron launch (tests/serve-reach.test.ts). Preferred over a hand-rolled
// HTTP/1.1 client (the shape `src/preload/fetch-route.ts` is forced into by
// its own `contextBridge` serialisation constraint) because nothing here
// needs that constraint -- Rule 6 says prefer the mature, already-audited
// component once a hand-rolled one is not actually required, and Node's own
// client already handles chunked encoding and keep-alive correctly.
//
// NO SESSION, NO COOKIE JAR, ANYWHERE ON THIS PATH. Node's `https.request`
// has no concept of either -- nothing here reads or stores one. That is a
// property of the transport, not a flag to remember to set (contrast
// Chromium's fetch(), which needs an explicit `credentials: 'omit'` for the
// same guarantee).
//
// REDIRECTS ARE NEVER FOLLOWED. `https.request` only ever reports the
// response it actually received -- there is no auto-follow to disable here,
// unlike Chromium's fetch() (`electron-fetch.ts`'s own `redirect: 'error'`).
// A 3xx from the granted host is handed back to the page as an ordinary 3xx
// response; nothing here re-dispatches it to wherever `Location` points, so
// a granted host can never hand a request off to one nobody approved.

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
