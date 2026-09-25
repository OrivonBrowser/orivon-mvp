# `src/preload/routed/`: the routed network path

**What lives here.** ADR-0017's routed network path: `wire.ts` (the HTTP/1.1 codec), `dial.ts`
(dialling through the socket allowance), `core.ts` (one whole exchange), `events.ts` (handler
attributes and native-event forwarding), `fetch.ts`, `xhr.ts`, `xhr-response.ts`,
`eventsource.ts`, `websocket.ts` and `websocket-frames.ts` (the RFC 6455 codec and handshake
checks), plus `types.ts` and `websocket-types.ts` for the shapes each installer needs, type-only.
Wired by [`../expose-fetch-route.ts`](../expose-fetch-route.ts).

**What it depends on.** [`../../contracts/`](../../contracts/) for types, and -- inside one
installer's own serialised function body only -- `orivon.net` on the page's `window` (never
imported; see Design notes for why nothing here can import another file in this folder).

**What it must never import.** [`../../broker/`](../../broker/), and no file in this folder may
import another: each installer is serialised into the main world on its own (see Design notes).

**Owner stream.** `broker`, build step 2.

## Design notes

**Why the `isAppTab` gate is a synchronous main-process decision, not an async check inside the
main world (ADR-0017, queue item 3.4):**

- **`window.orivon` (hence `orivon.net`) is exposed to EVERY ordinary tab**, registered app or
  not, because an app is discovered via a `<link>` hint rather than installed up front. Routing
  `fetch()` unconditionally the instant `orivon.net` exists would deny every cross-origin
  `fetch()` call on the open web the moment this shipped, since an ordinary website has no grant
  for anything.
- **Gating on `orivon.app.manifest()` resolving, awaited from INSIDE the main-world
  `installFetchRoute` function, would race.** That check answers the identical question
  (`Broker`'s `GrantLedger.manifestFor`) but over a real IPC round trip, so it is asynchronous,
  and a page's own first script (a FreeTube-class app fires requests immediately at startup, per
  A100's own reasoning against just-in-time prompting) could run and capture the native `fetch`
  reference before that promise ever settled. A first call racing ahead of the gate is the single
  most likely call in an app's life to hit this window, and it would succeed or fail
  nondeterministically depending on load timing, which is worse than either outcome being
  consistent.
- **So the decision lives where a synchronous answer is actually available: `src/main/
  shell/tabs.ts`, in the SAME process as the broker.** `Broker.app.isRegisteredSync`
  (`../../broker/index.ts`) reads the identical in-memory ledger state `orivon.app.manifest()`
  answers, with no IPC round trip; `Broker.fs.confineSync` (ADR-0016) is the precedent for a
  synchronous sibling of an already-async method for exactly this reason.
  `src/main/shell/tab-view.ts`'s `appTabArgsFor` calls it once, at `WebContentsView` construction
  (`tabs.ts`'s `createTab()`/`repartitionView()`), and hands the answer over as a
  `webPreferences.additionalArguments` flag (`'--orivon-app-tab'`), the exact mechanism
  `newtab.ts` already uses for its own dashboard-URL check, read synchronously off `process.argv`
  in [`../expose-fetch-route.ts`](../expose-fetch-route.ts)'s `exposeFetchRoute()` before any
  installer runs. No promise, no race.
- **A known, remaining limitation:** the decision is fixed for the life of one `WebContentsView`.
  An origin registered AFTER a tab already showing it was created keeps that tab's ORIGINAL
  answer until the next navigation swaps in a fresh view, the same lifetime `additionalArguments`
  already has for every other flag on this list, not a new gap this feature introduces.
  `expose-shim-globals.ts` (A151) reads the identical flag for the identical reason, and inherits
  this exact limitation: a page discovered and installed during its OWN first visit does not get
  shimmed Node globals until the next navigation to it, once `appTabArgsFor` can answer `true` at
  `WebContentsView` construction.

**This folder is ten installers, and they share one slot.** Each of [`wire.ts`](wire.ts) (the
HTTP/1.1 codec), [`dial.ts`](dial.ts) (dialling through the socket allowance), [`core.ts`](core.ts)
(one whole exchange), [`events.ts`](events.ts) (handler attributes and native-event forwarding),
[`fetch.ts`](fetch.ts), [`xhr-response.ts`](xhr-response.ts), [`xhr.ts`](xhr.ts),
[`eventsource.ts`](eventsource.ts), [`websocket-frames.ts`](websocket-frames.ts) (the RFC 6455
codec and handshake checks) and [`websocket.ts`](websocket.ts) is serialised into the main world
on its own, so none of them can import another; the one thing they share at run time is an
object at `Symbol.for('orivon.routed-network')` on the page's window. Each reads what the ones
before it published and adds its own, in the order `../expose-fetch-route.ts` lists them, and
`releaseRoutedSlot` deletes the slot once the last has run, before any page script. A page that
recreates the key gets nothing: every installer captured its references at install. This is how
the path stays under code-guidelines.md Rule 2 without a second copy of the codec: one function
body cannot hold it all, and a shared helper module is exactly what a serialised function cannot
call. `types.ts` and `websocket-types.ts` hold the shapes, type-only, for the same reason
`../surface/main-world-bridges.ts` does. Every routed test re-evaluates each installer from its
own source text (`tests/routed.test-helpers.ts`'s `reserialised`), so a reference to anything
outside a function's body fails there as it would in a page.

**Routed or native is decided per request, and a denial is not an error.** A request goes routed
only when it is cross-origin http(s). The broker's grant check is the dial itself: `'denied'` on
the first hop hands the request, untouched, to the page's native `fetch`/`XMLHttpRequest`/
`EventSource`, which is what an ordinary website would get. A Request's body is read from a clone
and the body is extracted only after the dial succeeds, so the native path still receives it
intact. Mid-redirect there is no native fallback: a hop to an ungranted host fails the request.

**A WebSocket is decided the same way, once, before its handshake.** It is routed when its URL
(`http(s):` already turned into `ws(s):`, as the constructor does) is cross-origin once read as
its `http(s):` equivalent, so a dev server's own hot-reload socket on the page's host and port
stays native, where the dev CSP's `connect-src 'self'` admits it (measured in Electron 44,
`test/e2e-websocket-routing.test.ts`; one on another port is refused). A `wss:` socket dials
`orivon.net.connectSecure`, checked against `https.connect`: an HTTP/1.1 Upgrade over the
broker-terminated TLS is the same traffic an https grant already authorises. A `ws:` socket dials
`orivon.net.connect`, as a routed `http:` request does. Both dial through the same queue.
`'denied'` constructs the page's native `WebSocket` and re-dispatches its events, so the page's
CSP then applies as on any page; a CSP refusal is measured to fire `error` and go `CLOSED` with
no `close` event, which is passed on unchanged. A handshake redirect fails the connection, as
Chromium does.

**This folder's numbers.** Each is a literal inside its installer, mirrored by an exported
constant the tests hold it to.

- `ROUTED_QUEUE_MAX_WAIT_MS` (120 s) and `ROUTED_LIMIT_RETRY_MS` (500 ms), `dial.ts`. A dial
  refused `'limit'` (the origin's socket allowance, or the control channel's rate limiter, which
  answers the same code) waits in a FIFO queue. Only the queue's head is woken, when a routed
  socket from this page has been released by the broker or after the back-off, since the
  allowance is per origin and other tabs or the app's own `orivon.net` sockets hold it too. A
  browser queues past its connection limit and never fails a request for it; the bounded wait is
  the one divergence, and a request that exhausts it fails like a network error. The broker looks
  at the origin's socket count before it dials (`src/broker/capabilities/socket-room.ts`), so a refused dial
  costs the remote host no connection or TLS handshake. There is no per-host cap: a browser opens
  six HTTP/1.1 connections to a host but reaches most busy hosts over HTTP/2, while a routed
  request is one HTTP/1.1 exchange per socket, so six per host would slow a burst badly (FreeTube
  refreshing a hundred subscriptions measured 19.5 s against 5.7 s). The allowance the person
  granted is the bound.
- `ROUTED_IDLE_TIMEOUT_MS` (300 s), `core.ts`. With no caller signal (fetch) or `timeout` (XHR), a
  request that receives nothing for this long, while it is waiting on the peer, fails like a
  network error and frees its socket. It is a hang detector: long-polls and quiet event streams
  sit silent for a minute or two, so it is deliberately far longer than any of them. An
  EventSource treats it as a dropped stream and reconnects.
- `ROUTED_MAX_REDIRECTS` (20), the Fetch spec's own limit.
- `ROUTED_MAX_HEAD_BYTES` (256 KiB), `wire.ts`: Chromium's own response-head cap.
- A response body is read ahead up to 512 KiB of the app, as a browser buffers ahead of its
  reader, so a small response completes and frees its socket even when the app never reads it
  (an app checking only `response.ok` is common). A larger body the app drops unread is closed
  when it is garbage-collected. There is no body cap.
- `WEBSOCKET_OPENING_TIMEOUT_MS` (240 s), `WEBSOCKET_CLOSING_TIMEOUT_MS` (60 s) and
  `WEBSOCKET_CLOSE_LINGER_MS` (2 s), `websocket.ts`: Chromium's own bounds on the whole opening
  handshake (queue wait included), on the peer's answer to a close frame, and on the peer
  dropping TCP once both close frames have crossed. An open routed WebSocket has no idle timeout.
- An outbound WebSocket frame is written in pieces of at most 64 KiB, each its own buffer; there
  is no message size cap in either direction.

**This folder's remaining divergences from a browser.** ADR-0017's own Consequences section
requires these be written down plainly, since "a silent divergence in a web platform API is a
trap":

- **Mixed-content blocking does not apply on this path (`A117`).** A page served over `https` can
  reach an `http://` granted host through a routed request, which its own renderer would have
  refused. Stated narrowly, because the wider claim would be wrong: Orivon does not permit mixed
  content generally; this one routed path does not apply an enforcement the renderer otherwise
  performs, and only for a host named in the manifest and granted by a person at install. That
  grant is what makes it defensible rather than merely undetected: the request goes to somewhere
  the user reviewed, not anywhere the page chose.
- **No cookie jar, no cache, no credentials mode.** `credentials`, `withCredentials`, `cache`,
  `referrer`, `integrity` and `keepalive` are accepted and ignored; a `Set-Cookie` the peer sends
  is visible to the app and never stored or replayed. `mode: 'no-cors'` still yields a readable
  response. The app is the whole client, as ADR-0017 intends.
- **One connection per request.** Every routed request sends `Connection: close`; there is no
  keep-alive pool, so each one pays its own TCP (and TLS) handshake.
- **What a browser adds, and what it does not.** `User-Agent` (`navigator.userAgent`),
  `Accept: */*` and `Accept-Encoding` are sent unless the app set its own. `br` is advertised and
  decoded only when the platform's `DecompressionStream` accepts `'brotli'`, detected at install;
  otherwise a `br` response fails like a network error. `Origin` and `Referer` are not added: a
  native client does not send them, and some servers refuse a foreign `Origin` (the reason
  FreeTube's own main process strips it).
- **A `Request`'s own headers pass through its guard.** `new Request(url, { headers })` drops the
  headers a page may not set before this code ever sees them; `fetch(url, { headers })` keeps
  them.
- **Response shape.** `response.type` reads `'default'`, not `'cors'`/`'basic'`; `redirect:
  'manual'` answers with an `'opaqueredirect'`-typed, status-0 response as the platform does.
  Network failures are `TypeError('Failed to fetch')`, the message retry libraries match exactly,
  with the detail on `cause`.
- **XMLHttpRequest.** A synchronous `open(..., false)` always takes the native path.
  `xhr.upload instanceof XMLHttpRequestUpload` is false, since that global stays native. A
  `'document'` response is parsed with `DOMParser`.
- **WebSocket.** No extension is offered, so there is no `permessage-deflate` and `extensions` is
  always `''`. The upgrade carries the page's origin as `Origin`, as a browser's does and unlike a
  routed `fetch`, and no cookie. The page's CSP does not apply to a routed socket, and a routed
  `ws:` from an `https` page is not blocked as mixed content (`A117`, above). For a cross-origin
  URL the native constructor runs only once the grant has answered, so one that would throw (a
  mixed-content `SecurityError`) surfaces as a failed connection, `error` then `close` 1006,
  instead of a throw from `new WebSocket()`. A routed socket holds one of the origin's
  `orivon.net` sockets for its whole life, so long-lived sockets narrow what routed requests can
  dial at once; past the allowance they queue. A failure is logged to the console in Chromium's
  own wording.
- **Workers and iframes get neither routing nor the shim's globals.** A preload runs only in a
  tab's top-level frame, so a dedicated or shared worker, a service worker, and any subframe keep
  their native `fetch`/`XMLHttpRequest`/`EventSource`/`WebSocket`, CORS- and CSP-bound, and have
  no `orivon`, `process`, `setImmediate` or `Buffer`. An app that moves its network calls into a
  worker loses routing there.

**A second, independent mechanism diverges the same way, for a different class of request.**
This folder only intercepts the page's own JS-level `fetch()`, XHR, EventSource and WebSocket
calls. A passive subresource load pointed at a granted third-party host, whether an `<img>`,
`<link>`, or `<video>` `src`/`href`, never reaches it at all: it is intercepted at the
`protocol.handle` layer instead, inside the app's own partition
([`../../loader/serve/serve.ts`](../../loader/serve/serve.ts)'s `fetchThirdParty`, dialled by
[`../../loader/reach/reach.ts`](../../loader/reach/reach.ts)'s `nodeReachDial`, Node's own
`https` module). A 3xx from the granted host goes back to the page's own loader, which follows it
through the same handler, so every hop is authorised afresh; a chain is capped at 20 hops
([`../../loader/reach/redirects.ts`](../../loader/reach/redirects.ts)). See
`../../loader/README.md`'s Design notes for the full mechanism; this file's own list above covers
only this folder's path.

**`init.signal` (`AbortController`) IS supported**, matching real `fetch()`: an already-aborted
signal rejects before any dial happens, including one still waiting in the dial queue; aborting
mid-flight rejects the pending promise AND closes the underlying socket directly, so the broker
tears the connection down rather than leaking it; aborting after the response has resolved errors
its body stream. The rejection value is `signal.reason` when the app supplied one, else the same
`DOMException('...', 'AbortError')` shape a real `fetch()` constructs.
