// `installFetchRoute` is handed to `contextBridge.executeInMainWorld`
// (SERIALISED via Function.prototype.toString() and re-run fresh in the main
// world -- no imports, no module-level consts, no closures over anything
// outside its own body). ../expose-fetch-route.ts holds the ordinary,
// non-serialised wiring shared by preload/app.ts and preload/newtab.ts.
//
// ADR-0017: an app's own `fetch()` reaches a GRANTED cross-origin host
// through `window.orivon.net`, carrying whatever headers the app set --
// including ones a page normally cannot (`Origin`, `Cookie`, ...). No cookie
// jar, no ambient credential: every byte comes from the app. A host the app
// was not granted gets the page's native fetch, CORS and all, exactly as an
// ordinary website would. The exchange itself is ./core.ts's.
//
// GATED ON `isAppTab`, decided SYNCHRONOUSLY in main before this ever runs
// -- see this directory's README.md's Design notes for why, and for the
// divergences from a real browser's fetch() that remain.
import type { FetchRouteTarget, RoutedFetchInit, RoutedFetchRequestLike, RoutedSlot } from './types.js'

// Re-exported so no import site changes.
export type { FetchRouteSocket, FetchRouteTarget } from './types.js'

export function installFetchRoute (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const core = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]?.core
  if (core === undefined) return

  const nativeFetch = typeof target.fetch === 'function' ? target.fetch.bind(target) : undefined

  /** Every shape `init.headers`/a Request-like `.headers` can arrive as. Deliberately NEVER routed through a new `Headers` object -- a request guard filters exactly the headers ADR-0017 exists to let an app set (`Origin`, `Cookie`, ...). */
  function headerPairsFrom (raw: unknown): Array<[string, string]> {
    if (raw === null || raw === undefined) return []
    // Array is checked BEFORE the generic `.entries` duck-type below:
    // Array.prototype has its own `.entries()` (index/value pairs), which
    // would otherwise match first and turn `[['X-Test','v1']]` into a
    // single bogus `[0, ['X-Test','v1']]` pair.
    if (Array.isArray(raw)) return (raw as Array<[unknown, unknown]>).map(([k, v]) => [String(k), String(v)])
    const iterable = raw as { entries?: () => Iterable<[string, string]> }
    if (typeof iterable.entries === 'function') return Array.from(iterable.entries())
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
  }

  /** The Fetch spec's method normalisation: only the six standard methods are upper-cased; anything else is sent as written. */
  function normaliseMethod (raw: string): string {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(raw)) throw new TypeError(`'${raw}' is not a valid HTTP method.`)
    const upper = raw.toUpperCase()
    if (upper === 'CONNECT' || upper === 'TRACE' || upper === 'TRACK') throw new TypeError(`'${raw}' HTTP method is unsupported.`)
    return ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].includes(upper) ? upper : raw
  }

  async function native (input: unknown, init?: RoutedFetchInit): Promise<Response> {
    if (nativeFetch === undefined) throw new TypeError('Failed to fetch')
    return await nativeFetch(input, init)
  }

  async function routedFetch (input: unknown, init?: RoutedFetchInit): Promise<Response> {
    const requestLike = input as RoutedFetchRequestLike | null | undefined
    // WHATWG fetch takes `Request | USVString`, and ANYTHING that is not a
    // Request is converted with ToString -- which is why `fetch(new URL(...))`
    // works in every browser.
    let rawUrl: string | undefined
    if (typeof requestLike?.url === 'string') rawUrl = requestLike.url
    else if (input !== null && input !== undefined && typeof input !== 'symbol') rawUrl = String(input)
    if (typeof rawUrl !== 'string') {
      throw new TypeError('orivon: fetch requires a URL, a URL string, or a Request')
    }
    const base = typeof target.location?.href === 'string' ? target.location.href : undefined
    const url = new URL(rawUrl, base)
    if (!core!.routes(url)) return await native(input, init)
    if (url.username !== '' || url.password !== '') throw new TypeError('Request cannot be constructed from a URL that includes credentials')

    // As in real fetch(): init overrides the Request's own, and null is no signal.
    const signal = (init?.signal !== undefined ? init.signal : requestLike?.signal) ?? undefined
    if (signal?.aborted === true) {
      throw signal.reason !== undefined && signal.reason !== null ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
    }

    const method = normaliseMethod(init?.method ?? (typeof requestLike?.method === 'string' ? requestLike.method : 'GET'))
    const headers = headerPairsFrom(init?.headers ?? requestLike?.headers)
    // A Request's own body is read from a clone, so the original is still
    // intact for the native path if the host turns out not to be granted.
    const fromRequest = init?.body === undefined && requestLike?.body !== null && requestLike?.body !== undefined && typeof requestLike.clone === 'function'
    const body = fromRequest
      ? async () => ({ bytes: new Uint8Array(await requestLike.clone!().arrayBuffer()), type: undefined })
      : init?.body ?? undefined
    if ((method === 'GET' || method === 'HEAD') && body !== undefined) throw new TypeError('Request with GET/HEAD method cannot have body.')

    const response = await core!.request({
      url,
      method,
      headers,
      body,
      signal,
      redirect: init?.redirect ?? requestLike?.redirect ?? 'follow',
      // A caller that passed its own signal runs its own clock.
      idle: init?.signal === undefined || init.signal === null
    })
    return response ?? await native(input, init)
  }

  // SYNCHRONOUS, no round trip -- `isAppTab` was already decided in main
  // before this function ever ran, so a page script that runs immediately
  // cannot capture the native fetch first.
  //
  // The descriptor is the platform's own, deliberately -- a page can replace
  // this binding exactly as it can in a browser (ADR-0021, which governs
  // every global installed here).
  Object.defineProperty(target, 'fetch', { value: routedFetch, writable: true, configurable: true, enumerable: true })
}
