// One whole routed HTTP exchange (ADR-0017): default headers, the request
// body, redirects, the idle timeout, and a streamed Response. Shared by the
// routed fetch, XMLHttpRequest and EventSource. `installRoutedCore` is
// SERIALISED into the main world (see ./wire.ts's header) and
// publishes `core` on the shared slot; `releaseRoutedSlot` removes that slot
// once every installer has taken what it needs.
import type { ExtractedBody, FetchRouteTarget, ResponseHead, RoutedRequest, RoutedSlot, RoutedSocket } from './types.js'

/** Mirrors the literals `installRoutedCore` keeps inside its own body; see ./wire.ts's ROUTED_MAX_HEAD_BYTES for why they exist twice. */
export const ROUTED_IDLE_TIMEOUT_MS = 300_000
export const ROUTED_MAX_REDIRECTS = 20

export function installRoutedCore (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]
  if (slot?.wire === undefined || slot.dial === undefined) return
  // Fresh bindings, so the narrowing above holds inside every nested function.
  const wire = slot.wire
  const dial = slot.dial

  // A hang detector, not a latency bound: long-polls and quiet event streams
  // routinely sit silent for a minute or two.
  const IDLE_TIMEOUT_MS = 300_000
  const MAX_REDIRECTS = 20
  // How far a body is read ahead of the app, as a browser buffers ahead of
  // its reader: a small response completes, and frees its socket, even when
  // the app never reads it.
  const READ_AHEAD_BYTES = 512 * 1024
  const UPLOAD_PIECE_BYTES = 64 * 1024
  const NULL_BODY_STATUSES = [101, 103, 204, 205, 304]
  const REDIRECT_STATUSES = [301, 302, 303, 307, 308]
  const ORIGIN_BOUND_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'host']
  const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length', 'transfer-encoding']
  // Closes the socket under a streamed body the app dropped unread.
  const unread = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<RoutedSocket>((socket) => { void socket.close() })
    : undefined

  function routes (url: URL): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return target.location === undefined || url.origin !== target.location.origin
  }

  /** Races one socket operation against the caller's abort and, when armed, the idle timeout. Either one closes the socket. */
  function guarded<T> (socket: RoutedSocket, request: RoutedRequest, operation: Promise<T>, what: string): Promise<T> {
    const { signal, idle } = request
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (): void => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      const onAbort = (): void => { settle(); void socket.close(); reject(wire.abortReason(signal)) }
      if (signal?.aborted === true) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (idle) {
        timer = setTimeout(() => {
          settle()
          void socket.close()
          reject(wire.networkError(`${what}: nothing received for ${IDLE_TIMEOUT_MS} ms`))
        }, IDLE_TIMEOUT_MS)
      }
      operation.then((value) => { settle(); resolve(value) }, (error: unknown) => { settle(); reject(error) })
    })
  }

  function has (headers: ReadonlyArray<readonly [string, string]>, name: string): boolean {
    return wire.headerValue(headers, name) !== undefined
  }

  /** A browser always sends these; some APIs refuse a request without a User-Agent. */
  function withDefaults (headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
    const out = headers.map(([k, v]): [string, string] => [k, v])
    const agent = target.navigator?.userAgent
    if (!has(out, 'user-agent') && typeof agent === 'string') out.push(['User-Agent', agent])
    if (!has(out, 'accept')) out.push(['Accept', '*/*'])
    if (!has(out, 'accept-encoding')) out.push(['Accept-Encoding', wire.acceptEncoding])
    return out
  }

  /** Everything `fetch()` accepts as a body, serialised the way the platform does it -- multipart boundary included -- by letting a Response do it. */
  async function extract (body: unknown): Promise<ExtractedBody> {
    if (typeof body === 'function') return await (body as () => Promise<ExtractedBody>)()
    const carrier = new Response(body as BodyInit)
    return { bytes: new Uint8Array(await carrier.arrayBuffer()), type: carrier.headers.get('content-type') ?? undefined }
  }

  async function send (socket: RoutedSocket, request: RoutedRequest, head: Uint8Array, body: ExtractedBody | undefined, host: string): Promise<void> {
    const bytes = body?.bytes ?? new Uint8Array(0)
    if (head.byteLength + bytes.byteLength <= UPLOAD_PIECE_BYTES) {
      const whole = new Uint8Array(head.byteLength + bytes.byteLength)
      whole.set(head)
      whole.set(bytes, head.byteLength)
      await guarded(socket, request, socket.write(whole), host)
    } else {
      await guarded(socket, request, socket.write(head), host)
      for (let at = 0; at < bytes.byteLength; at += UPLOAD_PIECE_BYTES) {
        const piece = bytes.slice(at, at + UPLOAD_PIECE_BYTES)
        await guarded(socket, request, socket.write(piece), host)
        request.onUploadProgress?.(at + piece.byteLength, bytes.byteLength)
      }
      return
    }
    if (bytes.byteLength > 0) request.onUploadProgress?.(bytes.byteLength, bytes.byteLength)
  }

  async function read (socket: RoutedSocket, request: RoutedRequest, host: string): Promise<Uint8Array | undefined> {
    const { done, value } = await guarded(socket, request, socket.reader.read(), host)
    return done ? undefined : value
  }

  /** The response body as a stream the app pulls: framed off the socket as it arrives, never collected first. */
  function bodyStream (socket: RoutedSocket, request: RoutedRequest, head: ResponseHead, host: string): ReadableStream<Uint8Array> {
    const framer = wire.framer(head)
    let leftover: Uint8Array | undefined = head.rest.byteLength > 0 ? head.rest : undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    const { signal } = request
    const finish = (): void => { signal?.removeEventListener('abort', onAbort); void socket.close() }
    const onAbort = (): void => { try { controllerRef?.error(wire.abortReason(signal)) } catch { /* already settled */ } finish() }
    // The abort is watched for the life of the body, not per read.
    const reading: RoutedRequest = { ...request, signal: undefined }
    return new ReadableStream<Uint8Array>({
      start (controller) {
        controllerRef = controller
        signal?.addEventListener('abort', onAbort, { once: true })
      },
      async pull (controller) {
        try {
          for (;;) {
            if (framer.done) { controller.close(); finish(); return }
            const chunk = leftover ?? await read(socket, reading, host)
            leftover = undefined
            if (chunk === undefined) {
              if (framer.endsAtClose) { controller.close(); finish(); return }
              throw wire.networkError(`${host}: the connection closed before the response body completed`)
            }
            // A piece is handed on as its own buffer: a view over the socket's
            // chunk would expose unrelated bytes to code reading `.buffer`.
            const pieces = framer.feed(chunk).filter((p) => p.byteLength > 0)
            for (const piece of pieces) controller.enqueue(piece.byteLength === piece.buffer.byteLength ? piece : piece.slice())
            if (framer.done) { controller.close(); finish(); return }
            if (pieces.length > 0) return
          }
        } catch (error) {
          finish()
          throw error
        }
      },
      cancel () { finish() }
    }, new ByteLengthQueuingStrategy({ highWaterMark: READ_AHEAD_BYTES }))
  }

  function respond (socket: RoutedSocket, request: RoutedRequest, head: ResponseHead, method: string, url: URL, redirected: boolean): Response {
    if (head.status < 200 || head.status > 599) throw wire.networkError(`${url.host} answered with status ${head.status}`)
    const headers = new Headers()
    for (const [name, value] of head.headers) {
      try { headers.append(name, value) } catch { /* a malformed header from the peer is skipped, not fatal */ }
    }
    let body: ReadableStream<Uint8Array> | null = null
    if (method === 'HEAD' || NULL_BODY_STATUSES.includes(head.status)) {
      void socket.close()
    } else {
      body = bodyStream(socket, request, head, url.host)
      const encoding = wire.headerValue(head.headers, 'content-encoding')
      if (encoding !== undefined && wire.headerValue(head.headers, 'content-length') !== '0') body = wire.decode(body, encoding)
      unread?.register(body, socket)
    }
    const response = new Response(body, { status: head.status, statusText: head.statusText, headers })
    const finalUrl = new URL(url.href)
    finalUrl.hash = ''
    Object.defineProperty(response, 'url', { value: finalUrl.href, configurable: true })
    Object.defineProperty(response, 'redirected', { value: redirected, configurable: true })
    return response
  }

  /** A `redirect: 'manual'` answer, shaped like the platform's opaque-redirect response: status 0, no headers, no body. */
  function opaqueRedirect (url: URL): Response {
    const response = Response.error()
    Object.defineProperty(response, 'type', { value: 'opaqueredirect', configurable: true })
    Object.defineProperty(response, 'url', { value: url.href.replace(/#.*$/, ''), configurable: true })
    return response
  }

  async function request (req: RoutedRequest): Promise<Response | undefined> {
    let url = req.url
    let method = req.method
    let headers = withDefaults(req.headers)
    let bodySource = req.body
    let body: ExtractedBody | undefined
    for (let hop = 0; ; hop++) {
      // The grant is checked again on every hop: a redirect to a host the
      // app was never granted fails here rather than going native mid-chain.
      const socket = await dial.open(url, req.signal, hop === 0)
      if (socket === undefined) return undefined
      try {
        if (bodySource !== undefined && bodySource !== null && body === undefined) body = await extract(bodySource)
        await send(socket, req, wire.requestHead(method, url, headers, body), body, url.host)
        const head = await wire.readHead(async () => await read(socket, req, url.host), new Uint8Array(0))
        if (!REDIRECT_STATUSES.includes(head.status)) return respond(socket, req, head, method, url, hop > 0)
        if (req.redirect === 'error') throw wire.networkError(`${url.host} redirected, and the request said redirect: 'error'`)
        if (req.redirect === 'manual') { void socket.close(); return opaqueRedirect(url) }
        const location = wire.headerValue(head.headers, 'location')
        if (location === undefined) return respond(socket, req, head, method, url, hop > 0)
        void socket.close()
        if (hop + 1 > MAX_REDIRECTS) throw wire.networkError(`more than ${MAX_REDIRECTS} redirects`)
        let next: URL
        try { next = new URL(location, url) } catch { throw wire.networkError(`${url.host} redirected to an invalid URL`) }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw wire.networkError(`${url.host} redirected to ${next.protocol}`)
        if (next.hash === '' && url.hash !== '') next.hash = url.hash
        if ((head.status === 303 && method !== 'GET' && method !== 'HEAD') || ((head.status === 301 || head.status === 302) && method === 'POST')) {
          method = 'GET'
          bodySource = undefined
          body = undefined
          headers = headers.filter(([k]) => !BODY_HEADERS.includes(k.toLowerCase()))
        }
        if (next.origin !== url.origin) headers = headers.filter(([k]) => !ORIGIN_BOUND_HEADERS.includes(k.toLowerCase()))
        url = next
      } catch (error) {
        void socket.close()
        if (req.signal?.aborted === true) throw wire.abortReason(req.signal)
        if (error instanceof TypeError && error.message === 'Failed to fetch') throw error
        throw wire.networkError(`${url.host}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  slot.core = { routes, request }
}

/** Removes the shared slot from the page's window once every installer has read it. */
export function releaseRoutedSlot (
  target: object = typeof window === 'undefined' ? {} : window
): void {
  delete (target as Record<symbol, unknown>)[Symbol.for('orivon.routed-network')]
}
