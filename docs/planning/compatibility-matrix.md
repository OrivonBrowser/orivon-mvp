# App compatibility matrix

**What is wired up right now, and the cheapest next lever.** Derived 2026-09-16 by reading the
tree at `1352a57`, after seven merged PRs (#199-#205) built `net.listen`'s page half,
`fs.open`, `orivon.net.lookup` (the capability `dns.lookup` shims onto) and their Node shapes.
[`../architecture/app-compatibility.md`](../architecture/app-compatibility.md) owns *why the
tiers exist*; this file owns *what works today*. If they disagree, that one is the design and
this one is stale.

**What changed since the last derivation (2026-09-13, `e84940c`), cell by cell** -- re-derived
from the tree itself, not from the seven PRs' own bodies (this document's standing recipe,
Table 6, and A151's lesson: a module that exists is not the same fact as a module a page can
actually reach):

- **`net.listen` moves ✅✅❌❌ -> ✅✅✅✅.** A114 (the nested-port delivery shape a page needs to
  receive `TcpServer.connections`) is resolved: `d-0028` chose `AcceptedMessage`, a new
  `BrokerToRendererMessage` member (`src/contracts/ipc.ts`) delivered over the server's own port
  (#199, contracts), and `src/broker/transport/accept-pump.ts` plus `src/preload/server-port.ts`
  and `src/preload/main-world-socket.ts`'s `buildServer` wire it end to end (#203). Verified
  against the tree: `dispatch-net.ts` has a real `'net.listen'` control-channel case,
  `net-surface.ts`'s `netListenBridge` and `main-world-socket.ts`'s `listen` closure both exist
  and are exercised by `main-world-socket-listen.test.ts` and `orivon-surface.test.ts` against
  the real `installOrivon` wiring, not a hand-built stub. The Node shape (`node-net-server.ts`,
  #205) is a real `net.Server`/`createServer`, wired into `module-map.ts`'s `'net'` entry (not
  just present as a file -- confirmed `status: 'ready'`). **Two things stay refused, by design,
  not by gap:** a `.listen(port, host, ...)` call naming anything but "every interface" throws
  a named error, because `orivon.net.listen` itself has no host parameter and binding narrower
  than the broker actually binds would be a silent, security-relevant lie. No real-Electron e2e
  test exercises this specific capability yet (unlike `net.connect`'s); the proof today is the
  real preload-wiring unit tests named above, one layer short of a full launch.
- **`fs.open` (`FileHandle`) moves ✅❌❌❌ -> ✅✅✅✅.** The broker capability
  (`src/broker/fs-capability.ts`'s `open`), its control-channel dispatch (`dispatch-fs.ts`'s
  `'fs.open'` case and its handle-scoped siblings `fs.read`/`write`/`fstat`/`truncate`/`sync`/
  `close`) and the preload surface (`orivon-surface.ts`'s `fsOpen`,
  `main-world-socket.ts`'s `buildFile`) all landed in #204. The Node shape
  (`node-fs-handle.ts`, #205) reconstructs Node's implicit `position: null` cursor on top of the
  contract's explicit-position-only reads/writes, wired into `module-map.ts`'s `'fs'` entry.
  **One deliberate limitation, not silently folded into the ✅ above:** `FileHandle.readable()`/
  `writable()` are built in the broker (`fs-capability.ts`'s `toFailableFileHandle`) but have
  **no control-channel case** in `dispatch-fs.ts` and are not on `window.orivon` -- A184,
  filed by the lane that found it. `node-fs-handle.ts`'s `createReadStream`/`createWriteStream`
  refuse loudly, citing A184, rather than returning a stream that can never move a byte. This is
  the correct, honest shape for a partial landing, not a bug.
- **`orivon.net.lookup` (the capability the `dns.lookup` row names) moves ❌❌❌⚠️ -> ✅✅✅✅.**
  It was not spec'd at all until this run: `d-0030` added `OrivonNet.lookup` to
  `src/contracts/capability-api.ts` in #199. **It lives on `OrivonNet`, not a separate
  `orivon.dns` namespace** -- this table's row is named `dns.lookup` because that is the Node
  API it backs, and the row below is renamed to say so. The broker (`net-capability.ts`'s
  `lookup`, bounded by the union of the origin's held `tcp.connect`/`https.connect`/`udp.send`
  patterns per `d-0030`'s reading -- see A171, still an AI recommendation the owner has not yet
  confirmed), its dispatch (`dispatch-net.ts`'s `'net.lookup'` case) and its preload surface
  (`net-surface.ts`'s `netLookupBridge`) landed in #201. The Node shape (`node-dns.ts`, #205)
  fully resolves `dns.lookup`/`dns.promises.lookup` now, wired into `module-map.ts`'s `'dns'`
  entry -- **the old ⚠️-in-the-shim-column exception ("the shim entry exists to refuse, not to
  work") is closed**; the shim entry now works. `dns.resolve4`/`reverse`/`setServers`/... and
  every other `dns.*` member are still named refusals, unchanged.
- **`fs.userSelected` (the folder picker) did NOT move: still ✅❌❌➖.** Verified directly against
  the tree, not assumed: no `'fs.userSelected'` case anywhere in `dispatch-fs.ts`, no
  `userSelected` method on the object `exposeOrivon` builds in `orivon-surface.ts`, and
  `src/shim-electron/dialog.ts`'s `showOpenDialog` still throws `'not-built'` citing exactly
  this. **This is deliberate, not an oversight the run ran out of time for:** `A167` item 2
  recorded real judgment calls behind `d-0029`'s `DirectoryHandle` shape (return-type
  cardinality, dropping `multiple` from the directory overload, mirroring `OrivonFs`'s own
  method set rather than the web platform's traversal API) that the owner has not confirmed.
  `fs.open` no longer blocks this row -- `FileHandle` is fully built -- so the one remaining
  blocker is that confirmation, not more broker work. **PR #206, which would build this, is
  OPEN, not merged, at this table's cut commit `1352a57` -- this row reports what `main` shows
  today, not what is coming.**
- **No other Table 1, 2, 3 or 5 row moved.** `id.requestIdentity`, `app.requestGrant`, every
  `net.connect`/`connectSecure`/`udpBind` row, the `electron` module family and the native-module
  question are exactly where the 2026-09-13 pass left them -- none of #199-#205 touched them.

**Two fresh gaps this pass found, both bounded and both filed, neither a regression:** A146 (a
first-ever visit to an app can see an early capability call denied before its one-time
install-consent dialog has been answered -- every later visit is unaffected, since the grant is
already held) and A143 (a cross-origin request from inside an app's own partition is denied
outright rather than proxied to the real network -- a deliberate fail-closed choice, not yet an
owner decision).

**Two more findings this pass surfaced are about the shim underneath every row in this table,
not about the loader, and are deliberately NOT reflected as cell changes above** -- re-deriving
Table 3 by this document's own recipe ("verify by looking for the module") does not catch either
one, because both are about whether a module that exists actually *runs* in production, not
whether it exists: A151 (the shim's own global polyfills -- `process`, `setImmediate` -- have no
production call site, so a real app whose dependency graph touches `stream` fails at load) and
A152 (a real capability denial crossing the main-world bridge reports as the generic `'internal'`
code, not `'denied'`, so a ported app cannot branch on it correctly). Both were being worked on
in a separate lane as this pass was written -- check `docs/open-questions.md` before assuming
either is still open.

Two axes, and they fail in completely different ways:

- **Table 1 is authority** -- what is an app *allowed* to do. Missing it, the app runs and every
  privileged call returns `'denied'`.
- **Tables 2 and 3 are ability** -- can the app's code *execute* at all. Missing it, the app is
  allowed to do everything and crashes on line 1.

**Table 3 is not a third axis.** It is an inventory over ground Table 2 already covers, at a
finer grain: half its rows are Table 2's Node-stdlib family itemised, and closing one closes
the other -- the same item, listed twice, not two blockers. Its `Class` column says which rows
are that duplication and which are genuinely elsewhere. **Completing Tables 1 and 2 closes
every `dup` row automatically**; six rows survive it, and four of those were never shim work.

---

## Table 1 -- the capability surface (authority)

**Spec'd** = in [`src/contracts/`](../../src/contracts/) | **Broker** = implemented in
[`index.ts`](../../src/broker/index.ts) | **Page** = reachable from `window.orivon` |
**Node shim** = a Node-shaped equivalent exists in [`src/shim/`](../../src/shim/)

✅ done | ❌ not there | ⚠️ partial or unsettled | 🚫 excluded by design | ➖ not applicable

| Capability | Spec'd | Broker | Page | Node shim | Note |
|---|:--:|:--:|:--:|:--:|---|
| `net.connect` (TCP out) | ✅ | ✅ | ✅ | ✅ | Both stream halves wired, e2e-verified. Node shape in [`node-net-socket.ts`](../../src/shim/node-net-socket.ts) (#135) |
| `net.connectSecure` (TLS out) | ✅ | ✅ | ✅ | ✅ | TLS terminated on the trusted side per [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md). Broker + IPC + page (#126); Node `https`/`http` clients on top (#131) |
| `net.udpBind` + send/recv | ✅ | ✅ | ✅ | ✅ | Node shape in [`node-dgram-socket.ts`](../../src/shim/node-dgram-socket.ts) (#135) |
| `net.listen` (TCP in) | ✅ | ✅ | ✅ | ✅ | Broker built with real accepted-socket handles, unsigned-app port rules and a revocation cascade (#109). **Now reachable from a page**: A114's nested-port shape (`d-0028`'s `AcceptedMessage`) landed in #199 (contracts) and #203 (wiring). Node shape in [`node-net-server.ts`](../../src/shim/node-net-server.ts) (#205) -- a real `net.Server`/`createServer`, still refusing a non-default `.listen(port, host)` since the capability itself always binds every interface |
| `fs.readFile` / `writeFile` | ✅ | ✅ | ✅ | ✅ | Confined to the app dir. Node shape in [`node-fs.ts`](../../src/shim/node-fs.ts) (#135) |
| `fs.readFileSync` | ✅ | ✅ | ✅ | ✅ | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md), built end to end over `ipcRenderer.sendSync` (#124). Grant check and path confinement are shared with the async path; **the per-origin in-flight budget is not** -- A112 |
| `fs.mkdir` / `readdir` / `stat` / `rm` / `rename` | ✅ | ✅ | ✅ | ✅ | PROVISIONAL markers removed by the Phase 1 contracts PR; built in #132 |
| `fs.open` (`FileHandle`) | ✅ | ✅ | ✅ | ✅ | Broker (`fs-capability.ts`'s `open`), dispatch and preload landed in #204; Node shape (`node-fs-handle.ts`, a Node-style cursor over the contract's explicit-position reads/writes) in #205. **One named limitation, not a silent gap:** `readable()`/`writable()` are built in the broker but have no control-channel case and are not on `window.orivon` -- A184. `createReadStream`/`createWriteStream` refuse loudly citing it rather than faking a stream |
| `fs.userSelected` (picker) | ✅ | ❌ | ❌ | ➖ | The only route outside the app dir. **No longer blocked by a missing `FileHandle`** -- that is built (row above). What blocks it now is an owner confirmation: `d-0029`'s `DirectoryHandle` shape carries real judgment calls (return cardinality, dropping `multiple`, mirroring `OrivonFs`'s own method set) the owner has not yet confirmed -- A167 item 2. **PR #206 would build this and is open, not merged**, at this table's cut commit |
| `id.publicKey` / `sign` | ✅ | ✅ | ✅ | ➖ | Wired end to end, e2e-verified (#112). P-256 ECDSA only; secp256k1/Schnorr is the separate A44 question |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | The last lane of Phase 4, ready to dispatch. `src/nostr/nip07.ts`'s real wiring calls this and cannot reach a page until it exists -- A111 |
| `app.manifest` / `grants` | ✅ | ✅ | ✅ | ➖ | Backs Electron's `app.*` -- see Table 2 |
| `app.requestGrant` | ✅ | ✅ | ✅ | ➖ | **Reachable from a page, end to end.** A control-channel case in [`ipc.ts`](../../src/broker/transport/ipc.ts) turns a page's call into `ctx.requestGrant(origin, request)` (#165); accepting the dialog persists a real grant a later capability call actually uses -- e2e-verified, refusal included (#175). **A grant in practice still needs the rest of build step 4**: an origin must be registered as an app first (the discovery trigger, #164), which is also where install-time consent now asks once for the whole declared set before the app's own code runs (`d-0025`, #171) -- so a first-ever visit can still see an early call denied before that one dialog resolves (A146). `src/main/permissions.ts`'s and `request-grant-subsystem.ts`'s own header comments still say nothing calls `ctx.requestGrant` -- stale source comments, filed rather than fixed, out of this pass's paths |
| `dns.lookup` (`orivon.net.lookup`) | ✅ | ✅ | ✅ | ✅ | **Built this run, closing A107.** The capability is `OrivonNet.lookup` (`d-0030`, #199) -- there is no separate `orivon.dns` namespace; `dns.lookup` is what the Node shape backs, not a distinct entry point. Broker + dispatch + preload in #201, bounded by the union of the origin's held `tcp.connect`/`https.connect`/`udp.send` patterns (that reading is A171, still AI-recommendation, not owner-confirmed). Node shape in [`node-dns.ts`](../../src/shim/node-dns.ts) (#205) now resolves for real -- the shim entry no longer exists only to refuse |
| `hid` / USB | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 for every tier, by owner decision |
| `subprocess` | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 as largest attack surface |

**Only prefixes of ✅ are legal.** A call travels Spec'd -> Broker -> Page, so the valid shapes
are ❌❌❌, ✅❌❌, ✅✅❌, ✅✅✅. Anything else is a defect or a mislabel -- Broker ✅ with
Spec'd ❌ means implementation ran ahead of the contract, which is what `ADR-0002` exists to
prevent. **Re-checked over the whole table this pass: every row is a legal prefix, and the one
exception this section used to carry is gone.** `dns.lookup` used to be the legal-in-spirit
oddity -- a shim entry that existed only to refuse, with ❌ everywhere left of it. It is now a
plain ✅✅✅✅ row like any other: the refusal was replaced by a real implementation, not
grandfathered in. `hid`/`subprocess` are 🚫 across all four columns, which is its own declared
category (excluded by design), not a legality violation.

**The single biggest gap this table has tracked since it started is closed.** `requestGrant` is
wired to a page, the dialog fires, and an accepted answer persists a grant a subsequent
`net.connect` (or any other granted capability) actually uses -- proven end to end, including the
out-of-manifest refusal, by a real Electron launch.

**What is not proven the same way, and it is worth naming rather than implying otherwise:** no
automated test drives the exact chain "a real page, at a real public HTTPS origin, triggers the
real install-time consent dialog and it works." `install-origin.ts`'s own T12/A46 guard means no
hermetic test fixture's origin can ever pass `Loader.load()`'s own public-unicast check, so every
e2e test in this area substitutes one layer below that wall -- a developer-only grant hook, or a
direct call to the consent function itself -- the same substitution `test/e2e-capability-
boundary.test.ts` already used for the raw capability API. Each link is proven for real (a real
broker's consent decision, a real dialog's wiring, a real IPC round trip); the full chain through
a real public origin is not something CI can reach at all, not a gap in the mechanism.

The next real lever is Table 4 row 6 below. `fs.open`/`FileHandle` is done; what is left is
`fs.userSelected` itself, blocked on an owner confirmation (A167 item 2) rather than more build
work.

## Table 2 -- the three adapter families (shim families structure)

An app never calls `orivon.*` directly unless it was written for Orivon. Something has to
present a familiar interface on top. There are three such layers, and each now has an owner.

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | `net`, `dgram`, `fs`, `http`, `https`, `Buffer`, `stream`... | `net.*`, `fs.*` | ✅ built -- `net` (client and server), `dgram` and `fs` (including `FileHandle`) over the capabilities (#135, #204, #205), Node's `http`/`https` clients over `net.connectSecure` (#131), `dns.lookup` over `orivon.net.lookup` (#205), and all eight core polyfill packages installed after the owner approved them. **This run closed the two named gaps**: `net.createServer` is now a real [`node-net-server.ts`](../../src/shim/node-net-server.ts) (A114 resolved) and `dns.lookup`/`dns.promises.lookup` now resolve for real (A107 resolved). **What still refuses, narrower and by design:** `net.Server#listen` with a non-default host, `FileHandle.createReadStream`/`createWriteStream` (A184), and every other `dns.*`/`net.*` member this shim has not decided on |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog` | `app.*`, `fs.userSelected` | ⚠️ built, partial -- [`src/shim-electron/`](../../src/shim-electron/) (#108, closes A95) |
| **Web ecosystem** | `window.nostr` (NIP-07); later `window.ethereum` | `id.*` | ✅ built ([`nip07.ts`](../../src/nostr/nip07.ts)), still not wired into a page -- blocked on `id.requestIdentity`, which is the last unstarted lane of Phase 4 (A111) |

**The `electron` family now has an owner.** `src/shim-electron/` (#108) closes A95: `app`,
`dialog`, `ipcRenderer`/`ipcMain` and `BrowserWindow`/`Menu`/`Tray`, reconstructed or explicitly
refused on top of `orivon.*`, as its own package rather than folded into `src/shim/`. A refusal
and a gap are not the same cell:

| Electron API | What backs it | This package |
|---|---|---|
| `app.getPath('userData')` | the app's own confined `fs` root | `app.ts` -- built |
| `app.getVersion()` | `orivon.app.manifest()` | `app.ts` -- built |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` | `dialog.ts` -- **present but throws** (`'not-built'`): the broker does not implement `fs.userSelected` yet (Table 1) |
| `ipcRenderer.invoke` / `ipcMain.handle`, `.on`/`.send` | a local in-sandbox message bus, no broker round-trip | `ipc.ts` -- built |
| `BrowserWindow`, `Menu`, `Tray` | nothing -- desktop-shell surface | `desktop-shell.ts` -- refuses by design, tested |

## Table 3 -- the runtime environment (ability)

**What the app is capable of doing in the browser environment.**

This is the half the 2026-08-25 correction called *"the capability-backed part is the small
part"*. [`src/shim/`](../../src/shim/) now holds `globals.ts`, `module-map.ts`, a hand-written
`node-util.ts`, a README and tests (#111). **Row 2's "owned by nobody" framing is gone**: [its
own README](../../src/shim/README.md) widened its declared scope on the same day this gap was
first called out, and now names the eight core polyfills (`Buffer`, `stream`, `events`, `path`,
`os`, `crypto`, `zlib`, `util`) as queue item 3.1, explicitly owned by the `shim` stream --
matching Table 2's `net, dgram, fs, Buffer, stream...` rather than falling short of it.

**`Class` answers one question: if I complete Tables 1 and 2, is this row still open?**

- **`dup`** -- **no.** This row *is* Table 2 at a finer grain. Implement it there and it closes
  here. Pure shim work: write JavaScript in `src/shim/`, no decision needed first.
- **`needs T1`** -- **yes**, until Table 1 grows an entry it does not have. The adapter sits
  inside Table 2's family, but there is nothing underneath to build it on, so the work lands in
  [`src/contracts/`](../../src/contracts/) -- own PR, merges first, owner decision.
- **`outside`** -- **yes.** Neither table covers it. No Node module, `electron` call or web API
  expresses the problem, so no amount of shim work touches it.

| Surface | Class | Needed by | Status | Where the answer comes from |
|---|:--:|---|:--:|---|
| `process`, `nextTick`, `setImmediate` | `dup` | everything | ✅ built | `shim/globals.ts` |
| `util` | `dup` | any dependency using `inherits` | ✅ built | Hand-written, `inherits`-only, no dependency (`src/shim/node-util.ts`, #111) |
| `Buffer`, `stream`, `events`, `path`, `os`, `crypto`, `zlib` | `dup` | everything | ✅ built | **The owner approved all eight** on 2026-09-10, deliberately wider than the review's own recommendation of five, so an unattended run could not stall overnight on a missing module (`shim-dependency-review.md`; INBOX `D-0005`). `package.json` carried zero runtime dependencies that morning and now carries nine |
| `net` / `dgram` / `fs` Node shapes | `dup` | every ported app | ✅ built, client and server | #135, #204, #205. `net.connect`, `dgram`, `fs` (async and sync) and now `net.createServer`/`net.Server` and `fs.open`/`FileHandle` present real Node shapes over the capabilities. Two narrow, named refusals survive: `net.Server#listen` with a non-default host, and `FileHandle.createReadStream`/`createWriteStream` (A184, no page-reachable byte stream underneath yet) |
| Synchronous `fs` (`readFileSync`) | **`needs T1`** | ported apps, at startup | ✅ built | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md) authored and merged (#117), then built end to end over `ipcRenderer.sendSync` (#124). Design rule 2 now narrows to network operations only. One filed gap: the sync path does not share the async path's per-origin fairness budget -- A112 |
| `electron` module | `dup` | every tier-2 app | ⚠️ partial | `src/shim-electron/` built (#108, closes A95): `app.*`/`ipcRenderer`/`ipcMain` work, `BrowserWindow`/`Menu`/`Tray` refuse by design. `dialog.showOpenDialog` still throws -- `fs.open` is built now, but `dialog.showOpenDialog` maps to `fs.userSelected`, which is still unimplemented (Table 1) |
| HTTP client | `dup` | trackers, web seeds, any REST | ✅ built | Two halves, both landed. The page's own `fetch()` is routed through the secure-connect capability for granted hosts ([`fetch-route.ts`](../../src/preload/fetch-route.ts), #133), and Node's `http`/`https` clients sit on the same capability (#131). **The second half matters less than expected:** #131's lane checked the real sources and found neither webtorrent nor bittorrent-tracker still uses Node's HTTP client -- the tracker client calls `fetch`. With FreeTube already on record as 32 `fetch` calls and zero Node builtins, routed `fetch` is the confirmed path for **both** Phase 5 lanes |
| TLS / `https` | **`needs T1`** | nearly every app | ✅ built | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md) authored and merged (#117); `net.connectSecure` built in the broker and wired through IPC to a real page (#126). Orivon terminates the handshake on the trusted side, so a grant and a prompt can name the true hostname |
| `worker_threads` | `dup` | validation-heavy work | ❌ missing | Web Workers are already in the renderer, so the substrate exists and no Table 1 entry is needed; the shape does not match and a shim cannot fully fake it. A fidelity problem, not a substrate one |
| Background lifetime | **`outside`** | seeding, syncing, pinning | ⚠️ **unspecified** | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Shell holds the process, contracts describe it, UI shows it. `mvp-scope.md` counts `backgroundSec` in the metric but nothing grants it |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount. `src/shim-electron/app.ts`'s `getPath` enforces the identical boundary for any name but `'userData'` |
| Desktop shell (tray, autostart, protocol handlers, hotkeys) | **`outside`** | Electron apps' outer half | ⚠️ partial | `BrowserWindow`/`Menu`/`Tray` are now explicit, tested named refusals (`src/shim-electron/desktop-shell.ts`, #108); autostart, protocol handlers and hotkeys remain simply absent |
| Native addon in the dep tree | **`outside`** | see Table 5 | ❌ missing | Per-library substitution, not a platform feature. Pure-JS/WASM substitute, or a helper process |

**Seven `dup` rows, five of them now fully built** (`net`/`dgram`/`fs` joins that list this pass,
closing the last real gap in it) **-- one, `electron`, stays partial** (`dialog.showOpenDialog`
still throws, now solely on `fs.userSelected`, not `fs.open` too) **-- one, `worker_threads`,
stays missing outright, by design, not effort.** Two `needs T1`, both BUILT rather than merely
decided; four `outside`, all unchanged. This is the pass where the ability axis stopped being
the bottleneck: what remains on it is `worker_threads` (a fidelity problem, not a substrate one)
and the four `outside` rows, which no amount of shim work reaches.

**Synchronous `fs` was the one to settle first, and `needs T1` is why:** it is not a missing
function, it is a missing mechanism, so no amount of shim effort reaches it. A ported app fails
at *startup*, not under load -- `readFileSync` is how Node programs read their own config,
usually inside a dependency the porting developer does not control. **It is now built** (#124,
over [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md)). The residual is
narrow and filed: the sync path shares the grant check and the path confinement with the async
path, but not the per-origin in-flight budget, so one origin can monopolise sync reads -- A112,
a fairness gap rather than a confinement one.

**Of the four `outside` rows, background lifetime is still the one open gap.** Ambient FS is a
deliberate boundary and native addons are per-library (Table 5). The desktop shell is now a
deliberate boundary for `BrowserWindow`/`Menu`/`Tray` specifically (`src/shim-electron/`,
#108) but not yet for autostart, protocol handlers or hotkeys, which remain simply unbuilt.
Background lifetime is unfiled, touches the success metric directly, and is the one row here
that finishing every other table would leave exactly where it stands -- Table 4 row 9.

## Table 4 -- blockers, and the cheapest lever for each

Ordered by reach per unit of effort. **The ordering is an AI recommendation, not a schedule** --
only rows 1 and 9 are owned by anything today.

| # | Blocker | Cheapest lever | Cost shape |
|---|---|---|---|
| 1 | ~~Nothing calls `app.requestGrant`~~ -- **closed by #165**, plus the rest of build step 4 that makes registering an app mean something: the discovery trigger (#164), install-time consent (#171), serving from cache (#168), and the e2e journey proving the whole chain (#175) | -- | What is left open here is A146 (a first-visit race) and A143 (partition-wide scheme interception, a deliberate fail-closed choice) -- not a wiring gap |
| 2 | ~~No `orivon.id.*` entry point~~ -- **closed by #112** | `id.requestIdentity` (named identities, `window.nostr`) is the last unstarted Phase 4 lane | A111 |
| 3 | ~~CORS blocks tier-1 and tier-2 HTTP~~ -- **closed by #133**: the page's own `fetch()` is routed through the secure-connect capability for granted hosts | -- | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md) |
| 4 | ~~No `net.listen`~~ (broker) -- **closed by #109**. ~~No page wiring~~ -- **closed by #199 (the `d-0028` nested-port shape) and #203 (the wiring itself)**, plus its Node shape by #205 | -- | A114 resolved -- see `docs/open-questions.md` |
| 5 | ~~Provisional `fs.*` signatures~~ -- **closed**: the Phase 1 contracts PR landed and #132 built the six methods | `fs.open`/`FileHandle` is the one entry point still unbuilt, and it blocks the folder picker | See row 6 |
| 6 | ~~No `FileHandle`~~ -- **closed by #204 (broker + page) and #205 (Node shape)**. **What is left: `fs.userSelected` itself** | Build `fs.userSelected` on top of the now-complete `FileHandle` -- no more `FileHandle` work needed | The owner has already decided the UX (`D-0007`: a picked folder is remembered and revocable from the permissions list); what is unconfirmed is `d-0029`'s own `DirectoryHandle` shape (A167 item 2: return cardinality, dropping `multiple`, mirroring `OrivonFs`'s method set) -- an owner confirmation, not a fresh decision from scratch. **PR #206 would build this and is open, not merged**, at this table's cut commit |
| 7 | ~~No `electron` module shim~~ -- **closed by #108** | `dialog.showOpenDialog` still refuses, pending row 6 | See Table 2 |
| 8 | ~~TLS absent from contracts~~ -- **closed by #126**, over [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md) | -- | -- |
| 9 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly. **Unchanged, and now the oldest open row here** |
| 10 | `hid`/USB -- wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 11 | Native addons in dep trees | Substitute per library -- Table 5 | Per-app, not per-platform |
| 12 | Tier 3 -- no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |
| 13 | App logic is not JavaScript | Nothing works today, WASM included | Blocked upstream: Go has no wasip2, wasi-sdk has no target with threads AND sockets |

**Row 4 closes this pass** (broker in an earlier pass, page and Node shape in this one -- A114
resolved). Rows 1, 2 (Phase 4's `id.*` entry point, not `requestIdentity` itself), 3, 5, 7 and 8
closed in earlier passes. **Re-ordered for what is actually left, since this pass changed the
reach-per-effort math:** row 6 (`fs.userSelected`) is now the top of this list, more so than
before -- `FileHandle` no longer stands between it and being built, so what remains is a single
owner confirmation (A167 item 2) plus wiring a PR (#206) already drafts. Next is row 2
(`id.requestIdentity`, ready to dispatch, no decision blocking it). Row 9 (background lifetime)
is unfiled and needs a decision before it is even build-shaped, so it sits behind both despite
being the oldest open row here. **Still unfiled** as of this pass: rows 9 and 11, plus
declarability (what a grant prompt can honestly say for runtime-chosen hosts) and per-syscall
IPC cost on a chatty workload.

## Table 5 -- the native-module question, per library

Asked 2026-09-09: *could native binaries be preinstalled, bypassing Rule 8, to reach these?*

**The mechanical answer first.** App code runs with `sandbox: true, nodeIntegration: false`. A
preinstalled native module lives in *Orivon's* process, not the app's -- no page can `require` it
under any Rule 8 policy. Reaching one means giving it an `orivon.*` capability, so the cost lands
on [`src/contracts/`](../../src/contracts/), the artefact `ADR-0002` says is expensive to get
wrong, not on the build toolchain.

| Library | Why an app wants it | Renderer answer that exists today | Verdict |
|---|---|---|---|
| `better-sqlite3` | local relational store | `sql.js` / `wa-sqlite` (WASM SQLite) over `orivon.fs`, or IndexedDB | ✅ No capability needed. Slower; irrelevant at MVP scale |
| `leveldown` / `classic-level` | key-value store | `browser-level` (IndexedDB), `memory-level` -- the level ecosystem ships browser backends by design | ✅ No capability needed |
| `secp256k1` bindings | ECDSA / Schnorr | `@noble/secp256k1`, pure JS and audited; plus `orivon.id.sign` for the user's key | ✅ No capability needed. ~10x slower, still thousands of ops/sec |
| `node-datachannel` | WebRTC inside Node | the renderer has real `RTCPeerConnection` | ✅ Evaporates. `check-no-native-modules.mjs` names this exact chain as the threat; in a renderer it isn't one |
| `node-usb` / `node-hid` | hardware wallets | nothing -- it is physical device access | ❗ **Genuine.** But Rule 8 was never the blocker: it needs `orivon.hid.*`, a device chooser and a grant, which cost the same either way |

**What the question was really pointing at, and it is a real gap:** the missing thing is not
permission to compile C++, it is **a place to run non-renderer code**. `ADR-0005` dissolved the
"app backend", so all app code is renderer JS. Preinstalled natives only pay off once something
can load them on an app's behalf -- `subprocess`, or the container path. Both post-MVP.

## Table 6 -- how to update this

Check the code, do not trust the tables above.

| Cell | Recipe |
|---|---|
| Table 1, Spec'd | Read [`capability-api.ts`](../../src/contracts/capability-api.ts). A PROVISIONAL doc comment means ⚠️, not ✅ |
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker` -- a function that exists but isn't returned is not reachable. The broker is split: `net`'s five entry points (`connect`/`connectSecure`/`udpBind`/`listen`/`lookup`) live in `net-capability.ts`, `fs`'s nine (including `open`) in `fs-capability.ts`, and `id`'s two in `id-capability.ts`, each returned from its own factory and re-exported through `createBroker`'s own returned object -- check those files too, not just `index.ts` |
| Table 1, Page | `grep -n "call('" src/preload/orivon-surface.ts`, plus `src/preload/main-world-socket.ts` for what the main-world wrapper builds. A real-Electron e2e test is the strongest proof a real page can call it; where none exists yet (`net.listen`, `fs.open`, `net.lookup`, as of this pass), a test exercising the real `installOrivon` wiring rather than a hand-built stub is the fallback -- weaker, but still a real dispatch/preload path, not just a file that exists |
| Table 1, Node shim | `ls src/shim/` |
| Table 2 | Node family: `src/shim/`. Electron family: `src/shim-electron/`. Web family: `src/nostr/` |
| Table 3, Status | Mostly absence -- verify by looking for the module, not for a mention of it |
| Table 3, Class | Not observable in the tree; derived. `dup` if Table 2's families name the surface at all, `needs T1` if they do but Table 1 has no entry the adapter could be built on, `outside` if no Node/`electron`/web API expresses the problem. Re-derive the row when Table 1 or the shim README's declared scope changes -- not when a status flips |
| Table 4 | When a row closes, replace it with a one-line note naming the PR rather than deleting it |
| Header date | Update it whenever a cell changes, and say which cells changed |

**Do not let this grow into a second copy of `app-compatibility.md`.** If an entry starts
explaining *why a tier exists*, it belongs there.
