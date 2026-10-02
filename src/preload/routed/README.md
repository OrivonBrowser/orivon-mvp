# `src/preload/routed/`: the routed network path

**What lives here.**
[ADR-0017](../../../docs/decisions/ADR-0017-orivon-owns-the-app-http-path.md)'s routed network
path: ten installers, each serialised into an app tab's main world by
[`../expose-fetch-route.ts`](../expose-fetch-route.ts) in the order it lists them, and
`types.ts` and `websocket-types.ts`, type-only. Each file's header says what it does.

**What it depends on.** [`../../contracts/`](../../contracts/) for types, and, inside an
installer's own body only, `orivon.net` on the page's `window`, never imported.

**What it must never import.** [`../../broker/`](../../broker/). No file here may import another
either: each installer is serialised alone.

## Design notes

**Whether the path is installed at all** is decided per tab, in main:
[`../README.md`](../README.md)'s Design notes.

**Ten installers, one shared slot.** The one thing they share at run time is an object at
`Symbol.for('orivon.routed-network')` on the page's window: each reads what the ones before it
published and adds its own, and `releaseRoutedSlot` deletes the slot after the last, before any
page script. A page that recreates the key gets nothing, since every installer captured its
references at install. This keeps one copy of the codec without one oversized function body.
Every routed test re-evaluates each installer from its own source text
(`tests/routed.test-helpers.ts`'s `reserialised`), so a reference to anything outside a
function's body fails there as it would in a page.

**Routed or native is decided per request, and a denial is not an error.** Only a cross-origin
http(s) request is routed. The grant check is the dial: `'denied'` on the first hop hands the
request, untouched, to the page's native API. A `Request`'s body is read from a clone and
extracted only after the dial succeeds, so the native path still receives it. Mid-redirect there
is no native fallback: a hop to an ungranted host fails the request.

**Attribution, not just routing -- a caller `../surface/main-world-socket.ts`'s own filter would
refuse also gets the native path, never the dial.** The replaced `fetch`, `XMLHttpRequest`,
`EventSource` and `WebSocket` are, to Chromium, the page's own globals -- exactly what
`window.orivon`'s own filter exists to stop an extension's MAIN-world script from abusing
(ADR-0045); without this, a routed global would hand an extension the app's own grant with no
CORS, unlike `window.orivon` itself. Each replaced entry point checks its caller SYNCHRONOUSLY, at
the exact point it decides routed vs. native (`fetch()`'s own body; `XMLHttpRequest`'s `open()`;
the `EventSource`/`WebSocket` constructors) -- before any `await`, since an async continuation has
no caller frame left to capture, the same constraint `guarded`'s own doc states. A refused caller
gets exactly the native path an ungranted host already takes, never a thrown error. The check
itself is `installOrivon`'s own (`main-world-socket.ts`'s `guarded`), read through
`target[Symbol.for('orivon.internal-net')]`'s `callerIsPage` -- the same private slot `dial.ts`
already reads its unwrapped `net.connect`/`connectSecure` from -- never a third copy of the
decision logic.

**A WebSocket is decided the same way, once, before its handshake.** It is routed when its URL,
read as `http(s):`, is cross-origin, so a dev server's hot-reload socket on the page's own host
and port stays native, where the dev CSP's `connect-src 'self'` admits it (measured in Electron
44, `test/e2e-websocket-routing.test.ts`; one on another port is refused). On `'denied'` the
native `WebSocket` is built and its events re-dispatched; a CSP refusal there fires `error` and
goes `CLOSED` with no `close` event (measured), passed on unchanged. A handshake redirect fails
the connection, as in Chromium.

**This folder's numbers.** Each is a literal inside its installer, mirrored by an exported
constant the tests hold it to.

| Constant | Value | File | Bounds |
|---|---|---|---|
| `ROUTED_QUEUE_MAX_WAIT_MS` | 120 s | `dial.ts` | A dial queued after `'limit'` |
| `ROUTED_LIMIT_RETRY_MS` | 500 ms | `dial.ts` | The back-off before the queue's head retries |
| `ROUTED_IDLE_TIMEOUT_MS` | 300 s | `core.ts` | Silence from the peer, with no caller signal or XHR `timeout` |
| `ROUTED_MAX_REDIRECTS` | 20 | `core.ts` | The Fetch spec's limit |
| `ROUTED_MAX_HEAD_BYTES` | 256 KiB | `wire.ts` | A response head: Chromium's cap |
| `WEBSOCKET_OPENING_TIMEOUT_MS` | 240 s | `websocket.ts` | The opening handshake, queue wait included (Chromium's) |
| `WEBSOCKET_CLOSING_TIMEOUT_MS` | 60 s | `websocket.ts` | The peer's answer to a close frame (Chromium's) |
| `WEBSOCKET_CLOSE_LINGER_MS` | 2 s | `websocket.ts` | The peer dropping TCP after both close frames (Chromium's) |

- **The queue** (`dial.ts`'s header): a request that exhausts it fails like a network error,
  where a browser would wait on. The broker counts the origin's sockets before dialling
  (`src/broker/capabilities/socket-room.ts`), so a refused dial costs the remote host nothing.
  There is **no per-host cap**: a routed request is one HTTP/1.1 exchange per socket, and a
  browser's six per host measured 19.5 s against 5.7 s without, for FreeTube refreshing a
  hundred subscriptions. The allowance the person granted is the bound.
- **The idle timeout** is a hang detector, far longer than any long-poll or quiet event stream.
  An EventSource treats it as a dropped stream and reconnects.
- **A response body** is read up to 512 KiB ahead of the app, so a small response frees its
  socket even unread; a larger one dropped unread closes when garbage-collected, and one the
  app is reading never does, however slowly it reads. The collection is watched on a plain
  object the stream's own closures hold, not on the stream, whose JS wrapper the engine may drop
  while the Response still owns it. No body cap.
- **A WebSocket** has no idle timeout once open and no message size cap; outbound frames go in
  pieces of at most 64 KiB.

**This folder's remaining divergences from a browser.** ADR-0017's Consequences require them
written down, since a silent divergence in a web platform API is a trap.

- **Mixed content is not blocked on this path** (A117): an `https` page reaches a granted
  `http://` or `ws:` host, only one the manifest named and a person granted. ADR-0017 records
  why.
- **No cookie jar, cache or credentials mode.** `credentials`, `withCredentials`, `cache`,
  `referrer`, `integrity` and `keepalive` are accepted and ignored; a `Set-Cookie` is visible to
  the app, never stored. `mode: 'no-cors'` still yields a readable response.
- **One connection per request**: `Connection: close`, no keep-alive pool (A208).
- **Headers.** `User-Agent`, `Accept: */*` and `Accept-Encoding` are sent unless the app set its
  own. `br` is advertised only when `DecompressionStream` accepts `'brotli'` (detected at
  install); otherwise a `br` response fails like a network error. No `Origin` or `Referer`: a
  native client sends neither, and some servers refuse a foreign `Origin` (FreeTube's own main
  process strips it for that reason).
- **`new Request(url, { headers })`** drops the headers a page may not set before this code sees
  them; `fetch(url, { headers })` keeps them.
- **Response shape.** `response.type` is `'default'`; `redirect: 'manual'` gives an
  `'opaqueredirect'`, status 0. A network failure is `TypeError('Failed to fetch')`, the message
  retry libraries match, with the detail on `cause`. Each failed request, from `fetch`, XHR or
  `EventSource`, also writes one `console.error` line (`GET https://host/path failed: <reason>`,
  query string left out), as Chromium prints a line for a native one: an app that shows only the
  error would otherwise never show the reason.
- **XMLHttpRequest.** A synchronous `open(..., false)` goes native. `xhr.upload instanceof
  XMLHttpRequestUpload` is false. A `'document'` response is parsed with `DOMParser`.
- **WebSocket.** No extension, so `extensions` is `''`. The upgrade carries the page's origin as
  `Origin`, unlike a routed `fetch`, and no cookie. The page's CSP does not apply. The native
  constructor runs only once the grant has answered, so one that would throw (a mixed-content
  `SecurityError`) surfaces as `error` then `close` 1006. A routed socket holds one of the
  origin's `orivon.net` sockets for life, so long-lived sockets narrow what requests can dial.
  Failures are logged in Chromium's wording.
- **Workers and iframes** get neither routing nor the shim's globals: a preload runs only in a
  tab's top-level frame, so an app that moves its network calls into a worker loses routing
  there.

A passive load (`<img>`, `<link>`, `<video>`) to a granted host never reaches this folder: it is
served through `protocol.handle` in the app's partition, with its own divergences
([`../../loader/reach/README.md`](../../loader/reach/README.md)).
