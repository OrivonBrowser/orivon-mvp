// Type-only shapes for ./fetch-route.ts's `installFetchRoute`. Split out
// under code-guidelines.md Rule 2, by the same reasoning as
// ./main-world-bridges.ts (that file's own header): installFetchRoute's
// serialisation constraint (`Function.prototype.toString()`, re-run fresh
// in the main world) only bites on runtime code, and an `interface`
// produces none -- nothing here ever reaches the main world, only
// installFetchRoute's own compiled body does.

/** The one shape `installFetchRoute` needs from `window.orivon` -- a subset of `../contracts/capability-api.js`'s `Orivon`, repeated here because a serialised main-world function cannot import that type's runtime companions across the boundary (only used for typechecking; erased at compile time). */
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
}

/** The `init` members a routed request reads. */
export interface RoutedFetchInit {
  method?: string
  headers?: unknown
  body?: unknown
  signal?: AbortSignal | null
}

/** A `Request`, or anything else `fetch()` accepts, read only for the members a `Request` carries. */
export interface RoutedFetchRequestLike {
  url?: string
  method?: string
  headers?: unknown
  signal?: AbortSignal | null
  body?: unknown
  arrayBuffer?: () => Promise<ArrayBuffer>
}
