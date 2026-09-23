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
`contextBridge.executeInMainWorld`; see its own header before touching it). This is the
narrowest and most security-critical surface in the repository.

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
`socket-bridge.ts`, `socket-port.ts`, `datagram-port.ts` and `main-world-socket.ts` belong to
`broker` (build step 2); `shell.ts` and
`newtab.ts` belong to
`shell` (build step 1, done).

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | **every ordinary tab** | `orivon-surface.ts`'s `exposeOrivon()`: `orivon.version`, `orivon.app.manifest`/`grants`, `orivon.fs.readFile`/`writeFile`/`readFileSync` (the last one ADR-0016's synchronous exception; see `orivon-surface.ts`'s own `fsReadFileSync`), `orivon.id.publicKey`/`sign`, `orivon.net.connect` (a real `TcpSocket`) and `orivon.net.udpBind` (a real `UdpSocket`), both built in the main world by `main-world-socket.ts` |
| `shell.ts` | **only** the chrome view | Tab commands |
| `settings.ts` | **only** the permissions panel's own view (`src/main/permissions/permissions-panel.ts`) | `orivonSettings`: list each app's grants and revoke one, after checking `location.href` against its expected URL; `src/main/ipc/settings-ipc.ts` re-verifies the sender on every call |
| `newtab.ts` | **only** a genuinely fresh tab (`src/main/shell/tabs.ts`'s `createTab()`, no `url` argument) | Read-only bookmark access, navigate-this-tab-only, but only after checking `location.href` against its own expected URL first, since (unlike the chrome view) a dashboard tab is ordinary and navigable; falls back to the SAME `exposeOrivon()` `app.ts` uses otherwise, not a second copy |
| `fetch-route.ts` | `app.ts` and `newtab.ts`'s fallback branch, via `exposeFetchRoute()` | ADR-0017: routes `window.fetch` through `orivon.net` for a registered app's granted hosts, when the tab's `--orivon-app-tab` flag says so (`src/main/shell/tab-view.ts`'s `appTabArgsFor`); a plain website keeps native `fetch`, untouched |
| `fetch-gate.ts` | `exposeFetchRoute()`, one gate per tab, handed to `installFetchRoute` as an argument | Nothing to the page. Decides when each routed request may dial, so a request past the app's socket allowance waits for a socket instead of failing (Design notes) |
| `expose-shim-globals.ts` | `app.ts` and `newtab.ts`'s fallback branch, via `exposeShimGlobals()` | A151: installs `src/shim/globals.ts`'s `process`/`setImmediate`/`clearImmediate` into the main world, gated on the SAME `--orivon-app-tab` flag `fetch-route.ts` reads; an ordinary tab never receives shimmed Node globals just because it loaded before this preload ran |

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

**Why `fetch-route.ts`'s `isAppTab` gate is a synchronous main-process decision, not an async
check inside the main world (ADR-0017, queue item 3.4):**

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
  dashboard-URL check, read synchronously off `process.argv` in `fetch-route.ts`'s
  `exposeFetchRoute()` before `installFetchRoute` ever runs. No promise, no race.
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
dies while its module graph is still evaluating, naming no cause. So
[`fetch-route.ts`](fetch-route.ts)'s routed `fetch` is installed `writable`, `configurable` and
`enumerable`, and [`../shim/globals.ts`](../shim/globals.ts)'s `process`, `setImmediate` and
`clearImmediate` are plain assignments. `npm run check:page-globals` fails the build on a locked
one, and reads an omitted `writable` as the lock it actually is.

**Why [`main-world-socket.ts`](main-world-socket.ts) still locks `window.orivon` when the rest is
not locked.** `orivon` is Orivon's own surface rather than a borrowed one: nothing tries to shadow
it, the platform sets no contract for its shape, and freezing it costs an app nothing, so the
reason in that file's own comment stands. The guard's allowlist carries the same four names for
the same reason.

**`fetch-route.ts`'s known divergences from a real browser's `fetch()`**. ADR-0017's own
Consequences section requires these be written down plainly, since "a silent divergence in a web
platform API is a trap":

- **A routed response is capped at `MAX_BODY_BYTES` (currently 16 MiB, checked against
  `Content-Length` before reading, and incrementally as bytes actually arrive for a chunked or
  connection-close-terminated body).** Real `fetch()` has no such cap. This is a conservative
  PLACEHOLDER, not settled; the open question (should this instead be a
  manifest-declared, user-visible limit, the same pattern A80 gave the per-app socket allowance)
  is tracked in the F2 lane's log, not settled here. The response headers themselves are capped
  too, at `MAX_HEAD_BYTES` (32 KiB, mirroring `src/shim/node-http-parser.ts`), which real `fetch()`
  also has no equivalent to, though a real header block this large is not a realistic case.
- **`Content-Encoding: gzip`/`deflate` is decompressed transparently**, via the platform's own
  `DecompressionStream`, matching real `fetch()`. `Content-Encoding: br` (brotli) is NOT
  decompressed: `DecompressionStream` has no brotli format string in Chromium, so a `br` response
  fails loudly (naming brotli in the error) rather than handing the app compressed bytes as though
  they were content. As in a real browser, the `Content-Encoding` header itself stays on the
  `Response` unstripped even after the body is decompressed. Not a new divergence: a real
  browser does the same.
- **Redirects are not followed.** A 3xx response comes back to the app as an ordinary `Response`
  with that status code; the app must notice and follow it itself. A v0 scope cut.
- **Mixed-content blocking does not apply on this path (`A117`).** A page served over `https` can
  reach an `http://` granted host through a routed `fetch()`, which its own renderer would have
  refused. Stated narrowly, because the wider claim would be wrong: Orivon does not permit mixed
  content generally; this one routed path does not apply an enforcement the renderer otherwise
  performs, and only for a host named in the manifest and granted by a person at install. That
  grant is what makes it defensible rather than merely undetected: the request goes to somewhere
  the user reviewed, not anywhere the page chose. It is still a divergence, and ADR-0017's own
  Consequences section is explicit that a silent one is a trap, so it is written here, with the
  others, rather than left to be discovered.
- **Only string/`Uint8Array`/`ArrayBuffer`/`URLSearchParams` request bodies are supported** --
  `FormData`, `Blob` and a streamed-upload body are not built here. A v0 scope cut.

**[`fetch-gate.ts`](fetch-gate.ts) makes a routed `fetch()` wait for a socket, where
`orivon.net` refuses.** Each routed request holds one socket for its whole exchange, and an app may
hold only its socket allowance at once (the manifest's `net.concurrentSockets`, 64 when it declares
none). Past it the broker refuses with `'limit'` and never queues (`LIMITS`' own doc, T11b). That is
the right contract for `orivon.net`, whose callers are written against it, and the wrong one for
`fetch()`: no browser's `fetch()` fails because too many are in flight, it waits for a connection.
Without the gate, an app that fires a burst (FreeTube refreshing a hundred subscriptions in one
`Promise.all`) sees every request past the allowance fail. So the waiting happens here, in the
tab's own renderer, never on the broker's thread:

- Every request dials until the broker first refuses one. From then on the gate holds the tab to
  the number of requests still live at that refusal, hands each freed socket to the
  longest-waiting refused request first, then admits queued ones in order.
- It learns the number rather than reading it, because the allowance is shared with the app's own
  `orivon.net` sockets and its other tabs, so no figure the preload could read up front says how
  much of it is free. For the same reason it cannot see a socket freed there, so while anything
  waits it probes once a second: one more request than is live, the oldest refused one first. A
  refusal settles the number back; a success keeps it. It forgets the number once the tab goes
  idle. The broker's call-rate limit and in-flight cap refuse with `'limit'` too, and the gate
  treats them alike, since each also means "dial less".
- There is no per-host cap. A browser opens six HTTP/1.1 connections to a host but reaches most
  busy hosts over HTTP/2, many requests on one connection; the routed fetch speaks HTTP/1.1, one
  request per socket, so a six-per-host cap would triple FreeTube's hundred-subscription refresh
  (measured: 19.5 s against 5.7 s). The allowance the person granted is the bound.
- The first burst still pays for its refused dials, because the broker checks the allowance after
  the TLS handshake. Learning the number is what stops that recurring on every request after.
- **One case still fails, as a divergence:** when no routed request in the tab is live to free a
  socket (the allowance is held entirely by the app's own sockets or its other tabs), the refusal
  surfaces as the fetch's `TypeError`, since waiting would never end.

**A second, independent mechanism diverges the same way, for a different class of request.**
`fetch-route.ts` above only intercepts the page's own JS-level `fetch()` calls. A passive
subresource load pointed at a granted third-party host, whether an `<img>`, `<link>`, or `<video>`
`src`/`href`, never reaches `fetch-route.ts` at all: it is intercepted at the
`protocol.handle` layer instead, inside the app's own partition
([`src/loader/serve.ts`](../loader/serve.ts)'s `fetchThirdParty`, dialled by
[`src/loader/serve-reach.ts`](../loader/serve-reach.ts)'s `nodeReachDial`, Node's own `https`
module). Like the mechanism above, it never follows a redirect: a 3xx response from the granted
host comes back exactly as received, so a redirecting URL used as an `<img src>` or `<video src>`
on a granted host renders as a broken load rather than following through, which is surprising since the
page wrote no network code of its own to suspect. See `src/loader/README.md`'s Design notes for
the full mechanism; this file's own list above covers only the `fetch()` path.

**`init.signal` (`AbortController`) IS supported**, matching real `fetch()`: an already-aborted
signal rejects before any dial happens; aborting mid-flight rejects the pending promise (via a
`raceAbort` race against every awaited step) AND closes the underlying socket directly, so the
broker actually tears the connection down rather than leaking it; `raceAbort` alone cannot force
a foreign promise to release what it holds, hence the direct `close()`. The rejection value is
`signal.reason` when the app supplied one, else the same `DOMException('...', 'AbortError')` shape
a real `fetch()` constructs.
