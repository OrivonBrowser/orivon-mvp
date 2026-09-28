# WebAssembly compatibility: what runs today, what a WASM shim would add, and how to build it

**Status: exploration, 2026-09-28. Not a decision and not scheduled.** Written as the brief for
the agent that implements it, so it names files, tests and guards. The choices only the owner can
make are collected in §8; nothing below should be built past step 1 of §7 until they are taken.

> **Outcome, 2026-09-28 (`ADR-0040`, `d-0159`, `d-0160`).** The owner asked for native modules,
> `spawn` and `fork`, each at the same broker allowance as any app with no added risk, which only
> WebAssembly meets. §8's decisions 1, 2, 7 and 8 are taken: build now, JSPI, one mechanism for
> both documents, the preview1 host written here. Decisions 3 and 4 were taken by `ADR-0039` and
> `d-0143`: the manifest field is `crossOriginIsolated`, served with COEP `credentialless`. Step 1
> is built in `src/shim/wasi/`, with four departures from §5: the host consults the broker's
> `platformCode` for the errno (it is the one place `ENOTEMPTY` survives); rights are reported per
> descriptor kind and never enforced; the synchronous-write fdflags are refused; and the Worker
> proxy of §5.6 moves to step 1b, where `spawn` and `fork` first use it. Measured against the
> preview1 conformance suite, 63 of 72 programs pass; the nine that fail need links or file times.
> §10 describes an earlier draft of the sibling document, which has since moved to JSPI too.
Every claim is marked **measured** (in this tree, on Electron 44.0.0 / Chromium 152, see §2) or
**read** (from the upstream page cited in §3). Nothing else is asserted.

A sibling exploration written the same day, [`child-process-design.md`](child-process-design.md),
designs what `child_process` means for a ported app over the same WASI idea. The two agree on
most of the shape and differ on one load-bearing mechanism; §10 reconciles them, and the
measurements in §2 are the evidence that sibling asked for.

## The short version

- **WebAssembly with JavaScript bindings already runs** (`ADR-0036`). Three of the four current
  ports depend on it. Nothing to build there.
- **The thing worth building is a WASI host over `orivon.*`**: "the WASM shim", a third
  compatibility family beside `src/shim/` (Node) and `src/shim-electron/` (Electron). It lets a
  WebAssembly program that imports WASI instead of calling JavaScript run in a tab with the app's
  files as its filesystem and, in its second stage, the app's network grants as its sockets.
  **It needs no change to `src/contracts/`**: every WASI call maps onto an `orivon.fs` or
  `orivon.net` method that exists.
- **JSPI makes it cheap.** WASI calls are synchronous and `orivon.*` is asynchronous; that
  mismatch is why the earlier notes on synchronous calls (`A94`'s Route B) reached for workers,
  `SharedArrayBuffer` and cross-origin isolation. A WASI host no longer needs them. WebAssembly JavaScript Promise Integration
  ships in this tree's Chromium (measured), lets a WebAssembly import be an `async` JavaScript
  function, and costs about a microsecond per call (measured). It also works inside a dedicated
  Worker with no isolation headers, where a suspending import that round-trips to the main
  thread by `postMessage` costs 20 to 40 us (measured). So one asynchronous host serves both
  placements: on the page's main thread, or in a Worker as a spawned program should be. Workers
  no longer imply `SharedArrayBuffer`, and isolation is needed only for threaded builds.
- **Cross-origin isolation is Orivon's to switch on**, and it is nearly free here. COOP and
  COEP headers on the served bundle give `crossOriginIsolated`, `SharedArrayBuffer` and
  `Atomics.wait` in workers (measured), which is what every threaded WebAssembly build needs
  (Emscripten `-pthread`, Qt, .NET, ffmpeg.wasm, wasi-threads). COEP's usual price, blocked
  cross-origin subresources, is not charged on `protocol.handle` responses (measured), which is
  how every request in an app's partition is served. It is a manifest field and a serve-path
  change, so it is a `src/contracts/` PR and an ADR.
- **What it does not do.** It does not turn a Qt, JVM or .NET desktop app into a tab: the
  runtimes that compile those to WebAssembly hard-wire their networking to a WebSocket or
  Tailscale proxy with no pluggable transport (read). Go cannot open sockets from WebAssembly on
  any target (read). No WASI target has both threads and sockets (read). And **no app on the
  current candidate list is WASI-shaped**: the near-term consumers are libraries and tools, not
  the desktop apps in `orivon-ports`. `CLAUDE.md` Rule 4 says name the need before building; §4
  is the honest inventory and §8 asks the owner to name it.

## 1. Four layers, and which one "WASM compatibility" means

| Layer | What it is | State | What it unlocks | Contracts change |
|---|---|---|---|---|
| **L0** | WebAssembly called from the app's own JavaScript (wasm-bindgen, Emscripten's JS glue, Go's `js/wasm`, `sql.js`, `wa-sqlite`) | **Done** (`ADR-0036`, CSP `'wasm-unsafe-eval'`, `.wasm` served as `application/wasm`, proven by `test/e2e-served-csp.test.ts`) | Threema, MyMonero, AirGap Vault, Element's crypto, ASGARDEX's largest chunk | none |
| **L1** | **A WASI host over `orivon.*`**: WebAssembly that imports `wasi_snapshot_preview1` (or WASI 0.2 through jco) with no JavaScript around it | Not built (`compatibility-matrix.md` Table 4 row 12) | Rust, C, C++, Zig and TinyGo programs compiled to `wasm32-wasip1`/`wasip2`; a `node:wasi` shape for ported Node code | none for files and clocks; none for sockets either (`orivon.net` covers WASI 0.2's `tcp`, `udp`, `ip-name-lookup`) |
| **L2** | Toolchain adapters over `orivon.net`: Emscripten's socket layer, Go's `wasm_exec.js` globals | Not built; app-side in `orivon-ports` unless a second app needs the same one | Emscripten builds that use POSIX sockets, Qt-for-WebAssembly included | none |
| **L3** | Cross-origin isolation: COOP + COEP on the served bundle, so `SharedArrayBuffer` and threads exist | Not built; measured to work | Every threaded WebAssembly build; the worker-and-`Atomics.wait` synchrony route `A94` called Route B | a manifest field (§5.7) |
| **L4** | A whole runtime in WebAssembly: CheerpJ (Java), CheerpX (x86 Linux), Qt, Avalonia/.NET, Pyodide | Not a target | Nothing on the candidate list: their networking is not pluggable (read, §3.6) | n/a |

**"WASM compatibility" in the sense the owner means, an app running because Orivon can host its
WebAssembly, is L1 plus L3.** L2 is a cheap follow-on that reuses the same `orivon.net` shim
code. L4 is listed so it is not re-derived: the container document already parks CheerpJ as
"worth two hours", and §3.6 answers the question it left open.

**Containment is unchanged.** A WebAssembly program under the WASI host runs with its app's
grants, inside its app's renderer sandbox, exactly as `ADR-0036` states for L0. WASI's own
capability model (a program sees only the directories it was handed, "preopens") maps cleanly
onto `orivon.fs`'s per-origin root, but it is enforced by the broker, never by the host. This is
not `orivon-runtime`, the Wasmtime host `ADR-0002` defers for containment and mobile, and it
does not bring that forward.

## 2. Measured in this tree

Probe run 2026-09-28 on the installed Electron 44.0.0 (`Chrome/152.0.7977.54`), headless, on a
throwaway partition whose `protocol.handle` served the page, a worker script and a second origin,
in an offscreen `BrowserWindow` with `sandbox: true`, `contextIsolation: true` and
`nodeIntegration: false`, the same shape as an app tab. Three variants of the document's
response headers. Full output: [`spike-results/wasm-renderer-probe.json`](spike-results/wasm-renderer-probe.json).
The e2e served-CSP test already has the probe-partition pattern to rebuild it from.

| Measurement | No COOP/COEP | COOP `same-origin` + COEP `require-corp` | COOP `same-origin` + COEP `credentialless` |
|---|---|---|---|
| `typeof WebAssembly.Suspending` / `WebAssembly.promising` | function / function | same | same |
| JSPI round trip: a `Suspending` import that awaits a 5 ms timer, export wrapped with `promising` | returns the right value | same | same |
| JSPI overhead: 20,000 suspending calls on an already-settled promise | 18 ms total, about 1 us per call | 16 ms | 26 ms |
| Plain import, 20,000 calls, for comparison | 1 ms total | 1 ms | 2 ms |
| `crossOriginIsolated` | **false** | **true** | **true** |
| `typeof SharedArrayBuffer` | undefined | function | function |
| Worker + `SharedArrayBuffer` + `Atomics.wait`, worker script served WITH the COEP header | n/a | **`Atomics.wait -> ok`** | ok |
| Same worker, script served WITHOUT the COEP header | n/a | **fails to load** (`onerror`, no message) | fails to load |
| Cross-origin `<img>`, classic `<script>` and `no-cors` `fetch` from a second `protocol.handle` origin, no CORP header | load | **load** | load |
| `new WebAssembly.Memory({ shared: true })` | constructs | constructs | constructs |
| `typeof Atomics.waitAsync`, `WebAssembly.Tag`, `WebAssembly.JSTag` | function, function, object | same | same |
| JSPI inside a dedicated Worker, import resolved locally, 20,000 calls | works: 21 ms, about 1 us per call | 26 ms | 16 ms |
| JSPI inside a dedicated Worker, each import a `postMessage` round trip to the main thread, 5,000 calls | **works without isolation**: 148 ms, 30 us per call | 100 ms, 20 us | 184 ms, 37 us |
| `typeof orivon` inside a dedicated Worker | undefined | undefined | undefined |
| Node 24.11 on this machine, `WebAssembly.Suspending` | undefined without `--experimental-wasm-jspi`, function with it | | |

**What follows from the table.**

1. **JSPI is the synchrony answer for the host.** A WASI import wrapped in `WebAssembly.Suspending`
   can `await orivon.fs.open(...)`; the WebAssembly stack suspends and resumes on the page's own
   event loop. The microsecond per call is noise next to the half-millisecond IPC round trip the
   broker already costs (`audit-2026-08-25.md`). No worker, no `SharedArrayBuffer`, no isolation
   headers, no busy-wait `poll_oneoff`.
2. **Isolation is a serve-path decision.** Setting two headers on every response of an app's
   partition switches it on. **Every** response, not the document alone: a dedicated worker whose
   script lacks COEP does not load at all, and it fails silently. `src/loader/serve/` and
   `orivon-ports`'s development server both serve `.wasm` and worker scripts, so both must add it.
3. **COEP costs nothing on the reach path.** Chromium's CORP blocking is not applied to responses
   a `protocol.handle` handler returns, the same way the served-CSP test found CORS is not. In an
   app's partition every `https:` request is answered by that handler (`ADR-0017`), so isolation
   does not break an app's granted third-party resources. Two things are **not measured** and must
   be before the field ships: a cross-origin `<iframe>` under COEP, and a popup's `window.opener`
   under COOP `same-origin` (the spec severs it; an OAuth-by-popup flow would notice).
4. **A worker cannot reach `orivon.*` today, and does not need `SharedArrayBuffer` to.**
   `contextBridge` exposes into a document's main world only, so a host in a worker calls
   `orivon.*` through a `postMessage` proxy on the main thread. With JSPI in the worker
   (measured) that proxy is an ordinary asynchronous RPC: no `Atomics.wait`, no
   `SharedArrayBuffer`, no isolation headers, and 20 to 40 us per call before the broker's own
   half-millisecond. A WASI program therefore runs off the main thread, as a spawned child
   should, with nothing new switched on. The proxy is a generic piece (§5.6) that also answers
   Table 4 row 3's `worker_threads`.
5. **The unit suite cannot run JSPI on Node without a flag**, and the flag's name and the API's
   shape differ between V8 versions (§3.1). Design the host so its WASI functions are ordinary
   `async` functions testable under vitest with a fake `orivon`, and keep JSPI to one thin
   `instantiate` helper that only the Electron e2e exercises (§6).

## 3. Read upstream, 2026-09-28

Each fact names its page. Training data is stale for all of this; re-check before relying on a
detail the implementation turns on.

### 3.1 JSPI

- Shipped by default in Chrome 137 and Firefox 139 ([v8.dev/blog/jspi](https://v8.dev/blog/jspi),
  [Chrome 137 release notes](https://developer.chrome.com/release-notes/137)). Electron 44 carries
  Chromium 152 (measured).
- API: `new WebAssembly.Suspending(jsFunction)` wraps an import; `WebAssembly.promising(wasmExport)`
  wraps an export and returns a function that returns a Promise. `WebAssembly.SuspendError` exists.
  The earlier `Suspender` object and the `WebAssembly.Function` form are gone
  ([proposal overview](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md),
  [MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Suspending)).
- **Constraints the host must obey.** Suspension is allowed only when every frame between the
  `promising` export and the `Suspending` import is WebAssembly; a JavaScript frame in between
  traps. So a `Suspending` import must be installed directly as the WASI import, never called
  through a JavaScript wrapper the module reached by another route, and `_start`/`_initialize`
  (or any export that may reach a suspending import) must be the `promising`-wrapped one. An
  import that returns a non-Promise does not suspend. Resumption goes through the browser's task
  runner, so the JavaScript that entered WebAssembly must return to the event loop. JavaScript
  itself is never suspended. Stack size limits: not stated on any page read.
- Node: Emscripten's docs say Node needs `--experimental-wasm-stack-switching`; this machine's
  Node 24.11 needs `--experimental-wasm-jspi` (measured). The `engines` floor is 22.12; which flag
  and which API shape that V8 has is **unverified**.

### 3.2 WASI itself

- **Preview 1** (`wasi_snapshot_preview1`) has exactly four socket functions, `sock_accept`,
  `sock_recv`, `sock_send`, `sock_shutdown`, all over an already-open descriptor: no connect, bind
  or listen ([witx](https://raw.githubusercontent.com/WebAssembly/WASI/wasi-0.1/preview1/witx/wasi_snapshot_preview1.witx)).
  A preview1 program therefore cannot dial; it can only be handed a listening socket.
- **WASI 0.2** has `wasi:sockets` with `tcp` (`start-connect`/`finish-connect`, bind, listen,
  accept, shutdown), `udp` and `ip-name-lookup`, all `@since 0.2.0`
  ([wasi-sockets wit](https://github.com/WebAssembly/wasi-sockets/tree/main/wit)). It is a
  component-model interface, not a flat import namespace, which is why a browser host consumes it
  through jco (§3.3).
- **No WASI version has threads and sockets together.** `wasi-threads` is a preview1-only legacy
  proposal; 0.2 has no threads interface and future thread work is a Phase 1 proposal
  ([wasi-threads README](https://github.com/WebAssembly/wasi-threads)). This is the upstream
  blocker Table 4 row 12 names, restated with its source.

### 3.3 jco and the WASI 0.2 shim

- `jco transpile` turns a component into core WebAssembly plus JavaScript glue, with
  `--async-mode jspi`, `--async-wasi-imports`, `--async-wasi-exports`, `--async-imports <...>`,
  `--async-exports <...>` (all marked experimental, jco 1.35.0) and `--map <specifier>=<module>` to
  point any `wasi:*` import at a module of the embedder's own, wildcard form
  `--map 'wasi:sockets/*@0.2.x=./orivon-sockets.js#*'`; `--no-wasi-shim` disables the default
  ([transpiling docs](https://bytecodealliance.github.io/jco/transpiling.html),
  [jco.ts](https://raw.githubusercontent.com/bytecodealliance/jco/main/packages/jco/src/jco.ts)).
- `@bytecodealliance/preview2-shim` 0.26.0: the browser variant implements `wasi:cli`, `clocks`,
  `random`, `io`, `filesystem` (adapter-backed) and `http` over `fetch`; `wasi:sockets` there is
  "interface shape only" for name lookup and "opt-in in-memory" for tcp/udp, with the statement
  that "raw sockets are unavailable unless an embedding supplies an adapter", failing with a
  WASI-domain error rather than a silent stub. The Node variant has real sockets
  ([package](https://github.com/bytecodealliance/jco/tree/main/packages/preview2-shim)). **What the
  adapter contract looks like is not in the pages read**: the implementer must read
  `packages/preview2-shim/src/browser/sockets.js` before choosing between supplying an adapter and
  mapping the whole interface with `--map`.

### 3.4 Preview 1 hosts that exist

- `@bjorn3/browser_wasi_shim` (MIT or Apache-2.0): preview1 only, a subset; an abstract `Fd`
  class whose every method has a default body returning `ENOTSUP`, so a subclass overrides what
  it needs (`fd_read(size)`, `fd_write(data)`, `fd_pread`, `fd_pwrite`, `fd_seek`, `fd_fdstat_get`,
  `fd_filestat_get`, `path_open`, `fd_readdir_single`, `path_create_directory`, `path_unlink_file`,
  `path_remove_directory`, `path_rename`, ...). **Every method is synchronous**, `poll_oneoff`
  busy-loops, the four socket functions throw. A `threads/` subproject exists, less production
  ready, needing isolation
  ([repo](https://github.com/bjorn3/browser_wasi_shim), [fd.ts](https://raw.githubusercontent.com/bjorn3/browser_wasi_shim/main/src/fd.ts)).
  Its `Fd` cannot await, so it fits `orivon.*` only behind a worker and `Atomics.wait`, or as a
  fork. Its function list and errno tables are the right reference for a host written here.
- `@wasmer/sdk` (Modified MIT with an attribution clause above 1M monthly users): alpha; runs
  WASIX in a worker, requires isolation; networking only through a WISP WebSocket proxy the
  embedder hosts ([README](https://github.com/wasmerio/wasmer-sdk/blob/main/js/README.md)). Not a fit:
  it brings its own runtime and its own proxy protocol where Orivon already has the sockets.
- Node's `node:wasi` runs in the main process only; it is not reachable from a renderer and is
  not the answer, but its API is the shape ported Node code expects (§5.4).

### 3.5 Emscripten, Rust, Go

- **Emscripten** emulates POSIX TCP over WebSocket by default and expects a websockify proxy on
  the other end; `-sPROXY_POSIX_SOCKETS` proxies to a native helper and needs `-pthread` plus
  `-sPROXY_TO_PTHREAD`; pthreads need `SharedArrayBuffer`, so COOP and COEP; `-sASYNCIFY` and
  `-sJSPI` (Emscripten 3.1.61 and later) both let synchronous C call asynchronous JavaScript
  ([networking](https://emscripten.org/docs/porting/networking.html),
  [pthreads](https://emscripten.org/docs/porting/pthreads.html),
  [asyncify](https://emscripten.org/docs/porting/asyncify.html)). Whether `--js-library` can replace
  the socket layer wholesale is not stated; §5.8 has the cheaper route.
- **Rust** `wasm32-wasip2` is Tier 2 since 1.82 with full `std`, and `std::net` on it goes through
  the same BSD-socket backend Unix uses, backed by WASI 0.2 sockets
  ([platform page](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip2.html),
  [std net dispatcher](https://github.com/rust-lang/rust/blob/master/library/std/src/sys/net/connection/mod.rs)).
  `wasm32-wasip1` cannot spawn threads or dial; `wasm32-wasip1-threads` has threads and no
  networking. So a Rust program that blocks on `TcpStream` compiles to wasip2 and runs against a
  `wasi:sockets` host; whether a tokio program does is not verified here.
- **Go**: `GOOS=wasip1` and `GOOS=js` share a fake `net` "intended to allow tests of other
  packages to pass"; there is no `wasip2` port (issue open, backlog). TinyGo supports wasip2, and
  whether its separate `net` port dials real sockets there is not stated
  ([Go WASI blog](https://go.dev/blog/wasi), [net_fake.go](https://github.com/golang/go/blob/master/src/net/net_fake.go),
  [issue 65333](https://github.com/golang/go/issues/65333)). **Go daemons (kubo, bee, lnd, geth)
  do not become tabs through any WASM work here**; only a source-level swap of the dialer, which
  is a fork, would do it.

### 3.6 Runtimes in WebAssembly (L4), and why none reaches tier 3

- **CheerpJ** 4.3: full Java SE with Swing/AWT and multithreading; JavaFX is nowhere in its docs;
  networking is same-origin `fetch` or Tailscale through a proxy the embedder hosts, with no hook
  for a custom socket transport; Community licence for FOSS and one-person companies, served only
  from Leaning Technologies' CDN, commercial licence for self-hosting
  ([overview](https://cheerpj.com/docs/overview), [networking](https://cheerpj.com/docs/guides/Networking),
  [licensing](https://cheerpj.com/docs/licensing)). Answers the container document's open
  question: Bisq (JavaFX) has no path here, and even a Swing app would talk Tailscale, not
  `orivon.net`.
- **CheerpX / WebVM**: networking "always happens via Tailscale", no custom backend, engine under
  a community licence that forbids self-hosting without a commercial one
  ([networking](https://cheerpx.io/docs/guides/Networking), [webvm](https://github.com/leaningtech/webvm)).
- **Qt for WebAssembly** 6.11: `QNetworkAccessManager` over fetch, `QWebSocket`, and POSIX TCP
  emulated over WebSockets needing a forwarding server; threads need COOP/COEP; the platform's
  own licence text says GPLv3 or commercial ([wasm.html](https://doc.qt.io/qt-6/wasm.html)). Reachable
  through §5.8's adapter, not natively.
- **.NET browser-wasm**: `System.Net.Sockets` is compiled out for the browser platform; threads
  are an experiment needing COOP/COEP ([csproj](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Net.Sockets/src/System.Net.Sockets.csproj),
  [features.md](https://github.com/dotnet/runtime/blob/main/src/mono/wasm/features.md)). Wasabi
  (Avalonia) does not become a tab.
- **Pyodide**: `socket` and `threading` import but do not function
  ([constraints](https://pyodide.org/en/stable/usage/wasm-constraints.html)). Electrum does not
  become a tab.

## 4. What it unlocks, app by app

Honest inventory against `orivon-ports/docs/port-candidates.md` and `compatibility-matrix.md`
Table 5. "Runs today" means L0 covers it and no work here is needed.

| Candidate | The WebAssembly in it | Needs | Verdict |
|---|---|---|---|
| Threema Desktop, MyMonero, AirGap Vault, Element (crypto), ASGARDEX | Protocol core with JavaScript bindings | L0 | **Runs today** |
| Tuta, Notesnook, Logseq, TriliumNext, Joplin (SQLite or SQLCipher in main) | `wa-sqlite` / `sql.js` / `sqlite3-multiple-ciphers` builds exist | L0, plus a **`wa-sqlite` VFS over `orivon.fs`** written once for the cluster (wa-sqlite is believed to ship Asyncify and JSPI builds that allow an async VFS; **unverified here**) | Cheapest real win adjacent to this work; a bridge-side adapter, not a host |
| Ente Photos (ML N-API, ffmpeg), Joplin (ONNX) | `onnxruntime-web`, `ffmpeg.wasm` | L0 single-threaded; **L3 for their threaded builds** | L3 is what makes these fast enough |
| Firefly (`@iota/sdk` N-API) | Upstream publishes a wasm-bindgen SDK build (**unverified here**) | L0 in the bridge | Recon first |
| Zingo PC (`zingolib` Rust N-API, tokio, TLS to lightwalletd) | None published | Would need upstream to build wasip2 without tokio | Not a target through WASM |
| Session, Signal (native protocol cores) | None published | n/a | Not a target, as listed |
| Qt-for-WebAssembly builds (Monero GUI is Qt, an official wasm build is **not known** to exist) | Emscripten sockets over WebSocket | L2 adapter (§5.8) + L3 | A spike, not a claim |
| Bisq, Sparrow (JavaFX), Wasabi (.NET), Electrum (PyQt) | Runtime-in-WASM only | L4 | **Not reachable** (§3.6) |
| Go daemons: kubo, bee, lnd, geth, and the wallets over them | None possible | n/a | **Not reachable** (§3.5) |
| **A standalone WASI program**: a Rust, C, Zig or TinyGo binary that reads files and, on wasip2, dials TCP | The program itself | **L1** | The host's actual consumer. **No app on the list is this shape today** |

Two consequences the owner should weigh. First, L1's first real user is more likely a library or
a tool an app bundles (a WASI build of a CLI, a Rust core compiled to wasip2 because its author
never wrote wasm-bindgen glue) than a whole desktop app. Second, the `wa-sqlite` VFS row is not
"WASM compatibility" as a platform property, but it is the WebAssembly-shaped change with the
most ports behind it, and it is bridge-side work in `orivon-ports`.

## 5. The WASM shim: design

### 5.1 Where it lives

`src/shim/wasi/`, a job-named folder of the Node shim (`ADR-0035`), beside `fs/`, `net/`,
`http/` and `polyfills/`, with a `README.md` stating what it depends on (`src/contracts/`, the
shim's own `orivon-global.ts`, `virtual-root.ts` and `unimplemented.ts`) and that it never
imports `electron` or `src/broker/`. One host, two Node-shaped consumers: `src/shim/wasi/
node-wasi.ts` is the `node:wasi` row (§5.4), and `src/shim/child-process/` is the `child_process`
row `child-process-design.md` §5 designs, which spawns the same host in a Worker. Neither
consumer marshals a WASI call itself. A fifth family row in `compatibility-matrix.md` Table 2
names the surface (WASI) even though the code lives inside the Node shim's directory.

Inside, by job: `preview1/` (the `wasi_snapshot_preview1` import object, split by function
family so no file nears 500 lines), `fds/` (the descriptor table: stdio, preopens, files,
directories), `errno.ts` (the `OrivonErrorCode` to WASI errno table, the sibling of
`src/shim/node-errors.ts`), `instantiate.ts` (the JSPI wrapping, the only file that touches
`WebAssembly.Suspending`/`promising`), `worker/` (the `orivon.*` RPC proxy and the worker-side
entry, §5.6), later `sockets/` (§5.5). Unit tests beside each, against a fake `orivon` exactly as
`src/shim/tests/support/` does (`fake-file-handle.ts`, `fake-tcp-socket.ts` are reusable as they
are).

### 5.2 Synchrony: JSPI, on the main thread or in a Worker

Every WASI import is an `async` function installed as `new WebAssembly.Suspending(fn)`; the
program's entry export (`_start`, or `_initialize` for a reactor, or any export the embedder
names) is wrapped with `WebAssembly.promising` and returns a Promise. The host is a plain
JavaScript object with async methods; `instantiate.ts` is the only place the two wrappers appear,
and it throws a named error when `WebAssembly.Suspending` is absent (a future engine without
JSPI, or a unit test on an unflagged Node) rather than installing sync imports that would trap
on the first `await`.

Traps to write down in the README and guard in tests:

- A `Suspending` import reached through a JavaScript frame traps (§3.1). The import object hands
  the module the wrapped functions directly; nothing else may call them.
- Re-entrancy: a `promising` export called again while a previous call is suspended is allowed,
  but ordering is not guaranteed. The host serialises where WASI semantics need it (one `fd_write`
  to stdout at a time).
- `poll_oneoff` with a clock subscription awaits a real timer; with fd subscriptions it resolves
  immediately for files (always ready) and, once sockets exist, awaits readability through the
  socket's `readable` reader. Never a busy-loop.
- `proc_exit` ends the program: the host records the code and rejects the entry promise with a
  named `WasiExit` carrying it, so the `node:wasi` shape can return it as `start()`'s value.

The host's `orivon` is an injected interface, not the global: on the main thread it is
`window.orivon`; in a Worker it is the RPC proxy of §5.6, which has the same method shapes and
returns the same promises. The WASI layer cannot tell which it was given, which is what lets one
implementation serve both placements and both Node shapes. Route B of `A94` (a worker blocking
on `Atomics.wait` while the main thread services `orivon.*`) is no longer needed for this; it
stays on record as the swap for a synchronous surface, should one ever be wanted.

### 5.3 Preview 1 host

The `wasi_snapshot_preview1` namespace, in three groups.

**Files, over `orivon.fs`.** The descriptor table starts with fd 0/1/2 (stdin answers EOF;
stdout and stderr go to sinks the embedder passes, defaulting to `console.log`/`console.error`)
and one preopen, fd 3, whose guest path is `/` and whose host root is the app's files directory.
This is the same root `src/shim/`'s virtual root names (`virtual-root.ts`, `/orivon/app`), so a
Node program and a WASI program in one app see the same files. Guest paths are joined onto the
preopen, normalised, and handed to `orivon.fs` as relative paths; a path that would leave the
preopen is refused with `ENOTCAPABLE` before any call, mirroring `fs/paths.ts`'s `EACCES`. The
broker still confines every path (T1); the host's check only chooses the errno. A second preopen
per `DirectoryHandle` from `fs.userSelected({ directory: true })` is the natural extension once
`DirectoryHandle`'s method set is confirmed (Table 4 row 2); `open`/`readFile`/`writeFile`/`stat`/
`readdir`/`mkdir`/`rm`/`rename` on it are enough.

| WASI | Backed by |
|---|---|
| `path_open` | `orivon.fs.open(path, flags)` for files; `orivon.fs.stat` for a directory descriptor (a directory fd holds a path, not a handle). `O_CREAT`/`O_EXCL`/`O_TRUNC` map to Node-style flag strings as `src/shim/fs/handle.ts` already does |
| `fd_read`, `fd_pread`, `fd_write`, `fd_pwrite`, `fd_seek`, `fd_tell` | `FileHandle.read/write({ position })`, with the cursor held in the fd entry; the contract's explicit-position API is a better fit for WASI than for Node |
| `fd_filestat_get`, `path_filestat_get` | `FileHandle.stat()` / `orivon.fs.stat()` |
| `fd_filestat_set_size` | `FileHandle.truncate()` |
| `fd_sync`, `fd_datasync` | `FileHandle.sync()` |
| `fd_readdir` | `orivon.fs.readdir()` plus one `stat` per entry for the type, with the cookie as an index |
| `path_create_directory`, `path_remove_directory`, `path_unlink_file`, `path_rename` | `mkdir`, `rm`, `rm`, `rename` |
| `fd_fdstat_get`, `fd_prestat_get`, `fd_prestat_dir_name`, `fd_close`, `fd_fdstat_set_flags` | the table itself |
| `path_readlink`, `path_symlink`, `path_link`, `fd_advise`, `fd_allocate`, `path_filestat_set_times`, `fd_filestat_set_times` | refuse by name: `ENOTSUP`, and a `console` line once per program naming the call (A135's principle: a gap is named, never silent) |

**Environment.** `args_get`/`args_sizes_get` and `environ_get`/`environ_sizes_get` from what the
embedder passed; `clock_time_get` from `performance.now()` plus `performance.timeOrigin` for
`REALTIME` and `performance.now()` for `MONOTONIC` (nanoseconds as `BigInt`); `clock_res_get`;
`random_get` from `crypto.getRandomValues` in chunks of 65,536 bytes (its per-call cap);
`sched_yield` awaits a macrotask; `proc_raise` refuses.

**Sockets in preview1** are accept-only (§3.2). Step 1 refuses all four by name. A later
`preopenListener` option can hand a program an `orivon.net.listen` server as a preopened
descriptor, so `sock_accept`/`recv`/`send`/`shutdown` work over `TcpServer`/`TcpSocket`; that is
the only preview1 networking there can be, and no app has asked for it.

**Errno mapping** (`errno.ts`, one table, tested like `node-errors.ts`), from the closed
`OrivonErrorCode` set in `src/contracts/errors.ts` (built as `src/shim/wasi/errno.ts`): `denied` is `EACCES`
(uniform, and Rust's std maps `ENOTCAPABLE` to an uncategorised error), `notFound` `ENOENT`,
`exists` `EEXIST`, `invalid` `EINVAL`, `limit` `ENOSPC` for a quota and a bounded retry then
`EIO` for the in-flight cap, `closed` `EBADF`, `timeout` `ETIMEDOUT`, `internal` `EIO`, and
`revoked` `EIO` with the program terminated. This document adds the codes a socket host will
need: `unavailable` `EAGAIN`, `unreachable` `ECONNREFUSED` or `EHOSTUNREACH`, `reset`
`ECONNRESET`. `EISDIR` and `ENOTDIR` are the host's own, decided from its `stat` before the call,
since the contract has no code for them. As built, the host prefers the broker's `platformCode`
when one is present (the Outcome note at the top), and the WASI numbering, not Linux's, is what
the guest reads.

### 5.4 The `node:wasi` shape

A `wasi` row in `src/shim/module-map.ts` (bare and `node:`-prefixed, as every row) pointing at
`src/shim/wasi/node-wasi.ts`, so ported Node code that does
`new WASI({ version: 'preview1', args, env, preopens })`, `wasi.getImportObject()`,
`wasi.start(instance)` runs. Two deliberate departures, stated in the doc comment like the
`net`-is-async one: `start()` and `initialize()` return a Promise (JSPI), where Node's are
synchronous and return the exit code; and `preopens` values are paths under the app's virtual
root, never host paths (there are none). `version: 'unstable'` and `stdin`/`stdout`/`stderr` as
numeric fds refuse by name; `returnOnExit` is honoured, and its default is the only sensible
one here, since the entry promise resolves with the exit code either way. The module carries the
`refusingProxy` wrap every other module target here carries.

This row also closes Table 4 row 12's "a `node:wasi` shape only once an app needs one". The
row is deleted when the host lands, not struck through.

### 5.5 WASI 0.2 through jco: sockets and the component path

The stage that gives a WebAssembly program real networking. Two halves:

- **Build time, in `orivon-ports`.** A recipe's `build.command` runs
  `jco transpile app.wasm --async-mode jspi --async-wasi-imports --async-wasi-exports --map 'wasi:sockets/*@0.2.x=<orivon module>#*' --map 'wasi:filesystem/*@0.2.x=<orivon module>#*' -o out/`,
  producing core WebAssembly plus glue that imports Orivon's modules. jco is a build dependency
  of that repository, never of this one (Rule 8 is unaffected either way: jco is JavaScript).
- **Run time, in `src/shim/wasi/sockets/` and `src/shim/wasi/filesystem/`.** Modules with the
  shapes `@bytecodealliance/preview2-shim`'s browser variant exports, so the glue's imports
  resolve: `wasi:sockets/tcp` (`start-connect`/`finish-connect` over `orivon.net.connect`,
  `read`/`write` over the handle's streams as `wasi:io/streams`, `shutdown` over `writable.close()`
  for the write side, bind/listen/accept over `orivon.net.listen`), `wasi:sockets/udp` over
  `orivon.net.udpBind`, `wasi:sockets/ip-name-lookup` over `orivon.net.lookup`,
  `wasi:filesystem/types` over `orivon.fs`. `wasi:clocks`, `random`, `io/poll` and `cli` come from
  preview2-shim's browser build, a runtime dependency of this repository (pure JavaScript,
  Apache-2.0; `docs/planning/shim-dependency-review.md`'s bar applies).

The implementer reads preview2-shim's browser `sockets.js` first: if its adapter hook is a small
interface, supply an adapter and keep the package's own state machine; if not, `--map` the whole
interface to Orivon's module. Either way the surface a Rust `std::net` program exercises is
`start-connect`, `finish-connect`, `subscribe`, the two streams and `shutdown`.

**Gate:** this half is built for a named program, not ahead of one. The measurable claim in
`scope.md`'s genericity test applies: it must need nothing that only one program uses.

### 5.6 Workers: the same host, behind an asynchronous proxy

A program that should not share the main thread (every `child_process` spawn, per
`child-process-design.md` §5.1, and any CPU-bound tool) runs the same host inside a dedicated
Worker. Two pieces make that work, and neither needs `SharedArrayBuffer`:

- **The `orivon.*` proxy.** The main thread owns the real `window.orivon`; the Worker gets an
  object with the same method shapes whose every call is a `postMessage` request over a
  `MessageChannel` and whose reply resolves the promise. Handles are proxied by id; the bytes of
  a `read`/`write` cross as transferred `Uint8Array`s (transferring is fine worker-to-main; the
  rule against transferables is about Electron's renderer-to-main IPC, not `Worker.postMessage`).
  Every reply-carrying request carries a timeout, the shim's own rule 3. Measured cost: 20 to
  40 us per call before the broker's own IPC.
- **The worker entry.** A self-contained script (a `blob:` URL, which the served CSP's
  `worker-src 'self' blob:` already admits) that receives the module bytes, args, env and the
  proxy's port, builds the host over the proxy, and reports stdout, stderr and the exit code back
  by message. `child-process-design.md` §5.4 specifies the stdio and exit semantics; only its
  ring-buffer-and-`Atomics.wait` transport is replaced by messages with the same backpressure
  rule (the worker awaits an acknowledgement before its next `fd_write` completes).

The proxy is generic: it is also what Table 4 row 3's `worker_threads` shape needs, and what
lets an app that hosts WASI itself through `node:wasi` do so in a Worker.

### 5.7 Cross-origin isolation (L3)

A manifest field, provisional name `crossOriginIsolated: true`, mirroring the page global it
switches on. When set, `src/loader/serve/serve.ts` adds `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` to **every** response of the app's own origin
(document, scripts, workers, `.wasm`), and `orivon-ports`'s development server does the same for
a port whose manifest sets it. It is a page property, not a capability: nothing to consent to,
nothing in the permissions popover; the manifest carries it because the app's author is the one
who knows whether their build is threaded.

Isolation is **not** a prerequisite for a WASI program any more, spawned or hosted (§2 item 4);
it is for threaded WebAssembly only, and `child-process-design.md` §5.5's "without the field,
`spawn` fails" no longer applies. `require-corp` over `credentialless`: both measured identical
here; `require-corp` is the one every toolchain's documentation names, and the sibling document
prefers `credentialless` so that credential-free third-party subresources without a CORP header
keep loading, a cost §2 item 3 measured as not charged on `protocol.handle` responses anyway.
The owner picks (§8). Why either is safe under Orivon's serving model is §2 item 3;
the two unmeasured cases there must be measured in the e2e before the field ships, and the
popup case decides whether the field's doc comment must warn that an OAuth-by-popup flow breaks.

`src/contracts/manifest.ts` is change-controlled: own PR, merged first, and `check:manifest-parity`
means the loader must accept the field in the same change. It is load-bearing (an app that sets
it gets `SharedArrayBuffer`, high-resolution timers and threads; one that does not never will),
so it is an ADR under Rule 1.

### 5.8 Emscripten sockets (L2)

Emscripten's socket layer opens `new WebSocket('ws://<host>:<port>', 'binary')` for each POSIX
`connect()` and expects a websockify proxy to turn the WebSocket frames into raw TCP bytes.
Under Orivon there is no proxy and the served CSP admits no `ws:` at all (measured in the
served-CSP test). The cheap route, **unverified**: a WebSocket-shaped class over
`orivon.net.connect`, where each binary message is the raw bytes, installed by the port's bridge
as `Module.websocket`'s constructor or as the page's `WebSocket` for `ws:` URLs only. The app's
C code then dials real TCP with no app change. A one-day spike in `orivon-ports` against any
Emscripten program that calls `connect()` settles it; Qt-for-WebAssembly builds are its widest
consumer. Threads in the same build need L3.

### 5.9 Security, in one paragraph

Nothing here widens what an app can do. Every WASI call becomes an `orivon.*` call the app's
JavaScript could already make, authorised by the same grants and confined by the same broker
policy; the host adds errno translation and a descriptor table, not authority. WASI's preopen
model means a program cannot even name a path outside the app's root, which is stricter than the
Node shim's virtual root, not looser. The threat rows are unchanged; one new sentence belongs in
`security-model.md` beside T5 saying so. L3 is the one change with a security dimension: it
hands a page `SharedArrayBuffer` and the timer precision that comes with it, which is why it is
opt-in per manifest and an ADR, and why the popup and iframe cases are measured before it ships.

## 6. Verification

- **Unit (vitest, no flag):** the preview1 host's async functions against the shim's fake
  `orivon` (`fake-file-handle.ts`, a small fake `fs` namespace), one test per WASI function
  family, plus the errno table and the path confinement. Test the memory marshalling (iovecs,
  `dirent` layout, the `prestat` struct) against the witx field offsets, with real modules
  hand-assembled as bytes the way `ADD_WASM` is in the served-CSP test, or from `.wat` text
  assembled by the `wabt` npm package (WebAssembly, passes Rule 8). No Rust or C source enters
  this repository (`ADR-0002`); a `.wat` file is data.
- **e2e (Electron):** one WASI fixture under `test/apps/`, an Orivon-native app whose `.wasm`
  writes a file, reads it back, lists a directory, reads the clock and random bytes, and exits
  with a code the page shows. It proves JSPI under the real served CSP and the real
  `orivon.fs`. `npm run test:e2e` already builds with the dev-grant hook the served-CSP test uses.
- **L3:** an e2e phase on the probe partition measuring what §2 leaves open: a cross-origin
  `<iframe>` under COEP, a popup's `opener` under COOP, a `wss:` WebSocket and an
  `RTCPeerConnection` under both. Then the served-CSP test gains the isolated case.
- **Guards:** `check:contracts` and `check:manifest-parity` when L3's field lands;
  `check:page-globals` for anything installed on the page (`WASI` is a module target, not a global,
  so nothing new); `check:size` will bite on `preview1/`: split by function family before it does.
- **Docs to update in the same PR as the host:** `compatibility-matrix.md` (Table 2 row, Table 4
  row 12 deleted), `app-compatibility.md` §Where WASM fits (rewrite, not append), `ADR-0036`'s
  "does not run yet" consequence (amend in place), `src/README.md`, `CHANGELOG.md`, a decision-log
  row per decision below, and `docs/scope.md`'s IN table if the owner names it a build item.

## 7. Build order, smallest first

| Step | What | Depends on | Size (estimate) |
|---|---|---|---|
| 0 | `module-map.ts` rows that refuse `child_process` and `vm` by name (`child-process-design.md` §12 Step 0) | nothing | half a day |
| 1 | `src/shim/wasi/` preview1 host: files, clocks, random, args/env, exit; `instantiate.ts` with JSPI; the `node:wasi` module-map row; the fixture app and its e2e; docs | nothing; no contracts change | 3 to 5 agent-days |
| 1b | The Worker proxy and worker entry (§5.6), then `child_process` over the host (`child-process-design.md` §5.4, §5.6, §5.8), flipping step 0's row to built; its ADR | step 1 | 3 to 5 days plus the ADR |
| 2 | L3: the manifest field, the serve-path headers in both servers, the four unmeasured cases measured, the ADR | a `src/contracts/` PR merged first; a threaded build that needs it | 1 to 2 days plus the ADR |
| 3 | WASI 0.2 sockets and filesystem through jco (§5.5) | step 1, a named program, preview2-shim's adapter contract read | 1 to 2 weeks |
| 4 | Emscripten socket spike in `orivon-ports` (§5.8) | nothing; a bridge-side experiment | 1 day |
| adjacent | `wa-sqlite` VFS over `orivon.fs` in `orivon-ports` (§4) | nothing | 2 to 3 days |

Steps 0 and 1 stand alone: step 1 is the platform capability, it changes no contract, and a
fixture app proves it without waiting for a port. Step 1b gives the sibling document its
`child_process` on the same host. Everything from step 2 on is gated on a named need; step 2 in
particular is no longer on the path to running a WASI program at all.

## 8. Decisions the owner must take

1. **Is the WASI host a build item now, or does it wait for a named program?** Rule 4. The case
   for now: it is cheap, contract-free, and turns an "app qualifies but does not run" sentence in
   `ADR-0036` into a running thing. The case for waiting: nothing in `orivon-ports` needs it, and
   bandwidth is the scarce resource.
2. **JSPI on the main thread as the synchrony mechanism** (this document recommends it, on the
   measurements), with Route B kept as a later swap. This narrows nothing in `ADR-0016`: the
   synchronous `readFileSync` stays as it is.
3. **Cross-origin isolation as a manifest field**, name, default, and whether an ADR records it
   (this document says yes, ADR).
4. **`require-corp` or `credentialless`** (recommended: `require-corp`, the one toolchains name).
5. **preview2-shim as a runtime dependency** when step 3 comes, under the dependency review's bar,
   versus mapping every `wasi:*` interface to modules written here.
6. **Whether the `wa-sqlite` VFS and the Emscripten socket adapter are `orivon-ports` work** (this
   document says yes: bridge-side until a second app needs the same code, per that repository's
   rule 7 and the "a gap a port finds is fixed here for every app" line in `scope.md`).
7. **One synchrony mechanism for both documents.** `child-process-design.md` builds on a Worker
   blocking on `Atomics.wait`, which makes isolation a prerequisite; this document builds on
   JSPI, measured working on the main thread and in a Worker with no isolation. §10 lists what
   changes in the sibling if JSPI is chosen. The two must be brought to one answer before the
   implementing agent starts, or it will build the SharedArrayBuffer protocol and the JSPI
   wrapper both.
8. **Which WASI preview1 implementation**, once the async requirement is applied (§10 item 2): a
   fork of `@bjorn3/browser_wasi_shim` made asynchronous, a layer written here, or a library the
   sibling's Step 1 review finds that is already asynchronous.

## 9. Not decided here, and not measured here

- Which V8 flag and API shape the `engines` floor's Node has for JSPI; whether CI's unit suite
  should run any JSPI at all (§2 item 5 says no).
- COEP's effect on a cross-origin `<iframe>`, COOP's on a popup's `opener`, and both on `wss:`
  and WebRTC, in an app partition.
- preview2-shim's browser sockets adapter contract, and whether Rust's `std::net` on wasip2
  actually completes a `connect` against a JSPI-backed `wasi:sockets` (the dispatcher routes it
  there; the end-to-end is unverified).
- Whether any Qt or Emscripten application on the candidate list has a WebAssembly build that a
  port could pin; none was found in the pages read.

## 10. Relation to `child-process-design.md`

Both documents were written on 2026-09-28 without sight of each other. Where they agree, the
sibling's text is the more detailed and should be the one the implementer follows; where they
differ, the measurements in §2 decide most of it, and the rest is the owner's.

**Agreements.** The manifest field's name and shape (`crossOriginIsolated?: true`, presence-only,
provisional, its own contracts PR, an ADR); the WASI-to-`orivon.fs` call table (its §5.3 and §5.3
here are the same mapping); the virtual root as the one preopen; no network in preview1; a
program's bytes come from the pinned bundle; native `subprocess` stays excluded with its §8 as the
reopening conditions; refusals by name through `refusingProxy`; and Step 0, the refusal rows, done
first regardless.

**Differences, and what settles each.**

1. **Synchrony.** The sibling's A1 runs the program in a Worker that blocks on `Atomics.wait`
   over a `SharedArrayBuffer` while the main thread services `orivon.fs`, so isolation is a
   prerequisite and `spawn` fails `ENOENT` without the manifest field (its §5.1, §5.5). Measured
   here: JSPI works in a dedicated Worker with no isolation, and an asynchronous `postMessage`
   round trip per syscall costs 20 to 40 us. **Recommendation: A1 on JSPI.** What changes in the
   sibling if the owner agrees: the diagram in §5.1 (requests and replies are messages, the
   Worker awaits rather than blocks); §5.5 stops being a prerequisite and moves to "threaded
   builds only"; §5.9's "no main-thread execution" and "no `node:wasi` shape" are lifted, since
   both come free from the same host; §12 Step 1's first spike is answered by §2 here; §12 Step 3's
   `proxy.ts` becomes the asynchronous proxy of §5.6 here; `spawnSync`/`execSync` stay refused
   for the same reason as before (a synchronous wait on the main thread has no mechanism).
2. **The WASI preview1 implementation.** The sibling's Step 1 evaluates `@bjorn3/browser_wasi_shim`
   and `@runno/wasi` as libraries, which fits its synchronous `Fd` layer. Under JSPI every `Fd`
   method must be `async`, and `browser_wasi_shim` is synchronous throughout (read, §3.4), so a
   library qualifies only if it is asynchronous already, or is forked. The review's deciding
   criterion becomes "asynchronous descriptor layer", and the fork option needs its written
   reason under Rule 6. Owner gate either way (its decision 2, decision 8 here).
3. **`denied`'s errno.** The sibling's `EACCES` is adopted here (§5.3); `ENOTCAPABLE` is dropped.
4. **COEP flavour.** The sibling prefers `credentialless`, this document `require-corp`; measured
   identical for everything tried, and the difference the sibling guards against is not charged
   on `protocol.handle` responses. Owner's pick, decision 4.
5. **Where the code lives.** The sibling puts the syscall layer inside `src/shim/child-process/`;
   this document put a separate family at `src/shim-wasi/`. Reconciled above as `src/shim/wasi/`,
   one host, with `child-process/` and `node-wasi.ts` as its two Node-shaped consumers, so
   neither module marshals a WASI call itself (code-guidelines Rule 3).
6. **Scope of the first build.** The sibling builds `child_process` first and defers hosting;
   this document builds the host and `node:wasi` first and adds `child_process` as step 1b. Same
   code either way; the owner orders the two module rows.

**Carried over from the sibling unchanged:** its `child_process` member table (§5.6), stdio and
exit semantics (§5.4), lifecycle and limits (§5.8), the guards table (§6), the A2 sketch (§7),
the reopening checklist for native `subprocess` (§8), the person-picked program shape (§9), and
the target matrix rows (§11). This document does not restate them.
