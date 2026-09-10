# App compatibility matrix

**What is wired up right now, and the cheapest next lever.** Derived 2026-09-10 (second pass of
the day) by reading the tree at `61fcfca`, after eighteen further merged PRs (#118-#135).
[`../architecture/app-compatibility.md`](../architecture/app-compatibility.md) owns *why the
tiers exist*; this file owns *what works today*. If they disagree, that one is the design and
this one is stale.

**What changed since this morning's derivation, cell by cell.** The two ADRs the previous pass
kept calling "drafted, awaiting owner authorship" were authored and merged
([ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md),
[ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md), #117), and almost every row
that was blocked behind them moved:

- **Table 1.** Three new rows -- `net.connectSecure` (✅✅✅✅, #126), `fs.readFileSync`
  (✅✅✅✅, #124) and `dns.lookup` (decided, refusing shim only, A107). `fs.mkdir/readdir/stat/
  rm/rename` ❌❌❌ -> ✅✅✅ (#132) and the PROVISIONAL markers are gone; `fs.open` split out of
  that row because it alone is still unbuilt. The whole **Node shim column** filled in for
  `net.connect`, `net.connectSecure`, `net.udpBind` and every `fs` row (#135, #131).
  `app.requestGrant` ❌ -> ⚠️: the mechanism and the prompt exist (#127, #130), nothing calls
  them. `net.listen`'s Page ❌ now has a filed reason rather than a deferral -- A114.
- **Table 2.** The Node-stdlib family ❌ -> ⚠️: `net` (client), `dgram`, `fs`, `http`, `https`
  and the eight core polyfill packages are in, `net.createServer` refuses.
- **Table 3.** Four rows closed: the polyfill row (the owner approved all eight packages, and
  `package.json` now carries them -- it had zero runtime dependencies this morning), the
  `net`/`dgram`/`fs` shapes row, synchronous `fs`, and both HTTP rows. Two `needs T1` rows are
  now built rather than merely decided.
- **Table 4.** Rows 3, 5, 6 and 8 closed; row 1 rewritten, because the blocker is no longer the
  absence of a prompt but the absence of a caller.

**Three fresh gaps this pass found, none of them regressions:** A112 (the synchronous `fs` path
does not share the async path's per-origin fairness budget), A113 (a thrown `OrivonError` loses
its `code` on the `exposeFallback` path, so apps cannot branch on the failure enum) and A114
(`net.listen` cannot reach a page without a nested-port IPC shape).

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
| `net.listen` (TCP in) | ✅ | ✅ | ❌ | ❌ | Broker built with real accepted-socket handles, unsigned-app port rules and a revocation cascade (#109). **Still not on the page**, and now with a filed reason: delivering `TcpServer.connections` needs a nested-port shape the IPC contract has no room for -- A114. `net.createServer` in the shim routes to [`node-net-unsupported.ts`](../../src/shim/node-net-unsupported.ts) and fails loudly |
| `fs.readFile` / `writeFile` | ✅ | ✅ | ✅ | ✅ | Confined to the app dir. Node shape in [`node-fs.ts`](../../src/shim/node-fs.ts) (#135) |
| `fs.readFileSync` | ✅ | ✅ | ✅ | ✅ | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md), built end to end over `ipcRenderer.sendSync` (#124). Grant check and path confinement are shared with the async path; **the per-origin in-flight budget is not** -- A112 |
| `fs.mkdir` / `readdir` / `stat` / `rm` / `rename` | ✅ | ✅ | ✅ | ✅ | PROVISIONAL markers removed by the Phase 1 contracts PR; built in #132 |
| `fs.open` (`FileHandle`) | ✅ | ❌ | ❌ | ❌ | The one `fs` entry point still unbuilt anywhere in the broker. It is what blocks `fs.userSelected` below, and with it the folder picker |
| `fs.userSelected` (picker) | ✅ | ❌ | ❌ | ➖ | The only route outside the app dir. **Blocked twice:** no `FileHandle` above, and the picked-path persistence the owner decided on (`D-0007`: remembered, and revocable from the permissions list) shares a surface with the grant list |
| `id.publicKey` / `sign` | ✅ | ✅ | ✅ | ➖ | Wired end to end, e2e-verified (#112). P-256 ECDSA only; secp256k1/Schnorr is the separate A44 question |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | The last lane of Phase 4, ready to dispatch. `src/nostr/nip07.ts`'s real wiring calls this and cannot reach a page until it exists -- A111 |
| `app.manifest` / `grants` | ✅ | ✅ | ✅ | ➖ | Backs Electron's `app.*` -- see Table 2 |
| `app.requestGrant` | ✅ | ⚠️ | ❌ | ➖ | **The mechanism now exists** -- policy in [`request-grant.ts`](../../src/broker/policy/request-grant.ts), the prompt in `src/main/request-grant-prompt.ts` and `grant-prompt-render.ts`, registered as a subsystem (#127, #130). It is not on `window.orivon`, and `src/main/permissions.ts`'s own header still records that nothing calls `ctx.requestGrant` yet |
| `dns.lookup` | ❌ | ❌ | ❌ | ⚠️ | **Decided, not built.** The owner ruled (`D-0006`) that Orivon resolves names itself as part of the network permission. [`node-dns.ts`](../../src/shim/node-dns.ts) exists and fails loudly with a named error rather than hanging -- A107 |
| `hid` / USB | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 for every tier, by owner decision |
| `subprocess` | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 as largest attack surface |

**Only prefixes of ✅ are legal.** A call travels Spec'd -> Broker -> Page, so the valid shapes
are ❌❌❌, ✅❌❌, ✅✅❌, ✅✅✅. Anything else is a defect or a mislabel -- Broker ✅ with
Spec'd ❌ means implementation ran ahead of the contract, which is what `ADR-0002` exists to
prevent. `dns.lookup`'s ⚠️ in the shim column with ❌ everywhere left of it is the one legal
exception in spirit: the shim entry exists **to refuse**, not to work.

**The single biggest gap has moved.** It is no longer "nothing grants anything" -- `requestGrant`
and the prompt are built. It is that **nothing calls them**: no page-facing entry point, so a real
app still cannot ask, and `net.connect` from a page still answers `'denied'` for want of a grant.
That is one wiring job, not a design one.

## Table 2 -- the three adapter families (shim families structure)

An app never calls `orivon.*` directly unless it was written for Orivon. Something has to
present a familiar interface on top. There are three such layers, and each now has an owner.

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | `net`, `dgram`, `fs`, `http`, `https`, `Buffer`, `stream`... | `net.*`, `fs.*` | ⚠️ built, one gap -- `net` (client), `dgram` and `fs` over the capabilities (#135), Node's `http`/`https` clients over `net.connectSecure` (#131), and all eight core polyfill packages installed after the owner approved them. **`net.createServer` refuses** ([`node-net-unsupported.ts`](../../src/shim/node-net-unsupported.ts)) pending A114, and `dns` refuses pending its own capability (A107) |
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
| `net` / `dgram` / `fs` Node shapes | `dup` | every ported app | ⚠️ built, client-side | #135. `net.connect`, `dgram` and `fs` (async and sync) present real Node shapes over the capabilities; `net.createServer` refuses loudly pending A114 |
| Synchronous `fs` (`readFileSync`) | **`needs T1`** | ported apps, at startup | ✅ built | [ADR-0016](../decisions/ADR-0016-synchronous-file-reads-are-permitted.md) authored and merged (#117), then built end to end over `ipcRenderer.sendSync` (#124). Design rule 2 now narrows to network operations only. One filed gap: the sync path does not share the async path's per-origin fairness budget -- A112 |
| `electron` module | `dup` | every tier-2 app | ⚠️ partial | Unchanged this pass. `src/shim-electron/` built (#108, closes A95): `app.*`/`ipcRenderer`/`ipcMain` work, `dialog.showOpenDialog` still throws (`fs.open`/`fs.userSelected` unimplemented -- Table 1), `BrowserWindow`/`Menu`/`Tray` refuse by design |
| HTTP client | `dup` | trackers, web seeds, any REST | ✅ built | Two halves, both landed. The page's own `fetch()` is routed through the secure-connect capability for granted hosts ([`fetch-route.ts`](../../src/preload/fetch-route.ts), #133), and Node's `http`/`https` clients sit on the same capability (#131). **The second half matters less than expected:** #131's lane checked the real sources and found neither webtorrent nor bittorrent-tracker still uses Node's HTTP client -- the tracker client calls `fetch`. With FreeTube already on record as 32 `fetch` calls and zero Node builtins, routed `fetch` is the confirmed path for **both** Phase 5 lanes |
| TLS / `https` | **`needs T1`** | nearly every app | ✅ built | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md) authored and merged (#117); `net.connectSecure` built in the broker and wired through IPC to a real page (#126). Orivon terminates the handshake on the trusted side, so a grant and a prompt can name the true hostname |
| `worker_threads` | `dup` | validation-heavy work | ❌ missing | Web Workers are already in the renderer, so the substrate exists and no Table 1 entry is needed; the shape does not match and a shim cannot fully fake it. A fidelity problem, not a substrate one |
| Background lifetime | **`outside`** | seeding, syncing, pinning | ⚠️ **unspecified** | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Shell holds the process, contracts describe it, UI shows it. `mvp-scope.md` counts `backgroundSec` in the metric but nothing grants it |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount. `src/shim-electron/app.ts`'s `getPath` enforces the identical boundary for any name but `'userData'` |
| Desktop shell (tray, autostart, protocol handlers, hotkeys) | **`outside`** | Electron apps' outer half | ⚠️ partial | `BrowserWindow`/`Menu`/`Tray` are now explicit, tested named refusals (`src/shim-electron/desktop-shell.ts`, #108); autostart, protocol handlers and hotkeys remain simply absent |
| Native addon in the dep tree | **`outside`** | see Table 5 | ❌ missing | Per-library substitution, not a platform feature. Pure-JS/WASM substitute, or a helper process |

**Seven `dup` rows, five of them now closed; two `needs T1`, both now BUILT rather than merely
decided; four `outside`, all unchanged.** This is the pass where the ability axis stopped being
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
| 1 | **Nothing calls `app.requestGrant`.** The mechanism, the policy and the prompt all exist (#127, #130); no page-facing entry point does, so a real app still cannot ask for anything | Wire `requestGrant` onto `window.orivon` the way `fs.*` and `id.*` already are | Small, and it unblocks *everything* -- this is the row that was "no grant exists in production" for the whole project until now |
| 2 | ~~No `orivon.id.*` entry point~~ -- **closed by #112** | `id.requestIdentity` (named identities, `window.nostr`) is the last unstarted Phase 4 lane | A111 |
| 3 | ~~CORS blocks tier-1 and tier-2 HTTP~~ -- **closed by #133**: the page's own `fetch()` is routed through the secure-connect capability for granted hosts | -- | [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md) |
| 4 | ~~No `net.listen`~~ (broker) -- **closed by #109**. **Still open: no page wiring**, and now with a filed cause rather than a deferral | Design the nested-port IPC shape -- one port carrying further port descriptors, one per accepted connection | A114. Bigger than "wire it like `net.connect`" was assumed to be: the IPC contract has no room for the shape |
| 5 | ~~Provisional `fs.*` signatures~~ -- **closed**: the Phase 1 contracts PR landed and #132 built the six methods | `fs.open`/`FileHandle` is the one entry point still unbuilt, and it blocks the folder picker | See row 6 |
| 6 | **No `FileHandle`, so no folder picker** | Build `fs.open` in the broker, then `fs.userSelected` on top | The owner has already decided the UX (`D-0007`: a picked folder is remembered and revocable from the permissions list), so this is build work, not a decision. Shares a persisted surface with the grant list |
| 7 | ~~No `electron` module shim~~ -- **closed by #108** | `dialog.showOpenDialog` still refuses, pending row 6 | See Table 2 |
| 8 | ~~TLS absent from contracts~~ -- **closed by #126**, over [ADR-0017](../decisions/ADR-0017-orivon-owns-the-app-http-path.md) | -- | -- |
| 9 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly. **Unchanged, and now the oldest open row here** |
| 10 | `hid`/USB -- wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 11 | Native addons in dep trees | Substitute per library -- Table 5 | Per-app, not per-platform |
| 12 | Tier 3 -- no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |
| 13 | App logic is not JavaScript | Nothing works today, WASM included | Blocked upstream: Go has no wasip2, wasi-sdk has no target with threads AND sockets |

**Rows 1 and 6 are where the reach is now**, and both are build work rather than decisions --
which is a different situation from every prior pass of this table, where the top rows were
waiting on the owner. **Still unfiled** as of this pass: rows 9 and 11, plus declarability (what
a grant prompt can honestly say for runtime-chosen hosts) and per-syscall IPC cost on a chatty
workload. Rows 3, 5, 6 and 8 of the previous pass are closed.

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
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker` -- a function that exists but isn't returned is not reachable. The broker is split: `net`'s three entry points live in `net-capability.ts` and `id`'s two in `id-capability.ts`, each returned from its own factory and re-exported through `createBroker`'s own returned object -- check those files too, not just `index.ts` |
| Table 1, Page | `grep -n "call('" src/preload/orivon-surface.ts`, plus `src/preload/main-world-socket.ts` for what the main-world wrapper builds. The e2e test is the only proof a real page can call it |
| Table 1, Node shim | `ls src/shim/` |
| Table 2 | Node family: `src/shim/`. Electron family: `src/shim-electron/`. Web family: `src/nostr/` |
| Table 3, Status | Mostly absence -- verify by looking for the module, not for a mention of it |
| Table 3, Class | Not observable in the tree; derived. `dup` if Table 2's families name the surface at all, `needs T1` if they do but Table 1 has no entry the adapter could be built on, `outside` if no Node/`electron`/web API expresses the problem. Re-derive the row when Table 1 or the shim README's declared scope changes -- not when a status flips |
| Table 4 | When a row closes, replace it with a one-line note naming the PR rather than deleting it |
| Header date | Update it whenever a cell changes, and say which cells changed |

**Do not let this grow into a second copy of `app-compatibility.md`.** If an entry starts
explaining *why a tier exists*, it belongs there.
