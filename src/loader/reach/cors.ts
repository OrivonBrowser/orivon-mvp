// CORS response headers for the third-party reach path. A worker's fetch or
// a document's XHR reaches this handler rather than the broker's routed
// fetch, and the page may read any response from a host the app holds a
// live grant for. Electron 44 does not enforce CORS on a protocol.handle
// response (measured, test/e2e-served-csp.test.ts), so today these headers
// only keep that true if it ever starts to. Same idea as
// src/main/sessions/web-context-host.ts's context wrapper, which this
// directory may not import.

/** A browser-generated CORS preflight: page script cannot set Access-Control-Request-Method, so an app's own OPTIONS request never matches. */
export function isCorsPreflight (request: Request): boolean {
  return request.method === 'OPTIONS' && request.headers.has('access-control-request-method')
}

/** A preflight answered without reaching the network: everything asked for is allowed, for `appOrigin` only. */
export function preflightResponse (request: Request, appOrigin: string): Response {
  const headers = new Headers({
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '600',
    vary: 'Origin'
  })
  const method = request.headers.get('access-control-request-method')
  const requested = request.headers.get('access-control-request-headers')
  if (method !== null) headers.set('access-control-allow-methods', method)
  if (requested !== null) headers.set('access-control-allow-headers', requested)
  return new Response(null, { status: 204, headers })
}

/** `response` readable by `appOrigin`, every header exposed. Replaces whatever CORS headers the peer sent. */
export function withReachCors (response: Response, appOrigin: string): Response {
  const headers = new Headers(response.headers)
  const names = [...response.headers.keys()].filter((name) => !name.startsWith('access-control-'))
  headers.set('access-control-allow-origin', appOrigin)
  headers.set('access-control-allow-credentials', 'true')
  if (names.length > 0) headers.set('access-control-expose-headers', names.join(', '))
  headers.append('vary', 'Origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
