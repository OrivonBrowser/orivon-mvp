// Type-only shapes for the routed network path (./wire.ts,
// ./dial.ts, ./core.ts, ./events.ts, ./fetch.ts,
// ./xhr-route*.ts, ./eventsource.ts). Those installers are serialised
// into the main world and may reference nothing outside their own bodies;
// an `interface` produces no JS, so nothing here ever reaches the main
// world. They hand work to each other through `RoutedSlot`, the one object
// they share at runtime (README.md's Design notes).

/** The one shape the routed path needs from `window.orivon.net`'s TcpSocket. */
export interface FetchRouteSocket {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  close: () => Promise<void>
}

export interface FetchRouteTarget {
  orivon?: {
    net?: {
      connect: (opts: { host: string, port: number }) => Promise<FetchRouteSocket>
      connectSecure: (opts: { host: string, port: number }) => Promise<FetchRouteSocket>
    }
  }
  fetch?: (input: unknown, init?: unknown) => Promise<Response>
  location?: { origin: string, href: string }
  navigator?: { userAgent?: string }
  document?: { baseURI?: string }
  XMLHttpRequest?: unknown
  EventSource?: unknown
}

/** The `init` members a routed fetch reads. */
export interface RoutedFetchInit {
  method?: string
  headers?: unknown
  body?: unknown
  signal?: AbortSignal | null
  redirect?: RequestRedirect
}

/** A `Request`, or anything else `fetch()` accepts, read only for the members a `Request` carries. */
export interface RoutedFetchRequestLike {
  url?: string
  method?: string
  headers?: unknown
  signal?: AbortSignal | null
  body?: unknown
  redirect?: RequestRedirect
  clone?: () => { arrayBuffer: () => Promise<ArrayBuffer> }
}

/** A request body already turned into bytes, with the Content-Type its extraction implies. */
export interface ExtractedBody {
  readonly bytes: Uint8Array
  readonly type: string | undefined
}

/** One routed request. `body` is anything `new Response(body)` accepts, or a reader of bytes already extracted. */
export interface RoutedRequest {
  readonly url: URL
  readonly method: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: unknown
  readonly signal: AbortSignal | undefined
  readonly redirect: RequestRedirect
  /** Arms the idle timeout; a caller holding its own signal or timer manages silence itself. */
  readonly idle: boolean
  readonly onUploadProgress?: (loaded: number, total: number) => void
}

/** Incremental response-body framing: `feed` returns the body bytes a chunk carried. */
export interface Framer {
  readonly done: boolean
  readonly endsAtClose: boolean
  feed: (bytes: Uint8Array) => Uint8Array[]
}

export interface ResponseHead {
  readonly status: number
  readonly statusText: string
  readonly headers: Array<[string, string]>
  readonly rest: Uint8Array
}

/** ./wire.ts: the HTTP/1.1 codec. */
export interface RoutedWire {
  readonly acceptEncoding: string
  networkError: (detail: string) => TypeError
  abortReason: (signal: AbortSignal | undefined) => unknown
  headerValue: (pairs: ReadonlyArray<readonly [string, string]>, name: string) => string | undefined
  requestHead: (method: string, url: URL, headers: ReadonlyArray<readonly [string, string]>, body: ExtractedBody | undefined) => Uint8Array
  readHead: (read: () => Promise<Uint8Array | undefined>, leftover: Uint8Array) => Promise<ResponseHead>
  framer: (head: ResponseHead) => Framer
  decode: (stream: ReadableStream<Uint8Array>, contentEncoding: string) => ReadableStream<Uint8Array>
}

/** A dialled socket as the routed path holds it: one reader, one writer, and a close that frees a queue slot. */
export interface RoutedSocket {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  write: (bytes: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

/** ./dial.ts: dialling through the per-origin socket allowance. */
export interface RoutedDial {
  /** Resolves `undefined` when the first hop's host is not granted, so the caller can go native. */
  open: (url: URL, signal: AbortSignal | undefined, firstHop: boolean) => Promise<RoutedSocket | undefined>
}

/** ./core.ts: one whole routed exchange, redirects included. */
export interface RoutedCore {
  /** Cross-origin http(s): the only requests the routed path ever takes. */
  routes: (url: URL) => boolean
  /** Resolves `undefined` when the host is not granted: the caller then behaves like an ordinary page. */
  request: (request: RoutedRequest) => Promise<Response | undefined>
}

/** ./events.ts: event-handler attributes and native-event forwarding, shared by XHR and EventSource. */
export interface RoutedEvents {
  getHandler: (owner: EventTarget, type: string) => unknown
  setHandler: (owner: EventTarget, type: string, value: unknown) => void
  /** Re-dispatches each `types` event from `from` on `to`; `accept` may drop one. Returns a detach function. */
  forward: (from: EventTarget, to: EventTarget, types: readonly string[], accept?: (event: Event) => boolean) => () => void
}

/** ./xhr-response.ts: a routed XHR's received bytes and every `responseType` view of them. */
export interface XhrBody {
  readonly received: number
  push: (chunk: Uint8Array) => void
  text: () => string
  value: (type: string) => unknown
  document: (forResponseXml: boolean) => unknown
}

export interface XhrBodies {
  create: (mime: string) => XhrBody
}

/** The object the installers share, under `Symbol.for('orivon.routed-network')` on the page's window until the last one has run. */
export interface RoutedSlot {
  wire?: RoutedWire
  dial?: RoutedDial
  core?: RoutedCore
  events?: RoutedEvents
  xhrBodies?: XhrBodies
}
