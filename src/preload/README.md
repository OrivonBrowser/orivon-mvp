# `src/preload/`: the privilege boundary

**What lives here.** Four preload scripts at four different privilege levels (`app.ts`,
`shell.ts`, `newtab.ts` for the new-tab dashboard, and `settings.ts` for the permissions panel),
plus `orivon-surface.ts`, which is not a preload entry itself but the `orivon.*` exposure both `app.ts` and `newtab.ts`'s fallback
branch share (build step 2's IPC task; §The rule that governs this directory still applies to
it), its two Rule 2 splits `control-call.ts` (the shared `CONTROL_CHANNEL` call/timeout
machinery) and `net-surface.ts` (the `net.*` bridge closures; see Design notes for why these
split out), and four more files it depends on: `socket-bridge.ts` (the only file touching
`ipcRenderer.on(PORT_CHANNEL)`, and deliberately kind-agnostic: it maps a handle id to a port and
does not care what kind of socket it belongs to), `socket-port.ts` and `datagram-port.ts` (the
isolated-world per-socket state machines for TCP and UDP, both Electron-free), and
`main-world-socket.ts` (the one function serialised into the main world via
`contextBridge.executeInMainWorld`; see its own header before touching it). The routed network
path (ADR-0017) is its own set of main-world installers, `routed-*.ts`, `fetch-route.ts`,
`xhr-route*.ts` and `eventsource-route.ts`, wired by `expose-fetch-route.ts` and described under
Design notes. This is the narrowest and most security-critical surface in the repository.

**What it depends on.** `electron` (via `require`, since these are CommonJS),
[`src/contracts/`](../contracts/) for types, and (from `expose-shim-globals.ts` only, A151)
[`src/shim/globals.ts`](../shim/globals.ts), the one shim file with no `electron` import and no
free identifier of its own, so it is safe to run inside a preload and to hand to
`contextBridge.executeInMainWorld` unchanged.

**What it must never import.** [`src/broker/`](../broker/), because a preload runs in the renderer
process, and importing broker LOGIC there would either fail or, worse, appear to work. **One
documented exception to "never import `src/main/`":** [`../main/channels.ts`](../main/channels.ts)
is a zero-dependency leaf of plain string constants, safe in either process, and the one
neutral place a channel name shared across this trust boundary can live; `shell.ts` and
`newtab.ts` already relied on this before `orivon-surface.ts` did too. Nothing else under
`src/main/` is fair game.

**Owner stream.** `app.ts`, `orivon-surface.ts`, `control-call.ts`, `net-surface.ts`,
`socket-bridge.ts`, `socket-port.ts`, `datagram-port.ts`, `main-world-socket.ts` and the routed
network path's files belong to `broker` (build step 2); `shell.ts` and
`newtab.ts` belong to
`shell` (build step 1, done).

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | **every ordinary tab** | `orivon-surface.ts`'s `exposeOrivon()`: `orivon.version`, `orivon.app.manifest`/`grants`, `orivon.fs.readFile`/`writeFile`/`readFileSync` (the last one ADR-0016's synchronous exception; see `orivon-surface.ts`'s own `fsReadFileSync`), `orivon.id.publicKey`/`sign`, `orivon.net.connect` (a real `TcpSocket`) and `orivon.net.udpBind` (a real `UdpSocket`), both built in the main world by `main-world-socket.ts` |
| `shell.ts` | **only** the chrome view | Tab commands |
| `settings.ts` | **only** the permissions panel's own view (`src/main/permissions/permissions-panel.ts`) | `orivonSettings`: list each app's grants and revoke one, after checking `location.href` against its expected URL; `src/main/ipc/settings-ipc.ts` re-verifies the sender on every call |
| `newtab.ts` | **only** a genuinely fresh tab (`src/main/shell/tabs.ts`'s `createTab()`, no `url` argument) | Read-only bookmark access, navigate-this-tab-only, but only after checking `location.href` against its own expected URL first, since (unlike the chrome view) a dashboard tab is ordinary and navigable; falls back to the SAME `exposeOrivon()` `app.ts` uses otherwise, not a second copy |
| `fetch-route.ts`, `xhr-route.ts`, `eventsource-route.ts` (the routed network path) | `app.ts` and `newtab.ts`'s fallback branch, via `expose-fetch-route.ts`'s `exposeFetchRoute()` | ADR-0017: `window.fetch`, `XMLHttpRequest` and `EventSource` reach a registered app's GRANTED cross-origin hosts through `orivon.net`, when the tab's `--orivon-app-tab` flag says so (`src/main/shell/tab-view.ts`'s `appTabArgsFor`). Every other request -- same-origin, non-http(s), or to a host the app was not granted -- takes the page's native API, CORS and all. A plain website keeps all three native, untouched |
| `expose-shim-globals.ts` | `app.ts` and `newtab.ts`'s fallback branch, via `exposeShimGlobals()` | A151: installs `src/shim/globals.ts`'s `process`/`setImmediate`/`clearImmediate` into the main world, gated on the SAME `--orivon-app-tab` flag `expose-fetch-route.ts` reads; an ordinary tab never receives shimmed Node globals just because it loaded before this preload ran |

**Preload builds are isolated per entry (`electron.vite.config.ts`'s `isolatedEntries: true`).**
When two preloads share a local import (`shell.ts` and `newtab.ts` both import `./channels.js`),
Rollup's default multi-entry build extracts it into a shared chunk that a sandboxed preload's
restricted `require()` cannot load, so `contextBridge.exposeInMainWorld` never runs and the whole
chrome UI goes silently inert with no visible error. `isolatedEntries` keeps
each preload a single, fully self-contained bundle.

## The rule that governs this directory

**The raw `MessagePortMain` never crosses into the main world.** `socket-bridge.ts`,
`socket-port.ts` and `datagram-port.ts` hold it in the isolated world and expose only plain closures over it:
`write(chunk)`, `onData(cb)`, and so on (`socket-port.ts`'s own `SocketPort`). Transferring the
port to the page is the obvious move when optimising for throughput, and it hands a raw socket
to anything the page can reach ([`security-model.md`](../../docs/architecture/security-model.md)
T17). `main-world-socket.ts`'s `installOrivon` builds the page's real `ReadableStream`/
`WritableStream` in the main world over exactly these closures, and the closures cross via
`contextBridge.executeInMainWorld`'s proxying, the port itself never does.

This is a **security rule, not a throughput optimisation left for later**. `contextIsolation:
true` is what makes it free. Spike gate 0 measured 1134.8 MB/s *through the closures* for the
`exposeInMainWorld` mechanism. **That figure does not cover `net.connect`'s path**, which goes
through `executeInMainWorld` and adds a `contextBridge` clone on top of the structured clone
already in the path (three copies of every byte, two of them on the renderer main thread). That
path is unmeasured, so the figure is evidence for `app.*`/`fs.*`'s throughput only.

The smoke check asserts `require` and `process` are `undefined` in every renderer. If that ever
regresses, stop.

## Design notes

**Why the page surface is three files (`orivon-surface.ts`, `control-call.ts`,
`net-surface.ts`).** Every new capability method adds page-surface entries, and in one file they
would all converge on it: the same merge-time failure mode `../broker/transport/ipc.ts`'s own
split (`../broker/transport/README.md`'s Design notes) exists to avoid. The net.* bridge closures
(`netConnectBridge`, `netConnectSecureBridge`, `netUdpBindBridge` and everything only they use --
`wrapPort`, the local `SocketDescriptor`/`UdpSocketDescriptor` shapes, `buildBridgeResult`,
`buildUdpBridgeResult`) live in `net-surface.ts`, so a new `net.*` method grows that file, not the
one every other capability's code also lives in. `call()`, `raceTimeout()` and the
per-capability `TIMEOUT_MS` budgets live in `control-call.ts`, because both
`orivon-surface.ts` (the `app.*`/`fs.*`/`id.*` closures, `exposeFallback`, `exposeOrivon`) and
`net-surface.ts` need them, and `net-surface.ts` importing them from `orivon-surface.ts` directly
would cycle back through `orivon-surface.ts`'s own import of the net bridge closures for
`exposeOrivon`'s wiring object; `control-call.ts` is a leaf neither file needs to route through
the other to reach.

**Why `orivon-surface.ts` is shaped the way it is** (none of this is a trap a single line needs;
it explains the file's overall shape):

- **Shared by both exposure sites.** `preload/app.ts` (every ordinary tab) and
  `preload/newtab.ts`'s fallback branch (a dashboard tab the user has navigated away from) both
  call this file's `exposeOrivon()`, so there is exactly one `orivon.*` object definition, not
  two copies drifting apart (code-guidelines.md Rule 3).
- **This is build step 2's control surface**: `../broker/transport/ipc.ts`'s `handleControlRequest`, on
  the other side of `CONTROL_CHANNEL`. `app.manifest`, `app.grants`, `app.requestGrant`,
  `fs.readFile`, `fs.writeFile`, `fs.mkdir`/`readdir`/`stat`/`rm`/`rename`, `fs.open` and its
  handle-scoped siblings (`fs.read`/`write`/`fstat`/`truncate`/`sync`/`close`, A184),
  `fs.userSelected`'s FILE shape (A194, reusing those same handle-scoped siblings) and its FOLDER
  shape (A195: `fs.dirOpen`/`dirReaddir`/`dirStat`/`dirMkdir`/`dirRm`/`dirRename`/`dirReadFile`/
  `dirWriteFile`), `id.publicKey`, `id.sign`, `net.connect`, `net.connectSecure`, `net.udpBind`, `net.listen`,
  `net.lookup`, `net.close` (plus `net.setNoDelay`/`setKeepAlive`) are wired there;
  `fs.readFileSync` is wired the same way but over its OWN channel (`SYNC_CONTROL_CHANNEL`,
  `../broker/transport/sync-fs.ts`'s `handleSyncFsReadRequest`), never one more `CONTROL_CHANNEL`
  method, because it replies via `event.returnValue`, not a resolved `Promise`. **Update this bullet in the
  same PR that lands a method here.** `fs.open`'s own `readable()`/`writable()` (A184) and
  `id.requestIdentity` are absent, because the broker does not implement them either
  (`id.requestIdentity` needs the connect-prompt UI, a later build step), and a method that always
  threw `'invalid'` would be worse than a method that is not there.
- **`net.connect`'s real shape (readable/writable are actual WHATWG streams) cannot be built in
  the isolated world.** `contextBridge` copies plain values into the main world; it does not
  proxy a stream built on this side intact (checked live via context7 against Electron's own
  docs: "Function values are proxied, while other data types are copied and frozen", so a copied
  `ReadableStream` loses its prototype). `./main-world-socket.ts`'s `installOrivon` is therefore
  handed to `contextBridge.executeInMainWorld`: it runs IN the main world, so its own
  `ReadableStream`/`WritableStream` are the page's real constructors, wired to plain proxied
  closures (`netConnectBridge`) built in `orivon-surface.ts`.
- **`CONTROL_CHANNEL` is imported from `../main/channels.js`, not `../broker/`,** deliberately,
  matching `preload/shell.ts`'s own precedent (`COMMAND_CHANNEL`/`STATE_CHANNEL`, same file):
  this directory's "never import `src/broker/`" rule is about broker LOGIC, which cannot run in
  a renderer process at all: `channels.ts` is a zero-dependency leaf of plain string constants,
  safe in either process, and the one neutral place a channel name shared across this trust
  boundary can live.

**Why the routed network path's `isAppTab` gate is a synchronous main-process decision, not an
async check inside the main world (ADR-0017, queue item 3.4):**

- **`window.orivon` (hence `orivon.net`) is exposed to EVERY ordinary tab**, registered app or
  not, because an app is discovered via a `<link>` hint rather than installed up front. Routing `fetch()`
  unconditionally the instant `orivon.net` exists would deny every cross-origin `fetch()` call on
  the open web the moment this shipped, since an ordinary website has no grant for anything.
- **Gating on `orivon.app.manifest()` resolving, awaited from INSIDE the main-world
  `installFetchRoute` function, would race.** That check answers the identical question
  (`Broker`'s `GrantLedger.manifestFor`) but over a real IPC round trip, so it is asynchronous,
  and a page's own first script (a FreeTube-class app fires requests immediately at startup, per
  A100's own reasoning against just-in-time prompting) could run and capture the native `fetch`
  reference before that promise ever settled. A first call racing ahead of the gate is the single
  most likely call in an app's life to hit this window, and it would succeed or fail
  nondeterministically depending on load timing, which is worse than either outcome being consistent.
- **So the decision lives where a synchronous answer is actually available: `src/main/
  tabs.ts`, in the SAME process as the broker.** `Broker.app.isRegisteredSync` (`../broker/
  index.ts`) reads the identical in-memory ledger state `orivon.app.manifest()` answers, with no
  IPC round trip; `Broker.fs.confineSync` (ADR-0016) is the precedent for a synchronous sibling
  of an already-async method for exactly this reason. `src/main/shell/tab-view.ts`'s `appTabArgsFor`
  calls it once, at `WebContentsView` construction (`tabs.ts`'s `createTab()`/`repartitionView()`),
  and hands the answer over as a `webPreferences.additionalArguments` flag
  (`'--orivon-app-tab'`), the exact mechanism `newtab.ts` already uses for its own
  dashboard-URL check, read synchronously off `process.argv` in `expose-fetch-route.ts`'s
  `exposeFetchRoute()` before any installer runs. No promise, no race.
- **A known, remaining limitation:** the decision is fixed for the life of one `WebContentsView`.
  An origin registered AFTER a tab already showing it was created keeps that tab's ORIGINAL
  answer until the next navigation swaps in a fresh view, the same lifetime `additionalArguments`
  already has for every other flag on this list, not a new gap this feature introduces.
  `expose-shim-globals.ts` (A151) reads the identical flag for the identical reason, and inherits
  this exact limitation: a page discovered and installed during its OWN first visit does not get
  shimmed Node globals until the next navigation to it, once `appTabArgsFor` can answer `true` at
  `WebContentsView` construction.

**Every global this directory installs on an app's window carries the platform's own property
descriptor -- `orivon` excepted.** ADR-0021 states the rule and the evidence for it; the short
version is that a locked global cannot be shadowed in strict mode, so a bundle that ponyfills one
dies while its module graph is still evaluating, naming no cause. So the routed `fetch` is
installed `writable`, `configurable` and `enumerable` (an operation's descriptor), the routed
`XMLHttpRequest` and `EventSource` `writable` and `configurable` but not `enumerable` (an interface
object's), and [`../shim/globals.ts`](../shim/globals.ts)'s `process`, `setImmediate` and
`clearImmediate` are plain assignments. `npm run check:page-globals` fails the build on a locked
one, and reads an omitted `writable` as the lock it actually is.

**Why [`main-world-socket.ts`](main-world-socket.ts) still locks `window.orivon` when the rest is
not locked.** `orivon` is Orivon's own surface rather than a borrowed one: nothing tries to shadow
it, the platform sets no contract for its shape, and freezing it costs an app nothing, so the
reason in that file's own comment stands. The guard's allowlist carries the same four names for
the same reason.

**The routed network path is eight installers, and they share one slot.** Each of
[`routed-wire.ts`](routed-wire.ts) (the HTTP/1.1 codec), [`routed-dial.ts`](routed-dial.ts)
(dialling through the socket allowance), [`routed-core.ts`](routed-core.ts) (one whole exchange),
[`routed-events.ts`](routed-events.ts) (handler attributes and native-event forwarding),
[`fetch-route.ts`](fetch-route.ts), [`xhr-route-response.ts`](xhr-route-response.ts),
[`xhr-route.ts`](xhr-route.ts) and [`eventsource-route.ts`](eventsource-route.ts) is serialised
into the main world on its own, so none of them can import another; the one thing they share at
run time is an object at `Symbol.for('orivon.routed-network')` on the page's window. Each reads
what the ones before it published and adds its own, in the order `expose-fetch-route.ts` lists
them, and `releaseRoutedSlot` deletes the slot once the last has run, before any page script. A
page that recreates the key gets nothing: every installer captured its references at install.
This is how the path stays under code-guidelines.md Rule 2 without a second copy of the codec:
one function body cannot hold it all, and a shared helper module is exactly what a serialised
function cannot call. `fetch-route-types.ts` holds the shapes, type-only, for the same reason
`main-world-bridges.ts` does. Every routed test re-evaluates each installer from its own source
text (`tests/routed.test-helpers.ts`'s `reserialised`), so a reference to anything outside a
function's body fails there as it would in a page.

**Routed or native is decided per request, and a denial is not an error.** A request goes routed
only when it is cross-origin http(s). The broker's grant check is the dial itself: `'denied'` on
the first hop hands the request, untouched, to the page's native `fetch`/`XMLHttpRequest`/
`EventSource`, which is what an ordinary website would get. A Request's body is read from a clone
and the body is extracted only after the dial succeeds, so the native path still receives it
intact. Mid-redirect there is no native fallback: a hop to an ungranted host fails the request.

**The routed network path's numbers.** Each is a literal inside its installer, mirrored by an
exported constant the tests hold it to.

- `ROUTED_QUEUE_MAX_WAIT_MS` (120 s) and `ROUTED_LIMIT_RETRY_MS` (500 ms), `routed-dial.ts`. A
  dial refused `'limit'` (the origin's socket allowance, or the control channel's rate limiter,
  which answers the same code) waits in a FIFO queue. Only the queue's head is woken, when a
  routed socket from this page has been released by the broker or after the back-off, since the
  allowance is per origin and other tabs or the app's own `orivon.net` sockets hold it too. A
  browser queues past its connection limit and never fails a request for it; the bounded wait is
  the one divergence, and a request that exhausts it fails like a network error.
- `ROUTED_IDLE_TIMEOUT_MS` (300 s), `routed-core.ts`. With no caller signal (fetch) or `timeout`
  (XHR), a request that receives nothing for this long, while it is waiting on the peer, fails like
  a network error and frees its socket. It is a hang detector: long-polls and quiet event streams
  sit silent for a minute or two, so it is deliberately far longer than any of them. An
  EventSource treats it as a dropped stream and reconnects.
- `ROUTED_MAX_REDIRECTS` (20), the Fetch spec's own limit.
- `ROUTED_MAX_HEAD_BYTES` (256 KiB), `routed-wire.ts`: Chromium's own response-head cap.
- A response body is read ahead up to 512 KiB of the app, as a browser buffers ahead of its reader,
  so a small response completes and frees its socket even when the app never reads it (an app
  checking only `response.ok` is common). A larger body the app drops unread is closed when it is
  garbage-collected. There is no body cap.

**The routed network path's remaining divergences from a browser.** ADR-0017's own Consequences
section requires these be written down plainly, since "a silent divergence in a web platform API
is a trap":

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
  headers a page may not set before this code ever sees them; `fetch(url, { headers })` keeps them.
- **Response shape.** `response.type` reads `'default'`, not `'cors'`/`'basic'`; `redirect:
  'manual'` answers with an `'opaqueredirect'`-typed, status-0 response as the platform does.
  Network failures are `TypeError('Failed to fetch')`, the message retry libraries match exactly,
  with the detail on `cause`.
- **XMLHttpRequest.** A synchronous `open(..., false)` always takes the native path.
  `xhr.upload instanceof XMLHttpRequestUpload` is false, since that global stays native. A
  `'document'` response is parsed with `DOMParser`.
- **Workers and iframes get neither routing nor the shim's globals.** A preload runs only in a
  tab's top-level frame, so a dedicated or shared worker, a service worker, and any subframe keep
  their native `fetch`/`XMLHttpRequest`/`EventSource`, CORS-bound, and have no `orivon`, `process`
  or `setImmediate`. An app that moves its network calls into a worker loses routing there.

**A second, independent mechanism diverges the same way, for a different class of request.**
The routed network path above only intercepts the page's own JS-level `fetch()`, XHR and
EventSource calls. A passive subresource load pointed at a granted third-party host, whether an
`<img>`, `<link>`, or `<video>` `src`/`href`, never reaches it at all: it is intercepted at the
`protocol.handle` layer instead, inside the app's own partition
([`src/loader/serve.ts`](../loader/serve.ts)'s `fetchThirdParty`, dialled by
[`src/loader/serve-reach.ts`](../loader/serve-reach.ts)'s `nodeReachDial`, Node's own `https`
module). Unlike the routed path, it never follows a redirect: a 3xx response from the granted
host comes back exactly as received, so a redirecting URL used as an `<img src>` or `<video src>`
on a granted host renders as a broken load rather than following through, which is surprising since the
page wrote no network code of its own to suspect. See `src/loader/README.md`'s Design notes for
the full mechanism; this file's own list above covers only the routed path.

**`init.signal` (`AbortController`) IS supported**, matching real `fetch()`: an already-aborted
signal rejects before any dial happens, including one still waiting in the dial queue; aborting
mid-flight rejects the pending promise AND closes the underlying socket directly, so the broker
tears the connection down rather than leaking it; aborting after the response has resolved errors
its body stream. The rejection value is `signal.reason` when the app supplied one, else the same
`DOMException('...', 'AbortError')` shape a real `fetch()` constructs.
