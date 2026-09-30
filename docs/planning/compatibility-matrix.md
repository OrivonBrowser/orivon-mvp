# Compatibility matrix

**What is wired up right now, and the cheapest next lever, across apps, extensions and the
browser around them.** [`../architecture/app-compatibility.md`](../architecture/app-compatibility.md)
owns *why the tiers exist*; this file owns *what works today*. If they disagree, that one is the
design and this one is stale.

**Every live capability is complete Spec'd → Broker → Page, except `id.requestIdentity` and
`protocols`**, the two unbuilt entries. `hid` and `subprocess` are excluded from v0.

**An app qualifies by running in the Node environment, not by being JavaScript**
([`ADR-0036`](../decisions/ADR-0036-an-app-qualifies-by-running-in-the-node-environment.md)):
WebAssembly runs in an app exactly as it runs in Node. Every gap below is a limit of this build,
taken case by case as a real app reaches it, never a rule about which apps may exist.

Two axes, and they fail in completely different ways:

- **Table 1 is authority**: what is an app *allowed* to do. Missing it, the app runs and every
  privileged call returns `'denied'`.
- **Tables 2 and 3 are ability**: can the app's code *execute* at all. Missing it, the app is
  allowed to do everything and crashes on line 1.

**Table 3 is not a third axis.** It is an inventory over ground Table 2 already covers, at a
finer grain: half its rows are Table 2's Node-stdlib family itemised, and closing one closes
the other: the same item, listed twice, not two blockers. Its `Class` column says which rows
are that duplication and which are genuinely elsewhere. **Completing Tables 1 and 2 closes
every `dup` row automatically**; the `needs T1` and `outside` rows survive it, and the `outside`
ones were never shim work.

---

## Table 1: the capability surface (authority)

**Spec'd** = in [`src/contracts/`](../../src/contracts/) | **Broker** = implemented in
[`index.ts`](../../src/broker/index.ts) | **Page** = reachable from `window.orivon` |
**Node shim** = a Node-shaped equivalent exists in [`src/shim/`](../../src/shim/)

✅ done | ❌ not there | ⚠️ partial or unsettled | 🚫 excluded by design | ➖ not applicable

| Capability | Spec'd | Broker | Page | Node shim | Note |
|---|:--:|:--:|:--:|:--:|---|
| `net.connect` (TCP out) | ✅ | ✅ | ✅ | ✅ | Both stream halves wired, e2e-verified. A `localhost:<port>` pattern reaches `127.0.0.1` and `::1` at that port, never resolving the name (A215). Node shape in [`net/socket.ts`](../../src/shim/net/socket.ts) |
| `net.connectSecure` (TLS out) | ✅ | ✅ | ✅ | ✅ | TLS terminated on the trusted side per [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md), under the app's own Node TLS options (trust anchors, `rejectUnauthorized`, client certificate, SNI, ALPN), with the handshake reported on the socket. Node's `tls` module and `https`/`http` clients sit on top. No STARTTLS (A226) |
| `net.udpBind` + send/recv | ✅ | ✅ | ✅ | ✅ | `scope` picks the interface as `net.listen`'s does ([ADR-0034](../decisions/ADR-0034-listening-is-local-unless-the-app-declares-the-network.md)). Node shape in [`net/dgram-socket.ts`](../../src/shim/net/dgram-socket.ts), which maps a `bind` address onto a scope and refuses one other address by name |
| `net.listen` (TCP in) | ✅ | ✅ | ✅ | ✅ | Real accepted-socket handles, unsigned-app port rules and a revocation cascade. Each accepted socket's port is delivered over the server's own port (`AcceptedMessage`), in the transfer list, and the preload sets it back on the message; e2e in [`e2e-child-process.test.ts`](../../test/e2e-child-process.test.ts), where a page connects to a spawned component that listens. Node shape in [`net/server.ts`](../../src/shim/net/server.ts): a real `net.Server`/`createServer`. `scope` picks the interface ([ADR-0034](../decisions/ADR-0034-listening-is-local-unless-the-app-declares-the-network.md)): `'local'`, the default, binds `127.0.0.1` under a `.local` grant or a `.network` one, and `'network'` binds every interface under `.network` alone. The shim asks for `'local'` on a loopback host and for `'network'` otherwise, falling back to `'local'` when that is denied, and refuses any other single address by name |
| `fs.readFile` / `writeFile` | ✅ | ✅ | ✅ | ✅ | Confined to the app dir. The quota counts disk usage (A216). Node shape in [`fs/fs.ts`](../../src/shim/fs/fs.ts), where every Node-shaped path (cwd, homedir, tmpdir, `userData`) is rooted at the virtual `/orivon/app` |
| `fs.readFileSync` | ✅ | ✅ | ✅ | ✅ | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md), over `ipcRenderer.sendSync`. Grant check and path confinement are shared with the async path; **the per-origin in-flight budget is not** (A112). The shim maps its failures to Node errnos, and `existsSync` answers over it. Every other `fs` `*Sync` member works too, in a Worker of a cross-origin isolated app, over the Worker's own synchronous channel instead ([ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s amendment; Table 3's `child_process` row) |
| `fs.mkdir` / `readdir` / `stat` / `rm` / `rename` | ✅ | ✅ | ✅ | ✅ | |
| `fs.open` (`FileHandle`) | ✅ | ✅ | ✅ | ✅ | Broker (`capabilities/fs.ts`'s `open`), dispatch and preload. Node shape (`fs/handle.ts`) is a Node-style cursor over the contract's explicit-position reads and writes, and `fs.createReadStream`/`createWriteStream` run over that same cursor. **One named limitation:** `readable()`/`writable()` are built in the broker but have no control-channel case and are not on `window.orivon` (A184), so a handle's own `FileHandle#createReadStream`/`createWriteStream` refuse loudly rather than fake a stream |
| `fs.userSelected` (picker) | ✅ | ✅ | ✅ | ➖ | **The only route outside the app dir**, in both shapes. A file resolves through `fs.open`'s handle-scoped methods; a folder resolves a `DirectoryHandle` whose nine members travel over eight `fs.dir*` control-channel methods, with `fs.dirOpen` routed through the same `registerFileHandle` mechanism `fs.open` uses. The picker choice IS the consent; a picked path persists and is revocable from the settings list beside that app's other permissions. **Provisional:** `DirectoryHandle`'s own method set is not yet confirmed (A167 item 2, A195) |
| `id.publicKey` / `sign` | ✅ | ✅ | ✅ | ➖ | Wired end to end. P-256 ECDSA only; secp256k1/Schnorr is the separate A44 question. The production keychain is real (ADR-0033) and a consent-made grant (empty `patterns`) now authorises whatever curves the registered manifest declares, proven against a real broker (`src/main/consent/tests/request-grant.test.ts`); the real-Electron e2e test still grants through the dev-only hook, not a real `requestGrant` dialog |
| `secrets` (`available` / `encrypt` / `decrypt`) | ✅ | ✅ | ✅ | ➖ | ADR-0033. An origin-bound AES-256-GCM secret derived from the identity seed under its own salt, never the seed itself. `available()` is `false` with no grant or a session-only seed; `encrypt` then rejects `'unavailable'` rather than silently producing ciphertext that cannot survive a restart |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | Unbuilt, and nothing blocks it. `src/nostr/nip07.ts`'s real wiring calls this and cannot reach a page until it exists (A111) |
| `app.manifest` / `grants` | ✅ | ✅ | ✅ | ➖ | Backs Electron's `app.*`; see Table 2 |
| `app.requestGrant` | ✅ | ✅ | ✅ | ➖ | A control-channel case in [`ipc.ts`](../../src/broker/transport/ipc.ts) turns a page's call into `ctx.requestGrant(origin, request)`; accepting the dialog persists a real grant a later capability call uses, e2e-verified with refusal included. An origin must be registered as an app first, which is where install-time consent asks once for the whole declared set before the app's own code runs. A first-ever visit can still see an early call denied before that dialog resolves (A146, accepted as a known limitation) |
| `web.context` (`orivon.web.openContext`) | ✅ | ✅ | ✅ | ➖ | An isolated, never-displayed document at an origin the manifest names exactly, and `evaluate` to run one script in it. No `orivon.*`, no preload, no cookies, and **no network of its own**: every request it makes is authorised against the *opening app's* own `https.connect` grant. Bounded by `LIMITS.webContexts`. The one capability a page cannot substitute for, because a web page cannot host a document at another site's origin -- an iframe there is that site's document, not the app's. Broker in [`capabilities/web.ts`](../../src/broker/capabilities/web.ts), page surface in [`surface/web.ts`](../../src/preload/surface/web.ts), e2e in [`e2e-web-context.test.ts`](../../test/e2e-web-context.test.ts) and [`e2e-web-context-network.test.ts`](../../test/e2e-web-context-network.test.ts). **Provisional:** [ADR-0019](../decisions/ADR-0019-an-app-may-run-code-at-an-origin-the-user-named.md) is still `proposed`; owner acceptance settles it |
| `web.embed` (`<webview>`, `orivon.web.setEmbedScript`) | ✅ | ✅ | ✅ | ➖ | [ADR-0039](../decisions/ADR-0039-an-app-may-show-a-site-inside-its-own-page.md): a site shown inside the app's own page, in Electron's `<webview>` element, under one warning-level grant whose patterns are exact origins, `*` or a local pattern. The shown page runs in a `persist:` partition of the app's own, sandboxed, with the shell's preload and no `orivon.*`; it may load documents only from the granted origins, and `*` stops at private addresses (T12); the app's own script runs first in every page it shows, whatever that page's CSP. [ADR-0047](../decisions/ADR-0047-an-app-shows-pages-it-serves-itself-and-hears-a-shown-page-s-popups-and-downloads.md): a local pattern (`http://*.localhost:<port>`) shows pages the app serves itself, each at an origin of its own, admitted only while the app holds a listener on that port, and `*` may be listed with other entries. A popup or a download from a shown page opens and keeps nothing, and the element fires `orivon-popup` or `orivon-download`; a link to another program's scheme is never offered outside the browser. The script reaches the top frame only, and no scheme of the app's own is answered in a shown page. Broker in [`capabilities/embed.ts`](../../src/broker/capabilities/embed.ts), shell in [`src/main/embed/`](../../src/main/embed/), guest preload [`preload/embed.ts`](../../src/preload/embed.ts), e2e in [`e2e-embed.test.ts`](../../test/e2e-embed.test.ts) |
| `dns.lookup` (`orivon.net.lookup`) | ✅ | ✅ | ✅ | ✅ | The capability is `OrivonNet.lookup`; there is no separate `orivon.dns` namespace, and `dns.lookup` is the Node API it backs. Bounded by the host portions of the origin's held `tcp.connect` and `udp.send` patterns; `https.connect` does not authorise a lookup. Node shape in [`net/dns.ts`](../../src/shim/net/dns.ts) resolves `dns.lookup`/`dns.promises.lookup`, answering an IP literal and `localhost` itself with no capability call; every other `dns.*` member is a named refusal |
| `protocols` (scheme routing) | ✅ | ❌ | ❌ | ➖ | Declared in the manifest and validated by the loader ([`manifest/capabilities.ts`](../../src/loader/manifest/capabilities.ts)), but **not a `CapabilityKind`** ([`manifest-patterns.ts`](../../src/broker/policy/manifest-patterns.ts)) and unimplemented on both sides: nothing registers a scheme with the shell, and how a routed URI would reach the app is unspecified |
| `hid` / USB | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 for every tier |
| `subprocess` | 🚫 | 🚫 | 🚫 | 🚫 | Never a native process: one holds its user's whole authority, so no grant can bound it ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). A child process is a WebAssembly program in the app's own tab instead (Table 3, `child_process`) |

**Only prefixes of ✅ are legal.** A call travels Spec'd → Broker → Page, so the valid shapes
are ❌❌❌, ✅❌❌, ✅✅❌, ✅✅✅. Anything else is a defect or a mislabel: Broker ✅ with
Spec'd ❌ means implementation ran ahead of the contract, which is what `ADR-0002` exists to
prevent. Every row above is a legal prefix. `hid`/`subprocess` are 🚫 across all four columns,
which is its own declared category (excluded by design), not a legality violation.

**What is proven end to end, and what is proven one layer short.** A real Electron launch proves
that `requestGrant` fires the dialog and that an accepted answer persists a grant a subsequent
`net.connect` actually uses, including the out-of-manifest refusal. `net.listen` and `fs.open`
have no real-Electron e2e test; their proof is unit tests over the real `installOrivon` wiring
rather than a hand-built stub.

No automated test drives the full chain "a real page, at a real public HTTPS origin, triggers the
real install-time consent dialog and it works." `install-origin.ts`'s own T12/A46 guard means no
hermetic test fixture's origin can pass `Loader.load()`'s public-unicast check, so every e2e test
in this area substitutes one layer below that wall (a developer-only grant hook, or a direct call
to the consent function itself), the same substitution `test/e2e-capability-boundary.test.ts`
uses for the raw capability API. Each link is proven for real (a real broker's consent decision,
a real dialog's wiring, a real IPC round trip); the chain through a real public origin is not
something CI can reach, and that is a limit of CI rather than a gap in the mechanism.

## Table 2: the four adapter families (shim families structure)

An app never calls `orivon.*` directly unless it was written for Orivon. Something has to
present a familiar interface on top. There are four such layers:

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | `net`, `dgram`, `fs`, `http`, `https`, `tls`, `Buffer`, `stream`... | `net.*`, `fs.*` | ✅ built: `net` (client and server), `dgram` and `fs` (including `FileHandle` and `fs` streams) over the capabilities, `tls` and Node's `http`/`https` clients over `net.connectSecure`, `http.createServer` over `net.Server`, `dns.lookup` over `orivon.net.lookup`, the eight core polyfill packages, hand-written `url`, `querystring`, `string_decoder`, `timers` and `assert`, `wasi` over a WASI preview1 host, and `child_process` over Web Workers, each also under its `node:` name and subpaths. **Named refusals, by design:** `net.Server#listen` and `dgram` `bind` on one address that is neither loopback nor every interface, `FileHandle#createReadStream`/`createWriteStream` (A184), `tls` STARTTLS and a prebuilt `secureContext` (A226), `https.createServer` (no TLS listener), WASI links, file times and sockets, and every other `dns.*`/`net.*` member this shim has not decided on |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog` | `app.*`, `fs.userSelected` | ⚠️ partial, in [`src/shim-electron/`](../../src/shim-electron/) |
| **Web ecosystem** | `window.nostr` (NIP-07); later `window.ethereum` | `id.*` | ✅ built ([`nip07.ts`](../../src/nostr/nip07.ts)), not wired into a page: it needs `id.requestIdentity` (A111) |
| **The app's own preload surface** | whatever that app's preload exposed -- `window.ftElectron` for FreeTube | any capability its calls happen to map to | ➖ **Not Orivon's to ship.** One file per ported app, living with the app |

**The `electron` family** lives in its own package rather than folded into `src/shim/`:
`app`, `dialog`, `safeStorage`, `ipcRenderer`/`ipcMain` and `BrowserWindow`/`Menu`/`Tray`,
reconstructed or explicitly refused on top of `orivon.*`. A refusal and a gap are not the same cell:

| Electron API | What backs it | This package |
|---|---|---|
| `app.getPath('userData')` | the app's own confined `fs` root | `app.ts`, built |
| `app.getVersion()` | `orivon.app.manifest()` | `app.ts`, built |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` | `dialog.ts`: **refuses, as `'not-built'`, on a shape mismatch.** `showOpenDialog` returns raw host paths (`filePaths: string[]`), while `userSelected` resolves an opaque handle and deliberately never exposes a host path to app code (A187) |
| `safeStorage.isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync` | `orivon.secrets` (ADR-0033) | `safe-storage.ts`, built |
| `safeStorage.isEncryptionAvailable` / `encryptString` / `decryptString` (the sync trio) | nothing; `orivon.secrets` is async-only | `safe-storage.ts`: `isEncryptionAvailable` answers `false` unconditionally (a ported app's own non-keyring fallback then takes over); `encryptString`/`decryptString` refuse, as `'not-built'` |
| `ipcRenderer.invoke` / `ipcMain.handle`, `.on`/`.send` | a local in-sandbox message bus, no broker round-trip | `ipc.ts`, built |
| `BrowserWindow`, `Menu`, `Tray` | nothing; desktop-shell surface | `desktop-shell.ts`, refuses by design, tested |

## Table 3: the runtime environment (ability)

**What the app is capable of doing in the browser environment.** The capability-backed part is
the small part. [`src/shim/`](../../src/shim/) holds `globals.ts`, `module-map.ts`, a
hand-written `polyfills/util.ts` and the Node shapes, and [its README](../../src/shim/README.md) names
the eight core polyfills (`Buffer`, `stream`, `events`, `path`, `os`, `crypto`, `zlib`, `util`)
as owned by the `shim` stream, matching Table 2's `net, dgram, fs, Buffer, stream...`.

**`Class` answers one question: if I complete Tables 1 and 2, is this row still open?**

- **`dup`**: **no.** This row *is* Table 2 at a finer grain. Implement it there and it closes
  here. Pure shim work: write JavaScript in `src/shim/`, no decision needed first.
- **`needs T1`**: **yes**, until Table 1 grows an entry it does not have. The adapter sits
  inside Table 2's family, but there is nothing underneath to build it on, so the work lands in
  [`src/contracts/`](../../src/contracts/): own PR, merges first.
- **`outside`**: **yes.** Neither table covers it. No Node module, `electron` call or web API
  expresses the problem, so no amount of shim work touches it.

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `process`, `global`, `nextTick`, `setImmediate` | `dup` | everything | ✅ built | `shim/globals.ts`, installed on a registered app tab's window before its own scripts run. `process` answers what libraries read without claiming to be Node (A223); `setImmediate` is a `MessageChannel` task, free of timer clamping; an uncaught callback error reaches the page's own `reportError` |
| `util` | `dup` | nearly every dependency tree (`inherits`, `promisify`, `inspect`, `types`) | ✅ built | The `util` package, with [`polyfills/util.ts`](../../src/shim/polyfills/util.ts) replacing what the package gets wrong or predates: `promisify`'s registry symbol, `inherits`, `isDeepStrictEqual`, `TextEncoder`/`TextDecoder` |
| `Buffer`, `stream`, `events`, `path`, `os`, `crypto`, `zlib` | `dup` | everything | ✅ built | All eight core polyfill packages are installed, deliberately wider than the five with a confirmed caller, so a ported app does not stall on a missing module ([`shim-dependency-review.md`](shim-dependency-review.md)). `Buffer` is also a page global in registered app tabs (not workers or subframes), the same class `require('buffer')` returns. `zlib` has no brotli (A209) |
| `url`, `querystring`, `string_decoder`, `timers`, `assert` | `dup` | ported apps' dependency trees | ✅ built | Hand-written in `src/shim/`. Every mapped module also resolves under its `node:` name, and `fs/promises`, `stream/promises`, `path/posix`, `util/types`, `dns/promises` and `timers/promises` are rows of [`module-map.ts`](../../src/shim/module-map.ts) of their own |
| `net` / `dgram` / `fs` Node shapes | `dup` | every ported app | ✅ built, client and server | `net.connect`, `dgram`, `fs` (async and sync), `net.createServer`/`net.Server` and `fs.open`/`FileHandle` present real Node shapes over the capabilities, with Node's `errno`, `syscall` and codes on their errors, and `fs.createReadStream`/`createWriteStream` over the shim's own cursor. A loopback `listen` host binds loopback only, under the local grant (ADR-0034), and `http.createServer` runs over `net.Server` with keep-alive, chunked bodies both ways, pipelined requests, `Expect: 100-continue` and `upgrade`. Two narrow, named refusals: `net.Server#listen` on one address that is neither loopback nor every interface, and `FileHandle#createReadStream`/`createWriteStream` (A184, no page-reachable byte stream underneath). UDP and the TCP server are IPv4-only (A218) |
| A standalone WASI program (`wasm32-wasip1`): Node's `wasi` module | `dup` | Rust, C, C++, Zig and TinyGo programs, and libraries built without JavaScript bindings | ✅ built, files only | [`src/shim/wasi/`](../../src/shim/wasi/): a preview1 host over `orivon.fs`, the program suspending on each file call through JSPI on the page's main thread ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). Files, directories, clocks, randomness, arguments, environment and exit work; `start()` returns a promise and `preopens` name paths under the virtual root. Not served: links and file times (`orivon.fs` has neither), sockets (preview1 cannot dial; a WASI 0.2 component `spawn` runs can, per the `child_process` row), and listing the app root itself, which the broker refuses as it does for `fs`. 63 of the 72 preview1 conformance programs pass; the nine that fail need links or file times. E2e in [`e2e-wasi-host.test.ts`](../../test/e2e-wasi-host.test.ts) |
| Synchronous `fs` (`readFileSync`, `existsSync`) | **`needs T1`** | ported apps, at startup | ✅ built | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md), over `ipcRenderer.sendSync`; `existsSync` answers over the same call. Design rule 2 narrows to network operations only. One filed gap: the sync path does not share the async path's per-origin fairness budget (A112). Every other `fs` `*Sync` member, including `realpathSync`, plus `child_process.spawnSync`/`execSync`/`execFileSync`, works too in a Worker (a forked child or a `worker_threads` thread) of a cross-origin isolated app, over the Worker's own synchronous channel ([ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s amendment). `openSync`/`fs.open` keep separate file-descriptor tables; a cross-family fd fails EBADF, naming which family holds it |
| `electron` module | `dup` | every tier-2 app | ⚠️ partial | [`src/shim-electron/`](../../src/shim-electron/): `app.*`/`ipcRenderer`/`ipcMain` work, `BrowserWindow`/`Menu`/`Tray` refuse by design, and `dialog.showOpenDialog` refuses on the host-path/opaque-handle mismatch (A187) |
| HTTP client | `dup` | trackers, web seeds, any REST | ✅ built | The page's own `fetch()`, `XMLHttpRequest` and `EventSource` are routed through the capability for granted hosts ([`routed/fetch.ts`](../../src/preload/routed/fetch.ts), [`routed/xhr.ts`](../../src/preload/routed/xhr.ts), [`routed/eventsource.ts`](../../src/preload/routed/eventsource.ts)): redirects followed, responses streamed, requests queued at the socket allowance. A host the app was not granted takes the native API, CORS and all. Node's `http`/`https` clients sit on the same capability, with timeouts, abort signals, `Agent`, and `upgrade` and 1xx events. Neither webtorrent nor bittorrent-tracker uses Node's HTTP client (the tracker client calls `fetch`), and FreeTube is 32 `fetch` calls with zero Node builtins, so **routed `fetch` is the path both flagship candidates actually take**. Divergences from a browser are listed in [`src/preload/README.md`](../../src/preload/README.md); no keep-alive (A208) |
| WebSocket client | `dup` | dapps, wallets (RPC subscriptions, price feeds, WalletConnect relays) | ✅ built | The page's own `WebSocket` is routed for granted hosts ([`routed/websocket.ts`](../../src/preload/routed/websocket.ts)): `wss:` over the secure-connect capability, `ws:` over TCP connect, an RFC 6455 client in the page, no `permessage-deflate`. An ungranted host keeps the native socket, which the served CSP refuses for any third-party host; workers and iframes keep the native socket (A211). A routed socket holds a socket-allowance slot while it is open (A240) |
| TLS / `https` | **`needs T1`** | nearly every app | ✅ built | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md); `net.connectSecure` in the broker, wired through IPC to a real page. Orivon terminates the handshake on the trusted side, so a grant and a prompt can name the true hostname. Node's `tls` module is built over it and honours `ca`, `rejectUnauthorized`, `cert`/`key`/`pfx`, `servername`, ALPN and a custom `checkServerIdentity`; an option that unbinds the certificate from the host adds the resolve-once address check; STARTTLS cannot work (A226) |
| `child_process` | `dup` | ported apps that spawn helpers or fork workers | ✅ built | [`src/shim/child-process/`](../../src/shim/child-process/): every child runs in a Web Worker, never as an OS process ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)). `spawn`, `execFile` and `exec` run a WASI program from the app's bundle (the command's path, or with `.wasm` added), or a WASI 0.2 component from the jco output shipped beside it, whose sockets reach `orivon.net` under the app's grants, a Rust program on tokio included ([`src/shim/wasi-p2/`](../../src/shim/wasi-p2/)); a native program refuses as `ENOEXEC`, a missing one is `ENOENT`. `fork` runs an app module with `process.send`, IPC and the page's `orivon.*`. `spawnSync`/`execSync`/`execFileSync` work in a Worker of a cross-origin isolated app, over a request kind of their own on its synchronous channel ([ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s amendment) -- the grandchild runs on the serving side exactly as the async forms would there. Refused by name: `shell`, `uid`/`gid`, a foreign `execPath`. A spawned program has one thread: WASI 0.2 has none, so a program that starts threads runs once its port makes it single-threaded (a current-thread runtime, blocking work run inline; `d-0216`). A spawn or a forked child runs in the app's hidden child host and outlives the page that started it while another page of the app is open, ending only with the app's last page ([ADR-0046](../decisions/ADR-0046-an-app-s-children-live-until-its-last-page-closes.md), e2e in [`e2e-child-host.test.ts`](../../test/e2e-child-host.test.ts)). A `worker_threads` thread is not routed through the host: it stays a local Worker of whatever started it, keeping a `SharedArrayBuffer` or a shared `WebAssembly.Memory`/`Module` in `workerData` reachable. E2e in [`e2e-child-process.test.ts`](../../test/e2e-child-process.test.ts) |
| `vm` | `dup` | template compilers and code loaders in ported apps' dependency trees | ⚠️ partial | [`polyfills/vm.ts`](../../src/shim/polyfills/vm.ts): `runInThisContext`, `Script#runInThisContext` and `compileFunction` run in the page's own context, as the served CSP's `'unsafe-eval'` already allows. A context of its own (`createContext`, `runInNewContext`, `runInContext`) needs a second realm and refuses by name |
| The app's own preload surface (`window.<name>`) | `dup` | every app ported from Electron | ➖ per-app | Table 2's fourth family. Not in `src/` at all, and not in this repository: one file per app, in `orivon-ports` |
| `worker_threads` | `dup` | validation-heavy work | ✅ built | [`polyfills/worker-threads.ts`](../../src/shim/polyfills/worker-threads.ts): `new Worker` runs an app module as a thread over the same Web Workers [`child_process.fork`](../../src/shim/child-process/) uses ([`child-process/thread.ts`](../../src/shim/child-process/thread.ts)), with `workerData`, `postMessage`, `terminate()`, `ref()`/`unref()` and Node's events; `isMainThread`, `threadId`, `parentPort`, `workerData` and `resourceLimits` read what the thread itself set. `MessageChannel`/`MessagePort` are Node-shaped over a web `MessagePort` ([`worker/node-port.ts`](../../src/shim/worker/node-port.ts)); `BroadcastChannel` is the platform's. Refused by name: `eval`, a thread started from inside a thread, `receiveMessageOnPort`, `moveMessagePortToContext`; `resourceLimits` is accepted and not enforced |
| Background lifetime | **`outside`** | seeding, syncing, pinning | ⚠️ **unspecified** | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Shell holds the process, contracts describe it, UI shows it. `scope.md` counts `backgroundSec` in the metric but nothing grants it. An app tab that is not the active one is hidden, and keeps Chromium's default throttling of hidden pages |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount. `src/shim-electron/app.ts`'s `getPath` enforces the identical boundary for any name but `'userData'` |
| Secure seed storage (OS keyring, `safeStorage`) | **`dup`** | `orivon.id` surviving a restart, `window.nostr` behind it, `orivon.secrets` | ✅ built | [ADR-0003](../decisions/ADR-0003-local-first-storage.md) puts the identity seed behind Electron `safeStorage` and says **no app, ever** -- amended by [ADR-0033](../decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md) to add: an app may hold its own *derived*, origin-bound secret with a grant, never the seed. Production's `Keychain` ([`electron-keychain.ts`](../../src/main/keyring/electron-keychain.ts)) uses the async `safeStorage` trio; a keyring the async trio cannot reach (`isAsyncEncryptionAvailable()` false, or the selected backend is `basic_text`/`unknown`) yields a **session-only** seed, generated fresh and never written to disk in plaintext -- the file is also never overwritten once one exists but fails to decrypt ([`seed-store.ts`](../../src/main/keyring/seed-store.ts)). `orivon.secrets.available()` is exactly this signal, surfaced to an app so it can choose not to rely on persistence rather than lose data silently |
| Desktop shell (tray, autostart, protocol handlers, hotkeys) | **`outside`** | Electron apps' outer half | ⚠️ partial | `BrowserWindow`/`Menu`/`Tray` are explicit, tested named refusals (`src/shim-electron/desktop-shell.ts`); autostart, protocol handlers and hotkeys are simply absent |
| Secure context (`crypto.subtle`, `crypto.randomUUID`, service workers, `navigator.clipboard`) | **`outside`** | any app using WebCrypto or the async Clipboard API | ✅ on every path | An INSTALLED app's origin is really `https:` ([ADR-0007](../decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md)) and `127.0.0.1` is trustworthy by Chromium's own host rule, so both were always secure. The dev `.eth` path is plain `http:` on a non-loopback host, which Chromium does not trust however the name resolves; [`eth-resolver.ts`](../../src/main/dev/eth-resolver.ts) declares the mapped names secure so the same bundle behaves the same way under either entry URL. Dev-mode only, and only for names the resolver also mapped to loopback |
| Clipboard write (`navigator.clipboard.writeText`) | **`outside`** | any app with a copy button | ✅ built | Allowed for every page by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0022](../decisions/ADR-0022-the-permission-gate-allows-clipboard-write.md)), bounded by the web platform's own transient-activation and document-focus rules rather than by a grant. Not a `CapabilityKind`: nothing is declared in a manifest and no row appears in either permissions popup |
| Clipboard read (`navigator.clipboard.readText`/`read`, `deprecated-sync-clipboard-read`) | **`outside`** | paste buttons; AirGap Vault's "Paste from clipboard", one of its two ways to receive a transaction to sign | ⚠️ **unsettled** | Denied on both handlers of [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts), on every page, and no manifest field or answer from the person can lift it: a yes would hand a page whatever was last copied anywhere on the machine, a password or a recovery phrase included. A paste the person makes (Ctrl+V, the right-click menu) needs no permission; only a page reading on its own is refused. Whether it is ever allowed is the open half of [A202](../open-questions.md). If it is, the shape is that entry's ground 2, a prompt naming the site, as notifications have ([ADR-0028](../decisions/ADR-0028-a-site-shows-notifications-only-after-the-person-allows-it.md)) |
| File System Access, one file (`showOpenFilePicker`, `showSaveFilePicker`, a dropped file) | **`outside`** | any app that imports or exports a file | ✅ built | Allowed by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0024](../decisions/ADR-0024-the-permission-gate-allows-one-chosen-file.md)) for a single file the person picked or dropped, to read or to write. The person's choice of file is the consent, as for `fs.userSelected`. Not a `CapabilityKind`. Writing back to an opened file and reusing a stored handle go without the prompt Chrome shows ([A205](../open-questions.md)) |
| File System Access, a folder (`showDirectoryPicker`, a dropped folder) | **`outside`** | web IDEs, photo organisers | 🚫 excluded by design | Refused on both handlers: a directory handle reaches every file beneath it, and Electron decides this synchronously, so there is no point at which to ask. An app written for Orivon has `fs.userSelected`'s folder shape instead. Whether a folder prompt is ever built is [A205](../open-questions.md) |
| HTML fullscreen (`requestFullscreen`) | **`outside`** | video players, games | ✅ built | Allowed on every page from a click by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0025](../decisions/ADR-0025-the-permission-gate-allows-html-fullscreen.md)). The tab fills the window with the chrome hidden, "Press Esc to exit full screen" shows for four seconds, and Escape always leaves. Not a `CapabilityKind` |
| Pointer lock (`requestPointerLock`) | **`outside`** | games, 3D viewers, remote desktops | ✅ built | Allowed on every page by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0026](../decisions/ADR-0026-the-permission-gate-allows-pointer-and-keyboard-lock.md)); Chromium still requires a click. Escape releases it, and "Press Esc to show your cursor" says so |
| Keyboard lock (`navigator.keyboard.lock`) | **`outside`** | fullscreen games, remote desktops | ✅ built | Allowed on every page ([ADR-0026](../decisions/ADR-0026-the-permission-gate-allows-pointer-and-keyboard-lock.md)); it acts only in fullscreen. A page holding Escape gets a single press, holding Escape leaves fullscreen, and "Press and hold Esc to exit full screen" says so |
| External protocol links (`mailto:`, `magnet:`, `bitcoin:`, ...) | **`outside`** | mail, torrent and payment links | ✅ built | Opened by the OS's default app only after the person allows it in a dialog naming the site and the URL, every time ([ADR-0027](../decisions/ADR-0027-an-external-link-opens-only-when-the-person-allows-it.md)). The browser's own schemes and known-dangerous OS handlers are never offered |
| Notifications (`Notification.requestPermission`) | **`outside`** | chat, mail, transaction alerts | ✅ built | The site is asked once; Allow and Block are remembered per site and can be reset from the permissions panel ([ADR-0028](../decisions/ADR-0028-a-site-shows-notifications-only-after-the-person-allows-it.md)). An undecided site reads `Notification.permission === 'denied'`, measured (A243) |
| Camera and microphone (`getUserMedia`) | **`outside`** | QR scanners, video calls, camera or microphone entropy; AirGap Vault's QR scan, its other way to receive a transaction to sign | ❌ missing | Denied on both handlers of [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts), on every page, and no manifest field or answer from the person can lift it. A yes would take ground 2 of [A202](../open-questions.md)'s rule: a prompt naming the site and whether it wants the camera, the microphone or both, remembered per site and resettable from the permissions panel, as notifications are ([ADR-0028](../decisions/ADR-0028-a-site-shows-notifications-only-after-the-person-allows-it.md)). It also needs two things Chrome draws and the shell does not: an in-use indicator on the tab, and a reset that stops a stream already running. That Electron sends `media` to the request handler, which can wait on the person, with `mediaTypes` naming which device, comes from its typings and is not measured. Screen capture (`getDisplayMedia`) is refused too: no picker is built |
| `window.open()` popups that keep `window.opener` | **`outside`** | OAuth and wallet sign-in | ✅ built | A popup the page can talk to becomes a tab in its opener's session ([`popups.ts`](../../src/main/shell/popups.ts)); `noopener` and links open ordinary tabs; a `blob:` URL the page minted opens; a popup into an isolated app opens in that app's own session. An open-web popup an app opens runs in the app's partition until its opener closes (A230) |
| A sign-in that sends the tab away and back (OIDC, OAuth redirects) | **`outside`** | Matrix clients and any app behind an OIDC provider | ✅ built | A tab that leaves an app for a sign-in provider gets the app's own view back on return, with its `sessionStorage` and back history ([`tab-view.ts`](../../src/main/shell/tab-view.ts)'s `repartitionView()`; `test/e2e-session-storage-return.test.ts`). A form `POST` back across the app boundary still arrives as a `GET` (A233) |
| `beforeunload` guard | **`outside`** | editors, forms with unsaved work | ✅ built | Asks Leave or Stay. The question blocks the main process while it is open, and closing a tab does not ask (A231) |
| User-Agent | **`outside`** | sites and sign-in pages that check for Chrome | ✅ built | Every tab reports a plain Chrome User-Agent, with no `Electron/` or `orivon/` token |
| Right-click menu | **`outside`** | copy, paste, open a link | ✅ built | In tabs and the address bar ([`context-menu.ts`](../../src/main/shell/context-menu.ts)) |
| `prompt()` | **`outside`** | apps that ask for text this way | ❌ missing | Returns `null` at once: Electron draws no prompt dialog and offers no hook to supply one (A232) |
| Code made at run time (`eval`, `new Function`, WebAssembly), `data:`/`blob:` URLs, blob workers and frames | **`outside`** | ajv, protobufjs, template compilers, wasm libraries, MSE video | ✅ built | An installed app's served CSP, and that of an app granted without installing, carries `'unsafe-eval'` and `'wasm-unsafe-eval'`, admits `data:`/`blob:` in `connect-src`, `img-src`, `font-src` and `media-src`, and sets `worker-src 'self' blob:` and `frame-src 'self' data: blob:`. A `*` `https.connect` grant admits any https subresource, each one re-authorised by the app's own handler ([`src/loader/README.md`](../../src/loader/README.md)) |
| WebAssembly threads: `SharedArrayBuffer`, a shared `WebAssembly.Memory`, `Atomics.wait` in a worker | **`outside`** | a component built with threads (wasm-bindgen-rayon, Emscripten pthreads, Go's runtime with threads) | ✅ built | Chromium turns these on only for a cross-origin isolated page. A manifest declaring `crossOriginIsolated: true` gets its documents and workers served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`, on the installed path ([`serve/csp.ts`](../../src/loader/serve/csp.ts)) and the granted-without-install path ([`granted-origin-csp.ts`](../../src/main/install/granted-origin-csp.ts)); without the flag a page has no `SharedArrayBuffer` global, measured. Opt-in because an isolated page's popups lose `window.opener` and its cross-origin loads carry no credentials. E2e in [`e2e-wasm-threads.test.ts`](../../test/e2e-wasm-threads.test.ts). A worker still has no `orivon.*` of its own: a component that needs the network or the filesystem from a worker thread proxies through the page |
| Installing a real built frontend (static-host redirects, extra manifest fields, large assets, client-side routes) | **`outside`** | every installed app | ✅ built | The loader follows a host's same-origin redirects (`/index.html` to `/`), ignores an unknown top-level manifest field such as `$schema`, `description`, `icons` or `homepage` with a warning, and takes assets up to 64 MiB in bundles up to 512 MiB, streamed to and from disk in constant memory, Range requests included. Reloading a client-side route serves the entry document. An unchanged app costs one conditional manifest request (a 304) an hour, and the interval survives a restart (A236). A capability revoked in the permissions panel is not asked for again at the next launch, and the app can still request it |
| Delivery from a `.eth` name (IPFS content under an ENS name) | **`outside`** | apps published on IPFS rather than an HTTPS host | ✅ built | `https://<name>.eth` loads as an ordinary origin ([ADR-0030](../decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)): the Helios light client proves the contenthash (IPFS CID, IPNS key or DNSLink, CCIP-Read included), every block is hashed against its CID, and a failure is an error page, never unverified bytes. It installs through the same hint and dialog and runs from its pin with every server gone. Shown as `ipfs://<name>` wherever an address or origin is shown; both `ipfs://<name>` and `ipns://<name>` open it ([ADR-0038](../decisions/ADR-0038-an-address-scheme-is-shown-as-itself-and-served-over-https.md)). Website Level 2 on the Web3 Score page. **Named limits:** no Swarm or Arweave, no internationalised names, and one keyless beacon API (A253) |
| Delivery from an `ipfs://` or `ipns://` address | **`outside`** | IPFS content linked or shared by its address | ✅ built | Typed, linked or opened in a new window, shown as itself in the address bar and on every consent surface, and served at an ordinary https origin, `https://<cid>.ipfs.orivon` ([ADR-0038](../decisions/ADR-0038-an-address-scheme-is-shown-as-itself-and-served-over-https.md)), every block checked as for a `.eth` name. `ipns://` takes an IPNS key or a DNSLink name. **Named limits:** an `ipfs://` subresource inside a page does not load (A260), and a new release under `ipfs://` is a new origin, so apps that keep grants ship under `ipns://` or `.eth` |
| Native addon in the dep tree | **`outside`** | see Table 5 | ⚠️ partial | Loaded as its WebAssembly build ([`src/shim/addon/`](../../src/shim/addon/), [ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)): `process.dlopen` and `module.createRequire` take the `.node` path and load the build beside it through emnapi, a napi-rs build by napi-rs's own conventions (a real napi-rs 3 build's calls, async work and file reads pass). Its file calls work in a forked child of a cross-origin isolated app, and refuse with `NOSYS` on the page's main thread. Not yet through `process.dlopen`: sockets, and threaded builds. A napi-rs package's published WebAssembly build, which is threaded, runs without that loader: through the package's own browser loader, in an app whose manifest sets `crossOriginIsolated: true`. An addon with no WebAssembly build still needs a substitute (Table 5). E2e in [`e2e-native-addon.test.ts`](../../test/e2e-native-addon.test.ts), and opt-in for a published napi-rs package in [`e2e-napi-rs-package.test.ts`](../../test/e2e-napi-rs-package.test.ts) |

## Table 4: open blockers, and the cheapest lever for each

Ordered by reach per unit of effort. **The ordering is a recommendation, not a schedule.** Only
open blockers are listed; a resolved one is deleted, not struck through.

| # | Blocker | Cheapest lever | Cost shape |
|---|---|---|---|
| 1 | No named identities: `id.requestIdentity` is unbuilt, so `window.nostr` cannot reach a page | Build it; no decision blocks it | A111 |
| 2 | `DirectoryHandle`'s method set is unconfirmed | Confirm the shape the folder picker is already built against; no new build work | A167 item 2, A195 |
| 4 | `dialog.showOpenDialog` cannot map onto `fs.userSelected`: one returns host paths, the other an opaque handle | A shim-side shape decision | A187 |
| 5 | `FileHandle.readable()`/`writable()` are not page-reachable, so a handle's own `FileHandle#createReadStream`/`createWriteStream` refuse (the module-level `fs` streams work) | Deliver a byte stream over a dedicated port, the mechanism `net.connect` already uses | A184 |
| 6 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly |
| 7 | `protocols` is declared and validated but unbuilt on both sides | Unfiled; needs a decision first on how a routed URI reaches the app | Contracts + shell + prompt UX |
| 8 | Camera, microphone and clipboard read are denied on every page with no route to a yes, so AirGap Vault can create and hold keys but never receive a transaction to sign | A prompt on the pattern notifications already use (A202's ground 2); camera also needs a tab indicator and a reset that stops a running stream. Needs a decision first: whether either is allowed at all | Shell + prompt UX; A202 for clipboard read |
| 9 | `hid`/USB, the wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 10 | A native addon's WebAssembly build that is threaded and loaded through `process.dlopen` rather than a napi-rs package's own loader | Threads as emnapi workers over `worker_threads`, once an addon build needs them. An addon that runs a network node runs that node as a WASI 0.2 component the app spawns and reaches over loopback, which works today (`d-0216`); an addon with no WebAssembly build: substitute per library (Table 5) | Shim work; threads need `crossOriginIsolated` |
| 11 | Tier 3, no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |

Rows 1 and 2 are the top of the list: neither needs anything but the work itself or one
confirmation. Row 6 sits behind them despite touching the metric, because it needs
a decision before it is even build-shaped. **Unfiled:** rows 6 and 7, row 8's camera and
microphone half, plus declarability (what a grant prompt can honestly say for runtime-chosen
hosts) and per-syscall IPC cost on a chatty workload.

## Table 5: the native-module question, per library

*Could native binaries be preinstalled, bypassing Rule 8, to reach these?*

**The mechanical answer first.** App code runs with `sandbox: true, nodeIntegration: false`, and
no native module runs for an app ([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)).
An addon whose WebAssembly build the app ships loads as that build (Table 3); for one with none,
this table is the substitute per library.

| Library | Why an app wants it | Renderer answer that exists today | Verdict |
|---|---|---|---|
| `better-sqlite3` | local relational store | `sql.js` / `wa-sqlite` (WASM SQLite) over `orivon.fs`, or IndexedDB | ✅ No capability needed. Slower; irrelevant at this scale |
| `leveldown` / `classic-level` | key-value store | `browser-level` (IndexedDB), `memory-level`; the level ecosystem ships browser backends by design | ✅ No capability needed |
| `secp256k1` bindings | ECDSA / Schnorr | `@noble/secp256k1`, pure JS and audited; plus `orivon.id.sign` for the user's key | ✅ No capability needed. ~10x slower, still thousands of ops/sec |
| `node-datachannel` | WebRTC inside Node | the renderer has real `RTCPeerConnection` | ✅ Evaporates. `check-no-native-modules.mjs` names this exact chain as the threat; in a renderer it isn't one |
| `node-usb` / `node-hid` | hardware wallets | nothing; it is physical device access | ❗ **Genuine.** But Rule 8 was never the blocker: it needs `orivon.hid.*`, a device chooser and a grant, which cost the same either way |

**What the question is really pointing at is a real gap:** the missing thing is not permission
to compile C++, it is **a place to run non-renderer code**. `ADR-0005` dissolved the "app
backend", so all app code runs in the renderer. Preinstalled natives only pay off once something can
load them on an app's behalf: `subprocess`, or the container path. Neither is built yet.

## Table 6: how to update this

Check the code, do not trust the tables above.

| Cell | Recipe |
|---|---|
| Table 1, Spec'd | Read [`capability-api.ts`](../../src/contracts/capability-api.ts). A PROVISIONAL doc comment means ⚠️, not ✅ |
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker`: a function that exists but isn't returned is not reachable. The broker is split: `net`'s five entry points (`connect`/`connectSecure`/`udpBind`/`listen`/`lookup`) live in `capabilities/net.ts`, `fs`'s nine (including `open`) in `capabilities/fs.ts`, and `id`'s two in `capabilities/id.ts`, each returned from its own factory and re-exported through `createBroker`'s own returned object, so check those files too, not just `index.ts` |
| Table 1, Page | `grep -n "call('" src/preload/surface/orivon.ts`, plus `src/preload/surface/main-world-socket.ts` for what the main-world wrapper builds. A real-Electron e2e test is the strongest proof a real page can call it; where none exists, a test exercising the real `installOrivon` wiring rather than a hand-built stub is the fallback: weaker, but still a real dispatch/preload path, not just a file that exists |
| Table 1, Node shim | `ls src/shim/` |
| Table 2 | Node family: `src/shim/`. Electron family: `src/shim-electron/`. Web family: `src/nostr/`. Fourth family: not in this repository at all -- it is each app's own bridge, one file per app in `orivon-ports`, and a missing one is that app's gap, never Orivon's |
| Table 3, Status | Mostly absence; verify by looking for the module, not for a mention of it |
| Table 3, Class | Not observable in the tree; derived. `dup` if Table 2's families name the surface at all, `needs T1` if they do but Table 1 has no entry the adapter could be built on, `outside` if no Node/`electron`/web API expresses the problem. Re-derive the row when Table 1 or the shim README's declared scope changes, not when a status flips |
| Table 4 | When a blocker is resolved, **delete the row**. This table lists only what is still open |
| Table 7a/7b | `ls src/main/extensions/` for lifecycle (Orivon's own code); `src/broker/policy/extension-manifest.ts` for manifest-key handling, split with `vendor/electron-chrome-extensions` |
| Table 7c | `grep -rn "handle('" vendor/electron-chrome-extensions/src/browser/api/` for what a namespace's own handler registers, plus a real load's own `typeof chrome.<namespace>` check -- a namespace can exist and still be a no-op, so read the handler body, not just its presence |
| Table 7d | `src/main/extensions/extension-host.ts` for session wiring, popup and toolbar behaviour; `docs/decisions/ADR-0044-*.md`/`ADR-0045-*.md` for the granted-app carve-out |
| Table 8 | Grep the area's own directory under `src/main/` or `src/renderer/`; a feature's absence is confirmed by an exhaustive keyword search, not by reading one file |
| Every cell | **State the current state and nothing else.** No "what changed since the last derivation", no "moved from ❌ to ✅", no PR numbers, no struck-through rows, no "this pass". A reader needs to know what works now; what changed and when is git history and [`../decisions/decision-log.md`](../decisions/decision-log.md) |

**Do not let this grow into a second copy of `app-compatibility.md`.** If an entry starts
explaining *why a tier exists*, it belongs there.

## Table 7: Extensions

What an extension gets in this build. Measured two ways: four real extensions (uBlock Origin
Lite, Dark Reader, Bitwarden, MetaMask) through `test/e2e-extensions-real.test.ts`, and a fifth
(Volume Master, opt-in via `ORIVON_VOLUME_MASTER_DIR`) through
`test/e2e-extensions-offscreen-capture.test.ts`; plus a full `chrome.*` namespace sweep across a
service worker, popup, options page, a `side_panel`-declared tab, a sandboxed page and content
scripts (isolated and MAIN world, MV2 and MV3), run with the Chromium sandbox on.

### Table 7a: Install, update and lifecycle

| Part | Works | Note |
|---|---|---|
| Install: unpacked folder | ✅ | `orivon://extensions` Developer mode (`install-runner.ts`) |
| Install: `.zip` | ✅ | Symlink entries and path-traversal entries refused |
| Install: `.crx` (CRX3) | ✅ | Needs the developer's own signature; Orivon's own verifier, not the library's |
| Install and update from the Chrome Web Store | ✅ | The store's own "Add to Chrome" button; developer signature and the store's publisher proof both checked before any bytes are kept (`ADR-0043`) |
| A held-back update that would widen host access or add a warned permission | ✅ | Shown as pending, not installed silently (T19 subset rule) |
| Stable id across updates | ✅ | Every loaded copy carries a `key` |
| Enable / disable | ✅ | Registry entry toggle |
| Uninstall | ✅ | |
| Reload (Developer mode) | ✅ | |
| File access (`--allow-file-access`) | 🚫 | Never granted to any extension |
| Incognito access | ➖ | Moot: no private window runs any extension (Table 7d) |
| An extension's own errors/crash log page | ❌ | No `orivon://extensions?errors=` equivalent |
| Load warning for a permission this build actually provides (`contextMenus`, `cookies`, `webNavigation`, `notifications`, others in 7c) | ✅ | No longer logs "Permission '\<name\>' is unknown" for one this build honours; a genuinely absent permission still logs it (`vendor/electron-chrome-extensions`) |

### Table 7b: Manifest keys

| Key | Works | Note |
|---|---|---|
| `manifest_version` (2 or 3) | ✅ | Both load; Orivon's own policy layer also reads it |
| `name`, `version`, `description`, `icons` | ✅ | |
| `content_scripts`: `matches`, `js`/`css` | ✅ | `<all_urls>` and scoped matches both measured |
| `content_scripts`: `"world": "MAIN"` | ✅ | Runs; no real extension API leaks into it (confirmed: `window.chrome` there is Chromium's ordinary non-extension shim, not this extension's surface) |
| `content_scripts`: `all_frames` | ✅ | Confirmed in a same-origin `<iframe>`, MV2 and MV3 alike |
| `content_scripts`: `match_about_blank` | ✅ | Confirmed in an `about:blank` `<iframe>`, MV2 and MV3 alike |
| `content_scripts`: `run_at` | ✅ | `document_idle` measured |
| `background.service_worker`, `"type": "module"` | ✅ | The worker's first start after a fresh load is reloaded once to receive events it raced (Table 7d) |
| `background.scripts` (MV2 persistent page) | ✅ | Loads (a deprecation warning only, does not block); reachable with the same full extension-page API surface as MV3's service worker |
| `action` (MV3) / `browser_action` (MV2): `default_popup`, `default_icon`, `default_title` | ✅ | Toolbar button, badge and popup |
| `options_page` | ✅ | Opens in a tab |
| `options_ui` | ⚠️ | Opens in a tab, same as `options_page`; the embedded (`open_in_new_tab: false`) mode is not implemented |
| `chrome_url_overrides` (`newtab`, `history`, `bookmarks`) | ❌ | Never honoured; a new tab always shows Orivon's own dashboard |
| `devtools_page` | ⚠️ | Electron supports `chrome.devtools.*` natively; not separately measured loading a `devtools_page` |
| `web_accessible_resources` | ✅ | Tracked for the install prompt; Chromium enforces the resource list itself |
| `externally_connectable` | ❌ | No wiring for `runtime.onMessageExternal`/`onConnectExternal` |
| `commands` | ⚠️ | `getAll`/`onCommand` work; no page to view or rebind an extension's key combinations |
| `omnibox` | ❌ | Orivon's own address bar is unrelated code |
| `side_panel` | ❌ | `chrome.sidePanel` is a no-op stub (Table 7c); the key drives no real panel surface |
| `host_permissions` | ✅ | Gates `chrome.cookies`/`chrome.tabs`/`insertCSS`/`webNavigation` API access |
| `optional_permissions` / `optional_host_permissions` | ⚠️ | `request`/`contains`/`getAll` work; `remove` always reports success without removing anything; a granted optional permission is not persisted across a reload |
| `incognito` (`spanning`/`split`/`not_allowed`) | ➖ | Moot: no private window runs any extension |
| `storage.managed_schema` | ❌ | No enterprise policy delivery in this build |
| `declarative_net_request` (ruleset key) | ⚠️ | Read and recorded, not applied; the API it would drive is a stub (Table 7c) |
| `content_security_policy` | ⚠️ | Chromium enforces an extension's own declared CSP; not separately measured |
| `sandbox` (sandboxed pages) | ⚠️ | No `chrome.*` from the library and Chrome's own CSP `sandbox`, an opaque origin (`d-0208`); a doubled-slash spelling of the page still answers `chrome.tabs.query` (A303) |
| `file_browser_handlers`, `file_handlers` | ➖ | ChromeOS / native file-handler surfaces with no equivalent here |
| `default_locale`, `_locales/*/messages.json` (`__MSG_...`) | ✅ | The extensions page resolves a name/description/icon reference the same way Chrome does |
| `oauth2` | ❌ | No `chrome.identity` (Table 7c), so this key drives nothing |
| `key` | ✅ | Read the way Chromium reads it, used to keep an id stable; refused if it does not parse |
| `minimum_chrome_version` | ❌ | Not read or enforced |
| `update_url` | ✅ | Tracked as a manifest fact; a Chrome Web Store install's own updater is Orivon's path, not this key |
| `homepage_url`, `short_name`, `version_name` | ❌ | Not read |
| `export` / `import` (shared modules) | ❌ | Not read |
| `tts_engine` | ❌ | No `chrome.tts`/`chrome.ttsEngine` (Table 7c) |
| `cross_origin_embedder_policy` / `cross_origin_opener_policy` | ⚠️ | Chromium's own enforcement; not separately measured |
| `mime_types_handler`, `chrome_settings_overrides`, `requirements` | ❌ | Not read |
| A top-level `orivon` key | 🚫 | Refused outright: the whole manifest is rejected rather than partly honoured |
| An unknown key or permission | ✅ | Loads; an unknown permission only logs a console warning, never fails the load |

### Table 7c: `chrome.*` API namespaces

Ordinary (non-ChromeOS, non-enterprise) surface, grouped by status. A namespace object existing
is not the same as it doing anything: read the note, not just the symbol.

**Present, with real behaviour:**

| API | Works | Note |
|---|---|---|
| `action` (MV3) / `browserAction` (MV2) | ✅ | Toolbar button, badge, title, icon, popup, `getUserSettings` |
| `alarms` | ✅ | `create` + `onAlarm` measured firing |
| `commands` | ✅ | `getAll`, `onCommand` measured working |
| `contextMenus` | ✅ | `create`/`remove`/`removeAll`/`onClicked` work; `update` is a no-op |
| `cookies` | ✅ | `get`/`getAll`/`set`/`remove`/`getAllCookieStores`/`onChanged`, gated on the `cookies` permission and per-URL host access |
| `devtools.inspectedWindow`, `devtools.network`, `devtools.panels` | ✅ | Native to Electron |
| `dns` | ⚠️ | `chrome.dns.resolve` exists as a real function, not exercised in measurement; dev-channel-only in real Chrome too |
| `downloads` | ⚠️ | Every method and event is a declared no-op stub; nothing downloads, cancels or reports |
| `extension` | ⚠️ | `isAllowedFileSchemeAccess`/`isAllowedIncognitoAccess` always answer `false`; `getViews` always `[]` |
| `i18n` | ⚠️ | `getMessage` resolves the real `_locales` string; `getUILanguage`/`getAcceptLanguages` are hardcoded `en-US`, no real negotiation |
| `idle` | ✅ | `queryState()` measured returning `"active"` |
| `management` | ⚠️ | Only `getPermissionWarningsByManifest`/`getSelf`/`uninstallSelf` are real; `getAll` is not a function |
| `notifications` | ⚠️ | `clear`/`getAll`/`update`/its three events present; `create`'s live effect is untested by policy (nothing here reaches a real OS notification) |
| `offscreen` | ✅ | `createDocument`/`closeDocument`/`hasDocument`; one document per extension, in no window, with no `window.open` and no navigation off the extension |
| `permissions` | ⚠️ | `contains`/`getAll`/`request` work against the manifest's declared set; `remove` always reports success without removing anything |
| `power` | ✅ | `requestKeepAwake`/`releaseKeepAwake` callable; not independently verified to keep the OS awake |
| `printerProvider` | ⚠️ | Exists as an object; no working members measured |
| `privacy` | ⚠️ | Inert `ChromeSetting` placeholders; a `get` call triggers a native "Unknown Extension API" log |
| `proxy` | ⚠️ | Exists as a namespace; `settings.get` explicitly rejects `"Access to extension API denied."` |
| `runtime` | ⚠️ | `id`/`getManifest`/`getURL`/`connect`/`sendMessage`/lifecycle events/`openOptionsPage` work; `getContexts` lists the worker, popup, tab pages and offscreen document; `connectNative`/`disconnectNative`/`sendNativeMessage` throw by design (below) |
| `scripting` | ✅ | `executeScript` measured running a real function in a tab and returning its result |
| `sidePanel` | ⚠️ | Every method resolves as a no-op; no panel surface opens |
| `storage.local` | ✅ | Native to Electron |
| `storage.sync`, `storage.managed` | ⚠️ | Alias `local`; no real multi-device sync or policy delivery |
| `storage.session` | ✅ | Measured round-tripping in a service worker/popup/options/tab; present as a real function in an MV3 isolated content script, absent in MV2's |
| `system.cpu`, `system.display`, `system.memory`, `system.storage` | ✅ | `system.cpu.getInfo()` measured returning real hardware data (actual CPU model, core count, per-core usage) |
| `tabCapture` | ✅ | `getMediaStreamId`/`getCapturedTabs`/`onStatusChanged`; needs a click on the extension's toolbar button on that tab; only an http(s) tab of no app holding grants; the tab is muted locally while captured |
| `tabs` | ⚠️ | A rich working set, filtered by permission/host access; `captureVisibleTab` specifically is not a function |
| `topSites` | ⚠️ | `get()` resolves an empty stub |
| `userScripts` | ⚠️ | Every method resolves as a no-op; no user-script world runs |
| `webNavigation` | ✅ | `getFrame`/`getAllFrames` and the full event set work |
| `webRequest` | ⚠️ | Every event object exists so feature-detection does not throw, but none of it ever fires -- Orivon owns the session's one `webRequest` listener |
| `declarativeNetRequest` | ⚠️ | Write methods reject "not supported"; read methods resolve empty; the ruleset key is read and recorded, never enforced |
| `windows` | ⚠️ | A rich working set, filtered the same as `tabs` |

**Not there** (`typeof === 'undefined'` in every context measured, including the most privileged):

| API | Works |
|---|:--:|
| `bookmarks`, `browsingData`, `contentSettings`, `debugger`, `declarativeContent`, `desktopCapture`, `dom`, `fontSettings`, `gcm`, `history`, `identity`, `instanceID`, `mimeHandler`, `omnibox`, `pageCapture`, `processes` (dev-channel-only in Chrome itself too), `publicSuffix`, `readingList`, `search`, `sessions`, `tabGroups`, `tts`, `ttsEngine`, `types`, `webAuthenticationProxy` | ❌ |

**Excluded by design:**

| API | Works | Note |
|---|---|---|
| `nativeMessaging`, `runtime.connectNative`/`disconnectNative`/`sendNativeMessage` | 🚫 | Present only to throw "Native messaging is not supported in Orivon"; starting a desktop program is native code outside the broker |

**Not applicable** (ChromeOS-only or enterprise-policy-only in Chrome itself):

`accessibilityFeatures`, `audio`, `certificateProvider`, `documentScan`,
`enterprise.deviceAttributes`, `enterprise.hardwarePlatform`, `enterprise.login`,
`enterprise.networkingAttributes`, `enterprise.platformKeys`, `fileBrowserHandler`,
`fileSystemProvider`, `input.ime`, `loginState`, `platformKeys`, `printing`, `printingMetrics`,
`systemLog`, `vpnProvider`, `wallpaper` -- all ➖, none apply outside ChromeOS or an enterprise
policy source this build has no equivalent of.

### Table 7d: Extension pages and behaviour

| Behaviour | Works | Note |
|---|---|---|
| Extension pages: popup | ✅ | A child `BrowserWindow` |
| Extension pages: options tab | ✅ | Both `options_page` and `options_ui` open a tab |
| Extension pages: an extension's own full page opened as a tab | ✅ | Same URL policy as any extension-initiated navigation |
| Extension pages: offscreen documents | ✅ | `chrome.offscreen`; one per extension, never shown (Table 7c) |
| Extension popup: closes on focus loss elsewhere in Orivon, on tab switch and navigation | ✅ | |
| Extension popup: paints its theme colour before first paint | ✅ | |
| Extension popup: a `chrome.*` call on its first line | ✅ | No longer fails with "unknown extension context" |
| Service worker: starts at boot for every enabled entry | ✅ | Into the default session |
| Service worker: wakes on `tabs`/`webNavigation`/etc. events | ✅ | Measured with real extensions, sandboxed |
| Service worker: first-start race | ⚠️ | A fresh load's first worker can miss its own preload registration on the first attempt; Orivon detects the miss and reloads once, which recovers every measured case |
| Messaging: `runtime.sendMessage`/`connect` (same extension) | ✅ | Sender-id checked against the caller's own `chrome-extension://<id>/` origin, so one extension cannot read or trigger another's handlers by claiming its id |
| Messaging: `tabs.sendMessage` | ✅ | |
| Messaging: `externally_connectable` (web-page-initiated) | ❌ | Not wired |
| Messaging: native messaging | 🚫 | Refused (Table 7c) |
| Storage: `local` | ✅ | Native to Electron |
| Storage: `sync`/`managed` | ⚠️ | Alias `local`, not real sync or policy delivery (Table 7c) |
| Storage: `session` | ✅ | Confirmed round-tripping (Table 7c) |
| Storage: quotas | ⚠️ | Whatever Electron's own `storage.local` implementation enforces; not measured separately |
| i18n / `_locales` | ✅ | Name/description/icon resolution on the extensions page; `chrome.i18n` itself is a thin, non-negotiated fallback (Table 7c) |
| Toolbar: pin/unpin, badge, icon, title | ✅ | |
| Toolbar: enable/disable a button per tab | ✅ | `getState`/`activate` |
| Site access controls: "on click" / "on specific sites" / "on all sites" picker | ❌ | Not modelled; host access is all-or-nothing per the manifest's own declared patterns, decided once at install/update |
| Site access controls: `activeTab` (temporary grant on click) | ❌ | Treated like any other declared permission, not as a one-click temporary host grant |
| Incognito / private windows | ❌ | A private session loads no extensions at all; the `incognito` manifest key drives nothing |
| Updates from the Web Store | ✅ | Table 7a |
| Install from CRX/zip/unpacked | ✅ | Table 7a |
| Enabling/disabling/uninstalling | ✅ | Table 7a |
| Errors page | ❌ | Table 7a |
| Keyboard shortcuts page | ❌ | `chrome.commands` itself works; no page to view or rebind a combination |
| Extension devtools/inspect views | ⚠️ | `chrome.devtools.*` is native to Electron; no test exercises it end to end |
| Running without the Chromium sandbox | ❌ | The service-worker preload that injects most `chrome.*` APIs is silently never invoked for any worker when Electron launches `--no-sandbox`; every automated launch here runs sandboxed instead (`A289`) |
| Apps a person has granted permissions to | ✅ | One instance, in the default session (`ADR-0044`); extension code is refused at `window.orivon`, a filter rather than a session split (`ADR-0045`). An app served from its pinned copy keeps its own partition and runs none |

## Table 8: The browser around the apps

The traditional-browser feature set, checked against Chrome, Firefox, Edge, Brave and Safari as
the reference set, and whether this build has it.

### Navigation and address bar

| Feature | Orivon | Note |
|---|---|---|
| Back / forward | ✅ | `webContents.goBack/goForward` (`src/main/shell/tabs.ts`), `Alt+Left`/`Alt+Right` |
| Reload / stop | ✅ | `nav.reload`/`nav.hardReload`; no Stop control separate from the reload button toggling |
| Home button | ❌ | No homepage/home-button concept |
| Omnibox: address-or-search classification | ✅ | `src/main/browsing/omnibox.ts`, refuses `javascript:`/`data:`/`file:`/`about:` typed in the bar |
| Search suggestions (live dropdown) | ❌ | No suggestion/autocomplete code for the address bar |
| History/bookmark autocomplete in the bar | ❌ | Omnibox is pure classification only |
| Default search engine choice | ✅ | Eight built-in engines (DuckDuckGo default), `search-engines.ts` |
| Custom search engines / keywords | ⚠️ | One custom template URL; no per-keyword multiple engines, no bang syntax |
| URL display / eliding | ⚠️ | Orivon's own plain `<input>`, not a Chromium omnibox; shows the literal full URL, only rewriting an internal `https://<name>.ipfs.orivon` address back to `ipfs://<name>` |
| Security indicator / padlock | ⚠️ | No padlock; a broader "Website Level" trust indicator (`src/trust/`) replaces it |
| Site info panel | ✅ | `src/main/permissions/site-info.ts`, `popover-view.ts`, `site-info-panel.ts` |
| Copy URL | ✅ | Native input field behaviour |
| Paste-and-go | ⚠️ | Paste works; no dedicated context-menu command |
| QR code share of current page | ❌ | Not found |
| `view-source:` | ⚠️ | Reaches Chromium's own built-in viewer (internal scheme list); no address-bar menu item or shortcut types it for a person |
| `data:` / `file:` typed in the address bar | 🚫 | `DANGEROUS_SCHEMES` refuses `javascript:`, `data:`, `file:`, `about:` typed or pasted |
| `file://` browsing (via a link, not typed) | ⚠️ | Treated as internal (loads directly); directory-listing behaviour is Chromium's own default, unverified without a launch |

### Tabs

| Feature | Orivon | Note |
|---|---|---|
| New tab | ✅ | `tab.new` (`Mod+T`) |
| Close tab | ✅ | `tab.close` (`Mod+W`) |
| Reopen last closed tab | ❌ | No closed-tab stack |
| Restore previous session on launch | ❌ | A fresh launch opens a clean window |
| Pin tab | ❌ | No pinned state on a tab |
| Mute tab | ❌ | No per-tab audio mute |
| Audio-playing indicator | ❌ | No audible-state indicator on the tab strip |
| Duplicate tab | ✅ | `tab-menu.ts` |
| Drag to reorder | ✅ | `tab-drag.ts`, `tab-order.ts` |
| Tear off into a new window | ✅ | `tear-drag.ts` |
| Move tab to another open window | ✅ | `tab-menu.ts`, `tab-move.ts` |
| Tab groups (named/coloured) | ❌ | No grouping concept |
| Vertical tabs | ❌ | Tab strip is horizontal only |
| Tab search (Ctrl+Shift+A style) | ❌ | Not found |
| Hover preview / thumbnail | ❌ | Not found |
| Tab discarding / memory saver | ❌ | No discard/suspend logic |
| Split view (two tabs side by side) | ✅ | `split-controller.ts`, `split-model.ts`, `split-frame.ts` |
| Close other tabs | ✅ | `tab-menu.ts` |
| Next/previous tab, go to tab N | ✅ | `tab.next`/`tab.previous`/`tab.goto1..9`/`tab.gotoLast` |
| Open a link in a new tab (`target=_blank`, `window.open`) | ✅ | Every such request reaches `setWindowOpenHandler`; ctrl+shift+click and `target=_blank` open it in the foreground |
| Open a link in a background tab (keeps the current tab focused) | ✅ | A middle click or a plain ctrl+click opens a background tab; the current tab stays in front (`popups.ts`) |
| Open a link in a new window (Shift+click) | ✅ | Opens a real new window; a private window's shift+click opens a private window (`popups.ts`) |
| Middle-click a tab to close it | ✅ | `auxclick`/`mousedown` guard on each tab element |
| Middle-click the empty end of the tab strip to open a tab | ⚠️ | Linux X11 only (`docs/open-questions.md` A292) |
| Tab loading spinner | ✅ | `.loading` class on the favicon element |
| Tab title tooltip on hover | ❌ | No `title` attribute on an ordinary tab element |
| Tab close button appears on hover | ✅ | `.tab:hover .close` |
| Tab crashed indicator | ❌ | `render-process-gone` only logs to the console |

### Windows and profiles

| Feature | Orivon | Note |
|---|---|---|
| Multiple windows | ✅ | `window-registry.ts` |
| Private/incognito window | ✅ | Empty-on-open, deleted-on-close session (`private-session.ts`) |
| Guest mode | ❌ | No guest-session concept distinct from a private window |
| Profiles | ✅ | `orivon://profiles`, `profile-store.ts`: a separate browser instance/data directory |
| Full screen (browser chrome, F11) | ✅ | `fullscreen.ts` |
| Kiosk mode | ❌ | No kiosk-window option |
| Always on top | ⚠️ | Only for the ephemeral tab-tear drag-preview window |
| Window state (size/maximized) restored on relaunch | ❌ | A new window always opens at a computed placement, never a remembered one |
| Multiple monitors, HiDPI, touch, IME input | ➖ | Chromium's own default support applies |

### New tab page and start-up

| Feature | Orivon | Note |
|---|---|---|
| Custom new-tab page | ✅ | A dashboard replacing `about:blank` (`src/renderer/newtab/`) |
| Homepage setting | ❌ | No homepage URL setting |
| Startup pages ("open these pages") | ❌ | Not found |
| Continue where you left off | ❌ | No session-restore machinery |
| First-launch welcome/intro screen | ✅ | Shown once per profile (`intro-view.ts`, `intro-state.ts`) |
| White flash avoided on window open, new tab, internal pages and popovers | ✅ | Every such view's `backgroundColor`/theme colour is set before it has a pixel to show (`theme-colors.ts`, `popover-view.ts`); the main menu's own view is kept built between opens rather than recreated |

### Bookmarks

| Feature | Orivon | Note |
|---|---|---|
| Bookmarks bar | ✅ | `appearance.bookmarksBar` (`auto`/`always`/`never`) |
| Bookmark manager page | ❌ | No `orivon://bookmarks` |
| Folders | ❌ | A flat `{url, title, favicon}` record |
| Import/export as HTML | ❌ | Storage is a private JSON file, no HTML import/export |
| Bookmark all open tabs | ❌ | Not found |
| Reading list | ❌ | Not found |
| Star/unstar current page | ✅ | `bookmark.toggle` (`Mod+D`) |

### History

| Feature | Orivon | Note |
|---|---|---|
| History page | ✅ | `orivon://history` |
| Search history | ✅ | `history-domain.ts` |
| Delete individual entries | ✅ | `history-domain.ts` |
| Clear by range (hour/day/week/all) | ✅ | `clear-data.ts`'s `HISTORY_RANGES` |
| Retention setting | ✅ | 7/30/90/forever, on/off toggle |
| "Journeys" / grouped browsing sessions | ❌ | History is a flat, searchable list |
| Favicons shown in history / sortable columns | ❌ | Open item (`docs/open-questions.md` A294) |
| Updates live when history changes | ✅ | `services.history.onChange` pushes `history.changed`/`privacy.changed` to the open page (`start-internal-pages.ts`) |

### Downloads

| Feature | Orivon | Note |
|---|---|---|
| Download manager UI | ❌ | No `orivon://downloads` page or download-tracking store |
| Download progress | ❌ | Not found |
| Pause / resume / cancel | ❌ | Not found |
| Open containing folder | ❌ | Not found |
| Ask where to save each file | ❌ | Not found |
| Default download folder setting | ❌ | Not found |
| Dangerous-file warnings | ❌ | Not found |
| Safe Browsing check on downloads | ❌ | Not found |
| Downloads from ordinary browsing tabs | ➖ | No `will-download` handler on the default session; Electron's own default applies |

### Passwords and identity

| Feature | Orivon | Note |
|---|---|---|
| Password manager | ❌ | No password-store code |
| Save-password prompt | ❌ | Not found |
| Password autofill | ❌ | Not found |
| Password generator | ❌ | Not found |
| Breach/leak check | ❌ | Not found |
| Passkeys / WebAuthn | ❌ | No WebAuthn wiring; Electron/Chromium's own default may still apply, unadded to |
| Platform authenticator (Windows Hello/Touch ID) | ❌ | Not found |
| Security keys (FIDO2/U2F) | ❌ | Not found |
| FedCM | ❌ | Not found |
| Google account sign-in (on any site) | ⚠️ | Google's sign-in hosts are shown a Firefox identity (`src/main/shell/sign-in-identity-headers.ts`); not yet confirmed against a real account, and a sign-in page in another site's iframe is not covered |
| Basic-auth (HTTP 401) dialog | ⚠️ | No `app.on('login', ...)` handler; whatever Electron does unhandled applies, unverified without a launch |
| Client certificate picker | ❌ | No `select-client-certificate` handler; `certificate-check.ts` pins Orivon's own verifier certificate only |
| Sign-in / account sync | ➖ | Explicit non-goal: no sync, no Orivon-operated server for user data |
| Origin-bound app identity (`orivon.id`) | ✅ | Orivon's own substitute: a derived signing key per app origin, held in the OS keyring |

### Autofill

| Feature | Orivon | Note |
|---|---|---|
| Address autofill | ❌ | Not found |
| Payment card autofill | ❌ | Not found |
| Generic form-field autofill/memory | ❌ | Not found |
| Form validation bubbles, native `<select>`/date/color pickers | ➖ | Chromium's own default applies |

### Sync across devices

| Feature | Orivon | Note |
|---|---|---|
| Bookmarks/history/settings sync | ➖ | Explicit non-goal |

### Import from other browsers

| Feature | Orivon | Note |
|---|---|---|
| Import bookmarks/history/passwords from Chrome/Firefox/etc. | ❌ | No importer code |

### Privacy and security

| Feature | Orivon | Note |
|---|---|---|
| Clear browsing data dialog | ✅ | History range, site data, cache, zoom, per-app data (`clear-data.ts`) |
| Cookie controls (block third-party, etc.) | ❌ | No cookie-specific setting; clearing is all-or-nothing |
| Third-party cookie blocking | ❌ | Not found |
| Tracking protection / ad blocking | ❌ | Not built in; reachable only via a content-blocking extension |
| Fingerprinting protection | ❌ | Beyond the generic per-origin isolation the capability model gives apps |
| Do Not Track / Global Privacy Control | ❌ | Not found |
| Safe Browsing / phishing & malware warnings | ❌ | Not found |
| HTTPS-only / upgrade mode | ⚠️ | No general toggle, but apps and `.eth`/`ipfs://` origins are already served only over `https:` by construction |
| Mixed-content blocking | ➖ | Chromium's own default applies |
| Secure DNS / DoH (general browsing) | ❌ | `.eth` resolution uses fixed DoH resolvers internally; not a general per-site setting |
| Certificate viewer | ❌ | `certificate-check.ts` pins Orivon's own verifier certificate, not a user-facing viewer |
| Certificate error interstitial | ➖ | Chromium's own default applies |
| Custom CA management | ❌ | Not found |
| HSTS | ❌ | Beyond Chromium's own built-in preload list |
| Site isolation | ➖ | Chromium's own default; also load-bearing to the capability model |
| Sandbox | ✅ | `sandbox: true, nodeIntegration: false` for every app tab |
| Proxy settings (user-configurable) | ❌ | The only proxy code checks whether the OS proxy interferes with the verifier's own fetches |

### Site settings and permissions

| Feature | Orivon | Note |
|---|---|---|
| Camera | ❌ | Denied on every page, no route to a yes |
| Microphone | ❌ | Same gate as camera |
| Location / geolocation | ❌ | Denied by default |
| Notifications | ✅ | Asked once per site, remembered, resettable (`ADR-0028`) |
| Clipboard write | ✅ | Allowed outright, bounded by transient activation (`ADR-0022`) |
| Clipboard read | ❌ | Denied on every page, no route to lift it |
| Clipboard image paste (into a page) | ➖ | An ordinary OS paste event, not routed through the permission gate |
| MIDI | ❌ | Denied |
| USB (WebUSB) | ❌ | Device-permission handler refuses unconditionally |
| Serial (Web Serial) | ❌ | Same device-permission denial |
| HID (WebHID) | ❌ | Same denial; also excluded by design for apps (`hid` is 🚫) |
| Bluetooth (Web Bluetooth) | ❌ | Same device-permission denial |
| Sensors (motion/orientation/ambient light) | ❌ | Denied |
| Pop-ups | ⚠️ | `window.open()` popups keeping `opener` are allowed and become a tab; no separate "block pop-ups" toggle |
| Redirects | ➖ | Chromium's own default navigation handling applies |
| Automatic downloads | ❌ | Not found |
| Protocol handlers (`registerProtocolHandler`) | ❌ | Not found; unrelated to the app-install manifest hint mechanism |
| File System Access, one file | ✅ | Allowed for a picked or dropped file, read or write (`ADR-0024`) |
| File System Access, a folder | ➖ | Refused by design on both handlers |
| Idle detection | ❌ | Denied |
| Window management (multi-screen) | ❌ | Denied |
| Storage access API (cross-site) | ❌ | Denied |
| Payment handlers | ❌ | Denied, no UI |
| JavaScript on/off per site | ❌ | Not found |
| Images on/off per site | ❌ | Not found |
| Sound per site | ❌ | Not found |
| Zoom per site | ✅ | Remembered per origin (`src/main/zoom/`) |
| Local fonts (Local Font Access API) | ❌ | Denied |
| Screen/window sharing (`getDisplayMedia`) | ❌ | Left unset (Electron's own default refusal) |
| Persistent storage (`navigator.storage.persist`) | ❌ | Denied |
| AR/VR (WebXR) | ❌ | Denied |
| Fullscreen (`requestFullscreen`) | ✅ | Allowed from a click on every page (`ADR-0025`) |
| Pointer lock | ✅ | Allowed, click-gated by Chromium (`ADR-0026`) |
| Keyboard lock | ✅ | Allowed in fullscreen only (`ADR-0026`) |

### Site data management

| Feature | Orivon | Note |
|---|---|---|
| View/delete cookies per site | ❌ | No per-site cookie inspector |
| View/delete storage/cache per site | ⚠️ | The site-info popover shows and clears a registered app's own usage; not for arbitrary websites |
| Storage usage display | ⚠️ | Per-app disk usage shown; no equivalent for ordinary websites |

### Page content tools

| Feature | Orivon | Note |
|---|---|---|
| Find in page | ❌ | No `findInPage`/`Ctrl+F` command |
| Zoom (page) | ✅ | `zoom.in`/`zoom.out`/`zoom.reset`, per-origin |
| Print / print preview | ❌ | No `webContents.print()` call |
| Save page as | ❌ | Not found |
| View source | ⚠️ | See Navigation, `view-source:` |
| Reader mode | ❌ | Not found |
| Translate | ❌ | Not found |
| Spellcheck | ⚠️ | Disabled only on Settings/History search boxes; ordinary page text uses Chromium's own default |
| Dictionary / look up word | ❌ | Not found |
| PDF viewer | ❌ | No PDFium wiring (`plugins: true` never set) |
| Image viewer | ➖ | Chromium's own default applies |
| Picture-in-picture | ❌ | Not found |
| Media controls / global media hub | ❌ | Not found |
| Casting (Chromecast/AirPlay) | ❌ | Not found |
| Screenshots / page capture | ⚠️ | Only used internally for the tab-tear drag preview, not user-facing |
| Text-to-speech / read aloud | ❌ | No "read aloud" UI; the page's own `speechSynthesis` call is ungated |
| Forced dark mode for light-only sites | ⚠️ | `appearance.theme` flips OS-level `prefers-color-scheme`; no forced repaint of a site with no dark styles |
| Page fonts / minimum font size | ❌ | Not found |
| Text encoding override | ❌ | Not found |
| Alert / confirm / prompt dialogs | ➖ | Chromium's own default applies |
| Pinch zoom, smooth scrolling, autoscroll (middle-click drag on a page) | ➖ | Chromium's own default applies to page content |
| Drag-and-drop of links/images/files into the page | ➖ | Chromium's own default applies |
| Network / DNS / certificate error pages ("can't be reached") | ➖ | Chromium's own built-in interstitials apply |
| "Aw, snap" crash page / sad-tab reload | ❌ | A crashed renderer is only logged to the console |
| `beforeunload` guard | ✅ | Asks Leave/Stay (`leave-page-prompt.ts`) |

### Context menus

| Feature | Orivon | Note |
|---|---|---|
| Link: open in new tab | ✅ | `context-menu.ts` |
| Link: open in new window | ❌ | Not a context-menu item (see Tabs for shift+click) |
| Link: open in private window | ❌ | Not found |
| Link: copy link address | ✅ | |
| Link: save link as | ❌ | Not found |
| Link: open in split view | ✅ | Orivon-specific addition |
| Image: open image in new tab | ❌ | Not found |
| Image: save image as | ❌ | Not found |
| Image: copy image | ✅ | |
| Image: copy image address | ❌ | Not found |
| Image: search image | ❌ | Not found |
| Selection: copy | ✅ | |
| Selection: search selected text | ❌ | Not found |
| Selection: translate selection | ❌ | Not found |
| Page: back/forward/reload in menu | ❌ | Only Reload; navigation otherwise via toolbar |
| Page: inspect element | ✅ | Opens DevTools at the clicked element |
| Cut/copy/paste/select all (editable fields) | ✅ | Plus the chrome's own edit menu |

### Web platform features that need the browser

| Feature | Orivon | Note |
|---|---|---|
| Notifications API | ✅ | See Site settings |
| Push API | ❌ | No push-service wiring; Electron ships no default push backend |
| Service workers | ➖ | Chromium's own default applies to ordinary web content; extension service workers are separate (Table 7) |
| Background sync | ❌ | Not found |
| Periodic background sync | ❌ | Not found |
| Badging API (`setAppBadge`) | ❌ | Not found |
| Web Share API | ❌ | No OS share-sheet implementation |
| Payment Request API | ❌ | Denied, no UI |
| `registerProtocolHandler` | ❌ | Not found |
| PWA install / standalone app windows | ❌ | Orivon's own "app" concept is unrelated to a `beforeinstallprompt` PWA path |
| File handlers (web app file associations) | ❌ | Not found |
| DRM / Widevine / EME | ❌ | No CDM wiring; the stock `electron` package ships without Widevine |
| Proprietary codecs (H.264/AAC/HEVC) | ⚠️ | Depends on the Electron build used; the stock package is commonly built without them |
| WebRTC | ➖ | Chromium's own default applies; media tracks depend on camera/microphone permission, denied by default |
| WebGL / WebGPU | ➖ | Chromium's own default GPU-accelerated rendering applies |
| WebXR | ❌ | Denied |
| Geolocation provider | ❌ | Denied; Electron ships no geolocation API key by default |
| Speech recognition | ❌ | Denied; also generally lacks a default backend without a Google API key |
| Speech synthesis | ➖ | Ungated; no browser-level UI uses it |
| Web Bluetooth / USB / Serial / HID | ❌ | Device-permission handler denies all four |
| Gamepad API | ➖ | Ungated; Chromium's own default applies |
| Screen Wake Lock API | ❌ | Denied |
| EyeDropper API | ➖ | Ungated; Chromium's own default applies |
| File System Access API (single file) | ✅ | See Site settings |
| Clipboard API | ⚠️ | Write allowed, read denied |

### Developer tools

| Feature | Orivon | Note |
|---|---|---|
| DevTools (console, elements, network, etc.) | ✅ | F12; asks once before opening on an app holding permissions |
| Console panel | ➖ | Part of Chromium's stock DevTools |
| Network panel | ➖ | Part of Chromium's stock DevTools |
| Task manager (Shift+Esc equivalent) | ❌ | No Orivon-specific task manager UI |
| `about:`/internal informational pages (version, gpu, net-internals, flags) | ❌ | Only `settings, history, profiles, private, extensions` exist |
| DevTools dock position setting | ✅ | Right/bottom/undocked |
| Per-tab DevTools toggle | ✅ | Browser-wide setting |

### Extensions and themes

| Feature | Orivon | Note |
|---|---|---|
| Install unpacked / `.crx` / `.zip` | ✅ | Table 7a |
| Install/update from the Chrome Web Store | ✅ | Table 7a |
| Content scripts (isolated + `"world": "MAIN"`, in frames/subframes) | ✅ | Table 7b |
| Service worker with core `chrome.*` APIs | ✅ | Table 7c |
| Toolbar button, badge, popup | ✅ | Table 7d |
| Options page | ✅ | Table 7b |
| Extension popup stays open, and closes only on focus loss, tab switch or navigation | ✅ | Table 7d |
| `chrome.offscreen`, `chrome.tabCapture`, `chrome.runtime.getContexts` | ✅ | Table 7c/7d; Volume Master captures a tab it was invoked on |
| `declarativeNetRequest` | ⚠️ | Present so extensions start; rules are not applied (Table 7c) |
| `webRequest` | ⚠️ | Present, never fires (Table 7c) |
| `sidePanel`, `userScripts` | ⚠️ | Present as no-ops (Table 7c) |
| Native messaging | 🚫 | Off by design: it would start desktop programs outside the broker |
| Extensions inside apps a person has granted permissions to | ✅ | Table 7d |
| Extensions in private windows | ❌ | Table 7d |
| Extensions without the Chromium sandbox | ❌ | Table 7d (`A289`) |
| Browser themes | ❌ | No theme-extension or theme-store support; only `appearance.theme` |

### Accessibility

| Feature | Orivon | Note |
|---|---|---|
| Screen reader support | ➖ | Manual, partial ARIA labelling on several controls, not a dedicated subsystem |
| Caret browsing | ❌ | Not found |
| High contrast mode | ❌ | Beyond the system light/dark theme choice |
| Live captions | ❌ | Not found |
| UI zoom (browser chrome zoom, not page zoom) | ❌ | `zoom.*` shortcuts affect page zoom only |
| Keyboard navigation of the chrome (Tab order, F6 pane-cycle) | ⚠️ | Tab elements carry `role="tab"`; no F6-style pane-cycling shortcut |
| Emoji picker (OS-level, e.g. Win+.) | ➖ | An OS-level input-method feature |

### Customisation

| Feature | Orivon | Note |
|---|---|---|
| Themes | ❌ | See Extensions and themes |
| Dark mode | ✅ | System/light/dark |
| Fonts | ❌ | No font-family or size setting |
| Toolbar customisation | ❌ | Not found |
| Keyboard shortcuts, remappable | ✅ | Full remapping UI |
| Gestures (mouse/trackpad) | ❌ | Not found |
| Side panel | ❌ | Not found (also absent for extensions) |
| Settings, History and Profiles update live, without a restart | ✅ | Confirmed across Apps, Privacy, Usage, Updates and Profiles settings, History and the Profiles page, including across separate profile processes (`grant-events.ts`, `start-internal-pages.ts`) |

### Updates, crash reporting, OS integration and misc

| Feature | Orivon | Note |
|---|---|---|
| Self-update check | ⚠️ | Asks GitHub once a day for a newer release; never installs anything |
| Automatic update installation | ❌ | The check above is informational only |
| Crash reporting | ❌ | No `crashReporter` usage; the Node-shim's own export is an explicit stub |
| Default-browser registration | ❌ | No `setAsDefaultProtocolClient` code |
| Open links from other apps (OS-level URL handling) | ❌ | `.eth`/`ipfs://`/`ipns://` are handled internally, but Orivon is not registered as the OS default for http/https |
| "Create shortcut" for a site/app | ❌ | Distinct from Orivon's own manifest-declared "app" concept |
| OS integration: handoff / share sheet | ❌ | Not found |
| Energy saver / performance mode | ❌ | Tab discarding is also absent |
| Telemetry, with opt-out and disclosure | ✅ | First-run disclosure and a "what was sent" page (`src/telemetry/`) |
| Languages / UI locale switcher | ❌ | No i18n/locale-switching code; UI strings are hard-coded English |
| Enterprise policy support | ❌ | Not found |
| Run from source, no compiler needed (Windows/macOS) | ✅ | Forces a no-native-modules policy on Orivon's own dependencies (Rule 8) |
| Linux packaging (AppImage/deb) | ⚠️ | Not yet done |
| External protocol links (`mailto:`, `magnet:`, `bitcoin:`, ...) | ✅ | Opened by the OS's default app only after a per-site, per-URL confirmation dialog (`ADR-0027`) |
| `beforeunload` guard | ✅ | See Page content tools |
| Right-click menu (chrome + page) | ✅ | See Context menus |
| Custom, non-Electron User-Agent string | ✅ | Every tab reports one plain Chrome UA, the same string everywhere; no per-host override for a specific sign-in flow |
