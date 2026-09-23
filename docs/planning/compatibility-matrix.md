# App compatibility matrix

**What is wired up right now, and the cheapest next lever.**
[`../architecture/app-compatibility.md`](../architecture/app-compatibility.md) owns *why the
tiers exist*; this file owns *what works today*. If they disagree, that one is the design and
this one is stale.

**Every live capability is complete Spec'd → Broker → Page, except `id.requestIdentity` and
`protocols`**, the two unbuilt entries. `hid` and `subprocess` are excluded from v0.

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
| `net.connect` (TCP out) | ✅ | ✅ | ✅ | ✅ | Both stream halves wired, e2e-verified. A `localhost:<port>` pattern reaches `127.0.0.1` and `::1` at that port, never resolving the name (A214). Node shape in [`node-net-socket.ts`](../../src/shim/node-net-socket.ts) |
| `net.connectSecure` (TLS out) | ✅ | ✅ | ✅ | ✅ | TLS terminated on the trusted side per [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md), under the app's own Node TLS options (trust anchors, `rejectUnauthorized`, client certificate, SNI, ALPN), with the handshake reported on the socket. Node's `tls` module and `https`/`http` clients sit on top. No STARTTLS (A225) |
| `net.udpBind` + send/recv | ✅ | ✅ | ✅ | ✅ | Node shape in [`node-dgram-socket.ts`](../../src/shim/node-dgram-socket.ts) |
| `net.listen` (TCP in) | ✅ | ✅ | ✅ | ✅ | Real accepted-socket handles, unsigned-app port rules and a revocation cascade. Each accepted socket's port is delivered over the server's own port (`AcceptedMessage`). Node shape in [`node-net-server.ts`](../../src/shim/node-net-server.ts): a real `net.Server`/`createServer`, which refuses a `.listen(port, host)` naming anything but every interface, because the capability always binds every interface |
| `fs.readFile` / `writeFile` | ✅ | ✅ | ✅ | ✅ | Confined to the app dir. The quota counts disk usage (A215). Node shape in [`node-fs.ts`](../../src/shim/node-fs.ts), where every Node-shaped path (cwd, homedir, tmpdir, `userData`) is rooted at the virtual `/orivon/app` |
| `fs.readFileSync` | ✅ | ✅ | ✅ | ✅ | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md), over `ipcRenderer.sendSync`. Grant check and path confinement are shared with the async path; **the per-origin in-flight budget is not** (A112). The shim maps its failures to Node errnos, and `existsSync` answers over it |
| `fs.mkdir` / `readdir` / `stat` / `rm` / `rename` | ✅ | ✅ | ✅ | ✅ | |
| `fs.open` (`FileHandle`) | ✅ | ✅ | ✅ | ✅ | Broker (`fs-capability.ts`'s `open`), dispatch and preload. Node shape (`node-fs-handle.ts`) is a Node-style cursor over the contract's explicit-position reads and writes, and `fs.createReadStream`/`createWriteStream` run over that same cursor. **One named limitation:** `readable()`/`writable()` are built in the broker but have no control-channel case and are not on `window.orivon` (A184), so a handle's own `FileHandle#createReadStream`/`createWriteStream` refuse loudly rather than fake a stream |
| `fs.userSelected` (picker) | ✅ | ✅ | ✅ | ➖ | **The only route outside the app dir**, in both shapes. A file resolves through `fs.open`'s handle-scoped methods; a folder resolves a `DirectoryHandle` whose nine members travel over eight `fs.dir*` control-channel methods, with `fs.dirOpen` routed through the same `registerFileHandle` mechanism `fs.open` uses. The picker choice IS the consent; a picked path persists and is revocable from the settings list beside that app's other permissions. **Provisional:** `DirectoryHandle`'s own method set is not yet confirmed (A167 item 2, A195) |
| `id.publicKey` / `sign` | ✅ | ✅ | ✅ | ➖ | Wired end to end, e2e-verified. P-256 ECDSA only; secp256k1/Schnorr is the separate A44 question |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | Unbuilt, and nothing blocks it. `src/nostr/nip07.ts`'s real wiring calls this and cannot reach a page until it exists (A111) |
| `app.manifest` / `grants` | ✅ | ✅ | ✅ | ➖ | Backs Electron's `app.*`; see Table 2 |
| `app.requestGrant` | ✅ | ✅ | ✅ | ➖ | A control-channel case in [`ipc.ts`](../../src/broker/transport/ipc.ts) turns a page's call into `ctx.requestGrant(origin, request)`; accepting the dialog persists a real grant a later capability call uses, e2e-verified with refusal included. An origin must be registered as an app first, which is where install-time consent asks once for the whole declared set before the app's own code runs. A first-ever visit can still see an early call denied before that dialog resolves (A146, accepted as a known limitation) |
| `web.context` (`orivon.web.openContext`) | ✅ | ✅ | ✅ | ➖ | An isolated, never-displayed document at an origin the manifest names exactly, and `evaluate` to run one script in it. No `orivon.*`, no preload, no cookies, and **no network of its own**: every request it makes is authorised against the *opening app's* own `https.connect` grant. Bounded by `LIMITS.webContexts`. The one capability a page cannot substitute for, because a web page cannot host a document at another site's origin -- an iframe there is that site's document, not the app's. Broker in [`web-capability.ts`](../../src/broker/web-capability.ts), page surface in [`web-surface.ts`](../../src/preload/web-surface.ts), e2e in [`e2e-web-context.test.ts`](../../test/e2e-web-context.test.ts) and [`e2e-web-context-network.test.ts`](../../test/e2e-web-context-network.test.ts). **Provisional:** [ADR-0019](../decisions/ADR-0019-an-app-may-run-code-at-an-origin-the-user-named.md) is still `proposed`; owner acceptance settles it |
| `dns.lookup` (`orivon.net.lookup`) | ✅ | ✅ | ✅ | ✅ | The capability is `OrivonNet.lookup`; there is no separate `orivon.dns` namespace, and `dns.lookup` is the Node API it backs. Bounded by the host portions of the origin's held `tcp.connect` and `udp.send` patterns; `https.connect` does not authorise a lookup. Node shape in [`node-dns.ts`](../../src/shim/node-dns.ts) resolves `dns.lookup`/`dns.promises.lookup`, answering an IP literal and `localhost` itself with no capability call; every other `dns.*` member is a named refusal |
| `protocols` (scheme routing) | ✅ | ❌ | ❌ | ➖ | Declared in the manifest and validated by the loader ([`manifest-capabilities.ts`](../../src/loader/manifest-capabilities.ts)), but **not a `CapabilityKind`** ([`manifest-patterns.ts`](../../src/broker/policy/manifest-patterns.ts)) and unimplemented on both sides: nothing registers a scheme with the shell, and how a routed URI would reach the app is unspecified |
| `hid` / USB | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 for every tier |
| `subprocess` | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 as largest attack surface |

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
| **Node stdlib** | `net`, `dgram`, `fs`, `http`, `https`, `tls`, `Buffer`, `stream`... | `net.*`, `fs.*` | ✅ built: `net` (client and server), `dgram` and `fs` (including `FileHandle` and `fs` streams) over the capabilities, `tls` and Node's `http`/`https` clients over `net.connectSecure`, `dns.lookup` over `orivon.net.lookup`, the eight core polyfill packages, and hand-written `url`, `querystring`, `string_decoder`, `timers` and `assert`, each also under its `node:` name and subpaths. **Named refusals, by design:** `net.Server#listen` on a loopback-only host (A224), `FileHandle#createReadStream`/`createWriteStream` (A184), `tls` STARTTLS and a prebuilt `secureContext` (A225), `http.createServer` (A227), and every other `dns.*`/`net.*` member this shim has not decided on |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog` | `app.*`, `fs.userSelected` | ⚠️ partial, in [`src/shim-electron/`](../../src/shim-electron/) |
| **Web ecosystem** | `window.nostr` (NIP-07); later `window.ethereum` | `id.*` | ✅ built ([`nip07.ts`](../../src/nostr/nip07.ts)), not wired into a page: it needs `id.requestIdentity` (A111) |
| **The app's own preload surface** | whatever that app's preload exposed -- `window.ftElectron` for FreeTube | any capability its calls happen to map to | ➖ **Not Orivon's to ship.** One file per ported app, living with the app |

**The `electron` family** lives in its own package rather than folded into `src/shim/`:
`app`, `dialog`, `ipcRenderer`/`ipcMain` and `BrowserWindow`/`Menu`/`Tray`, reconstructed or
explicitly refused on top of `orivon.*`. A refusal and a gap are not the same cell:

| Electron API | What backs it | This package |
|---|---|---|
| `app.getPath('userData')` | the app's own confined `fs` root | `app.ts`, built |
| `app.getVersion()` | `orivon.app.manifest()` | `app.ts`, built |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` | `dialog.ts`: **refuses, as `'not-built'`, on a shape mismatch.** `showOpenDialog` returns raw host paths (`filePaths: string[]`), while `userSelected` resolves an opaque handle and deliberately never exposes a host path to app code (A187) |
| `ipcRenderer.invoke` / `ipcMain.handle`, `.on`/`.send` | a local in-sandbox message bus, no broker round-trip | `ipc.ts`, built |
| `BrowserWindow`, `Menu`, `Tray` | nothing; desktop-shell surface | `desktop-shell.ts`, refuses by design, tested |

## Table 3: the runtime environment (ability)

**What the app is capable of doing in the browser environment.** The capability-backed part is
the small part. [`src/shim/`](../../src/shim/) holds `globals.ts`, `module-map.ts`, a
hand-written `node-util.ts` and the Node shapes, and [its README](../../src/shim/README.md) names
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
| `process`, `global`, `nextTick`, `setImmediate` | `dup` | everything | ✅ built | `shim/globals.ts`, installed on a registered app tab's window before its own scripts run. `process` answers what libraries read without claiming to be Node (A222); `setImmediate` is a `MessageChannel` task, free of timer clamping; an uncaught callback error reaches the page's own `reportError` |
| `util` | `dup` | nearly every dependency tree (`inherits`, `promisify`, `inspect`, `types`) | ✅ built | The `util` package, with [`node-util.ts`](../../src/shim/node-util.ts) replacing what the package gets wrong or predates: `promisify`'s registry symbol, `inherits`, `isDeepStrictEqual`, `TextEncoder`/`TextDecoder` |
| `Buffer`, `stream`, `events`, `path`, `os`, `crypto`, `zlib` | `dup` | everything | ✅ built | All eight core polyfill packages are installed, deliberately wider than the five with a confirmed caller, so a ported app does not stall on a missing module ([`shim-dependency-review.md`](shim-dependency-review.md)). `Buffer` is also a page global in registered app tabs (not workers or subframes), the same class `require('buffer')` returns. `zlib` has no brotli (A208) |
| `url`, `querystring`, `string_decoder`, `timers`, `assert` | `dup` | ported apps' dependency trees | ✅ built | Hand-written in `src/shim/`. Every mapped module also resolves under its `node:` name, and `fs/promises`, `stream/promises`, `path/posix`, `util/types`, `dns/promises` and `timers/promises` are rows of [`module-map.ts`](../../src/shim/module-map.ts) of their own |
| `net` / `dgram` / `fs` Node shapes | `dup` | every ported app | ✅ built, client and server | `net.connect`, `dgram`, `fs` (async and sync), `net.createServer`/`net.Server` and `fs.open`/`FileHandle` present real Node shapes over the capabilities, with Node's `errno`, `syscall` and codes on their errors, and `fs.createReadStream`/`createWriteStream` over the shim's own cursor. Two narrow, named refusals: `net.Server#listen` on a loopback-only host (A224), and `FileHandle#createReadStream`/`createWriteStream` (A184, no page-reachable byte stream underneath). UDP and the TCP server are IPv4-only (A217) |
| Synchronous `fs` (`readFileSync`, `existsSync`) | **`needs T1`** | ported apps, at startup | ✅ built | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md), over `ipcRenderer.sendSync`; `existsSync` answers over the same call. Design rule 2 narrows to network operations only. One filed gap: the sync path does not share the async path's per-origin fairness budget (A112) |
| `electron` module | `dup` | every tier-2 app | ⚠️ partial | [`src/shim-electron/`](../../src/shim-electron/): `app.*`/`ipcRenderer`/`ipcMain` work, `BrowserWindow`/`Menu`/`Tray` refuse by design, and `dialog.showOpenDialog` refuses on the host-path/opaque-handle mismatch (A187) |
| HTTP client | `dup` | trackers, web seeds, any REST | ✅ built | The page's own `fetch()`, `XMLHttpRequest` and `EventSource` are routed through the capability for granted hosts ([`fetch-route.ts`](../../src/preload/fetch-route.ts), [`xhr-route.ts`](../../src/preload/xhr-route.ts), [`eventsource-route.ts`](../../src/preload/eventsource-route.ts)): redirects followed, responses streamed, requests queued at the socket allowance. A host the app was not granted takes the native API, CORS and all. Node's `http`/`https` clients sit on the same capability, with timeouts, abort signals, `Agent`, and `upgrade` and 1xx events. Neither webtorrent nor bittorrent-tracker uses Node's HTTP client (the tracker client calls `fetch`), and FreeTube is 32 `fetch` calls with zero Node builtins, so **routed `fetch` is the path both flagship candidates actually take**. Divergences from a browser are listed in [`src/preload/README.md`](../../src/preload/README.md); no keep-alive (A207) |
| WebSocket client | `dup` | dapps, wallets (RPC subscriptions, price feeds, WalletConnect relays) | ✅ built | The page's own `WebSocket` is routed for granted hosts ([`websocket-route.ts`](../../src/preload/websocket-route.ts)): `wss:` over the secure-connect capability, `ws:` over TCP connect, an RFC 6455 client in the page, no `permessage-deflate`. An ungranted host keeps the native socket, which the served CSP refuses for any third-party host; workers and iframes keep the native socket (A210). A routed socket holds a socket-allowance slot while it is open (A239) |
| TLS / `https` | **`needs T1`** | nearly every app | ✅ built | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md); `net.connectSecure` in the broker, wired through IPC to a real page. Orivon terminates the handshake on the trusted side, so a grant and a prompt can name the true hostname. Node's `tls` module is built over it and honours `ca`, `rejectUnauthorized`, `cert`/`key`/`pfx`, `servername`, ALPN and a custom `checkServerIdentity`; an option that unbinds the certificate from the host adds the resolve-once address check; STARTTLS cannot work (A225) |
| Unmapped Node builtins: `child_process`, `vm` | `dup` | ported apps, and their dependency trees | ❌ missing | Absent from [`module-map.ts`](../../src/shim/module-map.ts), so the renderer build fails to resolve the specifier. That is a build error, not the named refusal `refusingProxy` gives an unmapped member *inside* a mapped module. `child_process` is the one that is a refusal rather than a gap (Table 1, `subprocess`) |
| The app's own preload surface (`window.<name>`) | `dup` | every app ported from Electron | ➖ per-app | Table 2's fourth family. Not in `src/` at all, and not in this repository: one file per app, in `orivon-ports` |
| `worker_threads` | `dup` | validation-heavy work | ❌ missing | Web Workers are already in the renderer, so the substrate exists and no Table 1 entry is needed; the shape does not match and a shim cannot fully fake it. A fidelity problem, not a substrate one |
| Background lifetime | **`outside`** | seeding, syncing, pinning | ⚠️ **unspecified** | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Shell holds the process, contracts describe it, UI shows it. `mvp-scope.md` counts `backgroundSec` in the metric but nothing grants it. An app tab that is not the active one is hidden, and keeps Chromium's default throttling of hidden pages |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount. `src/shim-electron/app.ts`'s `getPath` enforces the identical boundary for any name but `'userData'` |
| Desktop shell (tray, autostart, protocol handlers, hotkeys) | **`outside`** | Electron apps' outer half | ⚠️ partial | `BrowserWindow`/`Menu`/`Tray` are explicit, tested named refusals (`src/shim-electron/desktop-shell.ts`); autostart, protocol handlers and hotkeys are simply absent |
| Secure context (`crypto.subtle`, `crypto.randomUUID`, service workers, `navigator.clipboard`) | **`outside`** | any app using WebCrypto or the async Clipboard API | ✅ on every path | An INSTALLED app's origin is really `https:` ([ADR-0007](../decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md)) and `127.0.0.1` is trustworthy by Chromium's own host rule, so both were always secure. The dev `.eth` path is plain `http:` on a non-loopback host, which Chromium does not trust however the name resolves; [`eth-resolver.ts`](../../src/main/dev/eth-resolver.ts) declares the mapped names secure so the same bundle behaves the same way under either entry URL. Dev-mode only, and only for names the resolver also mapped to loopback |
| Clipboard write (`navigator.clipboard.writeText`) | **`outside`** | any app with a copy button | ✅ built | Allowed for every page by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0022](../decisions/ADR-0022-the-permission-gate-allows-clipboard-write.md)), bounded by the web platform's own transient-activation and document-focus rules rather than by a grant. Not a `CapabilityKind`: nothing is declared in a manifest and nothing appears in the permissions panel |
| Clipboard read (`readText`, `deprecated-sync-clipboard-read`) | **`outside`** | reading what the person copied elsewhere | 🚫 excluded by design | Denied on both handlers. A refusal, not a gap: it would hand a page whatever was last copied anywhere on the machine. Whether it ever becomes a real capability is [A202](../open-questions.md) |
| File System Access, one file (`showOpenFilePicker`, `showSaveFilePicker`, a dropped file) | **`outside`** | any app that imports or exports a file | ✅ built | Allowed by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0024](../decisions/ADR-0024-the-permission-gate-allows-one-chosen-file.md)) for a single file the person picked or dropped, to read or to write. The person's choice of file is the consent, as for `fs.userSelected`. Not a `CapabilityKind`. Writing back to an opened file and reusing a stored handle go without the prompt Chrome shows ([A205](../open-questions.md)) |
| File System Access, a folder (`showDirectoryPicker`, a dropped folder) | **`outside`** | web IDEs, photo organisers | 🚫 excluded by design | Refused on both handlers: a directory handle reaches every file beneath it, and Electron decides this synchronously, so there is no point at which to ask. An app written for Orivon has `fs.userSelected`'s folder shape instead. Whether a folder prompt is ever built is [A205](../open-questions.md) |
| HTML fullscreen (`requestFullscreen`) | **`outside`** | video players, games | ✅ built | Allowed on every page from a click by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0025](../decisions/ADR-0025-the-permission-gate-allows-html-fullscreen.md)). The tab fills the window with the chrome hidden, "Press Esc to exit full screen" shows for four seconds, and Escape always leaves. Not a `CapabilityKind` |
| Pointer lock (`requestPointerLock`) | **`outside`** | games, 3D viewers, remote desktops | ✅ built | Allowed on every page by [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts) ([ADR-0026](../decisions/ADR-0026-the-permission-gate-allows-pointer-and-keyboard-lock.md)); Chromium still requires a click. Escape releases it, and "Press Esc to show your cursor" says so |
| Keyboard lock (`navigator.keyboard.lock`) | **`outside`** | fullscreen games, remote desktops | ✅ built | Allowed on every page ([ADR-0026](../decisions/ADR-0026-the-permission-gate-allows-pointer-and-keyboard-lock.md)); it acts only in fullscreen. A page holding Escape gets a single press, holding Escape leaves fullscreen, and "Press and hold Esc to exit full screen" says so |
| External protocol links (`mailto:`, `magnet:`, `bitcoin:`, ...) | **`outside`** | mail, torrent and payment links | ✅ built | Opened by the OS's default app only after the person allows it in a dialog naming the site and the URL, every time ([ADR-0027](../decisions/ADR-0027-an-external-link-opens-only-when-the-person-allows-it.md)). The browser's own schemes and known-dangerous OS handlers are never offered |
| Notifications (`Notification.requestPermission`) | **`outside`** | chat, mail, transaction alerts | ✅ built | The site is asked once; Allow and Block are remembered per site and can be reset from the permissions panel ([ADR-0028](../decisions/ADR-0028-a-site-shows-notifications-only-after-the-person-allows-it.md)). An undecided site reads `Notification.permission === 'denied'`, measured (A242) |
| `window.open()` popups that keep `window.opener` | **`outside`** | OAuth and wallet sign-in | ✅ built | A popup the page can talk to becomes a tab in its opener's session ([`popups.ts`](../../src/main/shell/popups.ts)); `noopener` and links open ordinary tabs; a `blob:` URL the page minted opens; a popup into an isolated app opens in that app's own session. An open-web popup an app opens runs in the app's partition until its opener closes (A229) |
| `beforeunload` guard | **`outside`** | editors, forms with unsaved work | ✅ built | Asks Leave or Stay. The question blocks the main process while it is open, and closing a tab does not ask (A230) |
| User-Agent | **`outside`** | sites and sign-in pages that check for Chrome | ✅ built | Every tab reports a plain Chrome User-Agent, with no `Electron/` or `orivon/` token |
| Right-click menu | **`outside`** | copy, paste, open a link | ✅ built | In tabs and the address bar ([`context-menu.ts`](../../src/main/shell/context-menu.ts)) |
| `prompt()` | **`outside`** | apps that ask for text this way | ❌ missing | Returns `null` at once: Electron draws no prompt dialog and offers no hook to supply one (A231) |
| Code made at run time (`eval`, `new Function`, WebAssembly), `data:`/`blob:` URLs, blob workers and frames | **`outside`** | ajv, protobufjs, template compilers, wasm libraries, MSE video | ✅ built | An installed or dev-granted app's served CSP carries `'unsafe-eval'` and `'wasm-unsafe-eval'`, admits `data:`/`blob:` in `connect-src`, `img-src`, `font-src` and `media-src`, and sets `worker-src 'self' blob:` and `frame-src 'self' data: blob:`. A `*` `https.connect` grant admits any https subresource, each one re-authorised by the app's own handler ([`src/loader/README.md`](../../src/loader/README.md)) |
| Installing a real built frontend (static-host redirects, extra manifest fields, large assets, client-side routes) | **`outside`** | every installed app | ✅ built | The loader follows a host's same-origin redirects (`/index.html` to `/`), ignores an unknown top-level manifest field such as `$schema`, `description`, `icons` or `homepage` with a warning, and takes assets up to 64 MiB in bundles up to 512 MiB, streamed to and from disk in constant memory, Range requests included. Reloading a client-side route serves the entry document. An unchanged app costs one conditional manifest request (a 304) an hour, and the interval survives a restart (A235). A capability revoked in Settings is not asked for again at the next launch, and the app can still request it |
| Native addon in the dep tree | **`outside`** | see Table 5 | ❌ missing | Per-library substitution, not a platform feature. Pure-JS/WASM substitute, or a helper process |

## Table 4: open blockers, and the cheapest lever for each

Ordered by reach per unit of effort. **The ordering is a recommendation, not a schedule.** Only
open blockers are listed; a resolved one is deleted, not struck through.

| # | Blocker | Cheapest lever | Cost shape |
|---|---|---|---|
| 1 | No named identities: `id.requestIdentity` is unbuilt, so `window.nostr` cannot reach a page | Build it; no decision blocks it | A111 |
| 2 | `DirectoryHandle`'s method set is unconfirmed | Confirm the shape the folder picker is already built against; no new build work | A167 item 2, A195 |
| 3 | `child_process`, `vm` and `worker_threads` are unmapped, so importing one fails the renderer build on the specifier, not with a named refusal | A `module-map.ts` row each that refuses by name, so the build succeeds and the call fails loudly; a real `worker_threads` shape over Web Workers only once an app needs it, and `child_process` stays a refusal (Table 1, `subprocess`) | Shim work, one file |
| 4 | `dialog.showOpenDialog` cannot map onto `fs.userSelected`: one returns host paths, the other an opaque handle | A shim-side shape decision | A187 |
| 5 | `FileHandle.readable()`/`writable()` are not page-reachable, so a handle's own `FileHandle#createReadStream`/`createWriteStream` refuse (the module-level `fs` streams work) | Deliver a byte stream over a dedicated port, the mechanism `net.connect` already uses | A184 |
| 6 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly |
| 7 | `protocols` is declared and validated but unbuilt on both sides | Unfiled; needs a decision first on how a routed URI reaches the app | Contracts + shell + prompt UX |
| 8 | `hid`/USB, the wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 9 | Native addons in dep trees | Substitute per library, Table 5 | Per-app, not per-platform |
| 10 | Tier 3, no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |
| 11 | App logic is not JavaScript | Nothing works today, WASM included | Blocked upstream: Go has no wasip2, wasi-sdk has no target with threads AND sockets |

Rows 1 to 3 are the top of the list: none needs anything but the work itself or one
confirmation. Row 6 sits behind them despite touching the metric, because it needs
a decision before it is even build-shaped. **Unfiled:** rows 6, 7 and 9, plus declarability (what a grant
prompt can honestly say for runtime-chosen hosts) and per-syscall IPC cost on a chatty workload.

## Table 5: the native-module question, per library

*Could native binaries be preinstalled, bypassing Rule 8, to reach these?*

**The mechanical answer first.** App code runs with `sandbox: true, nodeIntegration: false`. A
preinstalled native module lives in *Orivon's* process, not the app's, and no page can `require` it
under any Rule 8 policy. Reaching one means giving it an `orivon.*` capability, so the cost lands
on [`src/contracts/`](../../src/contracts/), the artefact `ADR-0002` says is expensive to get
wrong, not on the build toolchain.

| Library | Why an app wants it | Renderer answer that exists today | Verdict |
|---|---|---|---|
| `better-sqlite3` | local relational store | `sql.js` / `wa-sqlite` (WASM SQLite) over `orivon.fs`, or IndexedDB | ✅ No capability needed. Slower; irrelevant at MVP scale |
| `leveldown` / `classic-level` | key-value store | `browser-level` (IndexedDB), `memory-level`; the level ecosystem ships browser backends by design | ✅ No capability needed |
| `secp256k1` bindings | ECDSA / Schnorr | `@noble/secp256k1`, pure JS and audited; plus `orivon.id.sign` for the user's key | ✅ No capability needed. ~10x slower, still thousands of ops/sec |
| `node-datachannel` | WebRTC inside Node | the renderer has real `RTCPeerConnection` | ✅ Evaporates. `check-no-native-modules.mjs` names this exact chain as the threat; in a renderer it isn't one |
| `node-usb` / `node-hid` | hardware wallets | nothing; it is physical device access | ❗ **Genuine.** But Rule 8 was never the blocker: it needs `orivon.hid.*`, a device chooser and a grant, which cost the same either way |

**What the question is really pointing at is a real gap:** the missing thing is not permission
to compile C++, it is **a place to run non-renderer code**. `ADR-0005` dissolved the "app
backend", so all app code is renderer JS. Preinstalled natives only pay off once something can
load them on an app's behalf: `subprocess`, or the container path. Both post-MVP.

## Table 6: how to update this

Check the code, do not trust the tables above.

| Cell | Recipe |
|---|---|
| Table 1, Spec'd | Read [`capability-api.ts`](../../src/contracts/capability-api.ts). A PROVISIONAL doc comment means ⚠️, not ✅ |
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker`: a function that exists but isn't returned is not reachable. The broker is split: `net`'s five entry points (`connect`/`connectSecure`/`udpBind`/`listen`/`lookup`) live in `net-capability.ts`, `fs`'s nine (including `open`) in `fs-capability.ts`, and `id`'s two in `id-capability.ts`, each returned from its own factory and re-exported through `createBroker`'s own returned object, so check those files too, not just `index.ts` |
| Table 1, Page | `grep -n "call('" src/preload/orivon-surface.ts`, plus `src/preload/main-world-socket.ts` for what the main-world wrapper builds. A real-Electron e2e test is the strongest proof a real page can call it; where none exists, a test exercising the real `installOrivon` wiring rather than a hand-built stub is the fallback: weaker, but still a real dispatch/preload path, not just a file that exists |
| Table 1, Node shim | `ls src/shim/` |
| Table 2 | Node family: `src/shim/`. Electron family: `src/shim-electron/`. Web family: `src/nostr/`. Fourth family: not in this repository at all -- it is each app's own bridge, one file per app in `orivon-ports`, and a missing one is that app's gap, never Orivon's |
| Table 3, Status | Mostly absence; verify by looking for the module, not for a mention of it |
| Table 3, Class | Not observable in the tree; derived. `dup` if Table 2's families name the surface at all, `needs T1` if they do but Table 1 has no entry the adapter could be built on, `outside` if no Node/`electron`/web API expresses the problem. Re-derive the row when Table 1 or the shim README's declared scope changes, not when a status flips |
| Table 4 | When a blocker is resolved, **delete the row**. This table lists only what is still open |
| Every cell | **State the current state and nothing else.** No "what changed since the last derivation", no "moved from ❌ to ✅", no PR numbers, no struck-through rows, no "this pass". A reader needs to know what works now; what changed and when is git history and [`../decisions/decision-log.md`](../decisions/decision-log.md) |

**Do not let this grow into a second copy of `app-compatibility.md`.** If an entry starts
explaining *why a tier exists*, it belongs there.
