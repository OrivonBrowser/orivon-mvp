// The real network I/O behind A143's third-party reach -- serve.ts's own
// `ReachDial`, wired in by electron-serve.ts. Split into its own file
// (Rule 2) because it is the ONE place in src/loader/ that touches a real
// network socket: serve.ts's own header commits to staying free of that so
// it can go on being tested with nothing but a stub LoaderStorage.
//
// NODE'S OWN `node:https`, deliberately not Electron's `net.fetch` or a
// hand-rolled HTTP/1.1 client, no session/cookie jar anywhere on this path,
// and a redirect is handed back, never followed here: the page's loader
// follows it back through serve.ts's handler, which authorises every hop.
// See README.md's Design notes ("Why serve-reach.ts uses Node's own https
// module") for the reasoning behind each of those, not repeated here.

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
  /** Testing only, like `ca`: production uses `REACH_IDLE_TIMEOUT_MS`. */
  readonly idleTimeoutMs?: number
}

/**
 * How long the connection may carry no bytes in either direction before it
 * is cut: an IDLE timeout, reset by every byte, never a total, so a
 * long-poll or an event stream lives as long as it keeps talking, while a
 * peer that stalls cannot hold a reach slot forever. Provisional.
 */
export const REACH_IDLE_TIMEOUT_MS = 5 * 60_000

/**
 * Two kinds of header, stripped from the OUTBOUND request for two reasons.
 *
 * `host` and `content-length` Node computes itself from `host`/`port` and
 * the body it is handed -- forwarding the app's own copy risks it
 * disagreeing with what Node actually puts on the wire.
 *
 * The rest are RFC 7230 SS6.1's hop-by-hop set, and `transfer-encoding` is
 * why this is a correctness requirement rather than tidiness (A183).
 * `nodeReachDial` sets `content-length` itself; a forwarded
 * `transfer-encoding: chunked` therefore arrives ALONGSIDE it, and Node
 * sends both and chunk-frames the body -- measured, not assumed. A
 * front-end and a back-end that disagree about which header ends the
 * request is the whole of request smuggling, and an app here controls every
 * header and every body byte, so it could get a second, unauthorised
 * request processed behind the one host its grant actually names.
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host', 'content-length',
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
])

/**
 * The RFC 7230 SS6.1 hop-by-hop set, stripped from the response the same way
 * the request side already strips its own three (above) -- each header here
 * describes the hop between the peer and Node's own client, which has
 * already ended by the time anything downstream sees this `Response`.
 * `transfer-encoding` is the concrete case A174 was filed against: this
 * function's own doc says the body is handed to `Response` as a live
 * stream, never rebuffered -- but Node's `http` parser has ALREADY stripped
 * the wire's chunk framing before `res` ever emits a byte, so a forwarded
 * `transfer-encoding: chunked` describes framing that no longer exists on
 * this stream and would be simply false to the app reading it.
 */
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
])

/**
 * A page-supplied request body (a worker's or XHR's POST to a granted host
 * through this handler) is buffered whole in the main process before the
 * dial, so it must be bounded. Exported so a test builds the boundary case
 * against this exact value.
 */
export const REACH_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024

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
    if (value === undefined || HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) continue
    for (const one of Array.isArray(value) ? value : [value]) {
      try { headers.append(name, one) } catch { /* skip -- see doc above */ }
    }
  }
  return headers
}

/**
 * Reads `request`'s body into one `Buffer`, rejecting the instant the
 * running total would exceed `REACH_MAX_REQUEST_BODY_BYTES` -- never
 * buffered past the cap first (A173). This runs in the privileged MAIN
 * process: an app posting a large or unbounded body to a granted host must
 * not be able to drive unbounded allocation here, the same reasoning this
 * file's own header already applies to the RESPONSE side (streamed, never
 * buffered) -- the request side needs the opposite fix, a cap, because it
 * IS buffered, into one `Buffer`, to hand to `httpsRequest` as `content-
 * length`-framed content rather than a second stream.
 */
async function readCappedBody (request: Request): Promise<Buffer | null> {
  if (request.body === null) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > REACH_MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new TypeError(`orivon: request body exceeds the reach body cap of ${String(REACH_MAX_REQUEST_BODY_BYTES)} bytes (REACH_MAX_REQUEST_BODY_BYTES)`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
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
 *
 * THE REQUEST BODY IS THE OPPOSITE SHAPE, AND DOES NEED ONE (A173): it is
 * buffered whole, by design, because `httpsRequest` below sends it as one
 * `content-length`-framed write rather than a second relayed stream -- so
 * `readCappedBody` bounds it at `REACH_MAX_REQUEST_BODY_BYTES` instead,
 * refusing rather than letting an app drive unbounded allocation in this
 * privileged process.
 */
export function nodeReachDial (options: ReachDialOptions = {}): ReachDial {
  const idleTimeoutMs = options.idleTimeoutMs ?? REACH_IDLE_TIMEOUT_MS
  return async (request, host, port) => {
    const url = new URL(request.url)
    const body = await readCappedBody(request)
    const bodyLength = body?.length ?? 0

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpsRequest({
        host,
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardedRequestHeaders(request, bodyLength),
        ca: options.ca,
        // Node's socket timeout: it fires after this long with no socket
        // activity, before and after the response headers alike.
        timeout: idleTimeoutMs
      }, resolve)
      req.once('error', reject)
      req.once('timeout', () => {
        req.destroy(new Error(`reach to ${host}:${String(port)} carried no bytes for ${String(idleTimeoutMs)}ms`))
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
