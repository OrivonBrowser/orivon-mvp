# App compatibility matrix

**What is wired up right now, and the cheapest next lever.** Derived 2026-09-10 by reading the
tree (queue item 5.4, following seven merged PRs, #107 and #108-#113).
[`../architecture/app-compatibility.md`](../architecture/app-compatibility.md) owns *why the
tiers exist*; this file owns *what works today*. If they disagree, that one is the design and
this one is stale.

**What changed since the 2026-09-09 derivation, cell by cell:** Table 1 -- `net.listen`'s
Broker cell (❌->✅, #109) and `id.publicKey`/`id.sign`'s Broker and Page cells (❌❌->✅✅,
#112). Table 2 -- the Node-stdlib row's Status (a hand-written `util` and the alias map now
exist, #111); the `electron` row and its explainer table rewritten now that
[`src/shim-electron/`](../../src/shim-electron/) exists (#108, closes A95); the web-ecosystem
row's note sharpened (A111). Table 3 -- the "owned by nobody" framing on the polyfill row is
gone now that the shim README claims that scope; a new `util` row (✅, split out of the
polyfill row rather than marked done); the `electron module` row now ⚠️ partial; the
synchronous-`fs` and TLS/`https` rows move from "undecided"/"unfiled" to "decided, not yet
built" (A94, A96, both resolved 2026-09-09 but their ADR is still unwritten). Table 4 -- rows
2, 4, 5, 6, 7 replaced with closure notes naming their PRs; row 3's lever changed to match A98;
row 8 moved out of "still unfiled" now that A96 resolved it. **Also found and fixed while
re-deriving, unrelated to tonight's PRs:** Table 1's `app.manifest`/`grants` Page cell was
mislabeled ❌ -- the call is wired and e2e-proven reachable from a real page.

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
| `net.connect` (TCP out) | ✅ | ✅ | ✅ | ❌ | Both stream halves wired, e2e-verified |
| `net.udpBind` + send/recv | ✅ | ✅ | ✅ | ❌ | Landed most recently |
| `net.listen` (TCP in) | ✅ | ✅ | ❌ | ❌ | Broker built with real accepted-socket handles, the unsigned-app port rules and a revocation cascade, unit-tested (`src/broker/tests/index-listen.test.ts`) -- #109. Deliberately not wired to the page pending a nested-port-delivery design: no `call('net.listen', ...)` exists in `orivon-surface.ts` |
| `fs.readFile` / `writeFile` | ✅ | ✅ | ✅ | ❌ | Confined to app dir |
| `fs.open/mkdir/readdir/stat/rm/rename` | ⚠️ | ❌ | ❌ | ❌ | Signatures still marked PROVISIONAL in `capability-api.ts`. **A12 resolved 2026-09-09** (owner: byte-oriented, no encoding option -- exactly the reading already implemented), but the Phase 1 contracts PR that removes the markers has not landed in this tree, and `open`/`mkdir`/`readdir`/`stat`/`rm`/`rename` themselves remain unbuilt |
| `fs.userSelected` (picker) | ✅ | ❌ | ❌ | ➖ | The only route outside the app dir. Backs `dialog.*`, not a Node API |
| `id.publicKey` / `sign` | ✅ | ✅ | ✅ | ➖ | Broker (`src/broker/id-capability.ts`), transport and preload (`orivon-surface.ts`, `main-world-socket.ts`) wired end to end, e2e-verified (`test/e2e-id-capability.test.ts`) -- #112. P-256 ECDSA only; secp256k1/Schnorr is the separate A44 question |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | Needs the connect prompt (build step 4). `src/nostr/nip07.ts`'s real wiring calls this and cannot reach a page until it exists -- A111 |
| `app.manifest` / `grants` | ✅ | ✅ | ✅ | ➖ | **Mislabel found and corrected 2026-09-10:** the previous Page cell (❌) was wrong -- `call('app.manifest', ...)`/`call('app.grants', ...)` are wired and exposed on `window.orivon` in both `orivon-surface.ts` code paths, and a real page calling `orivon.app.grants()` is e2e-proven (`test/e2e-capability-boundary.test.ts`). Backs Electron's `app.*` -- see Table 2 |
| `app.requestGrant` | ✅ | ❌ | ❌ | ➖ | **Step 4.** No production caller of `broker.grant()` exists |
| `hid` / USB | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 for every tier, by owner decision |
| `subprocess` | 🚫 | 🚫 | 🚫 | 🚫 | Cut from v0 as largest attack surface |

**Only prefixes of ✅ are legal.** A call travels Spec'd -> Broker -> Page, so the valid shapes
are ❌❌❌, ✅❌❌, ✅✅❌, ✅✅✅. Anything else is a defect or a mislabel -- Broker ✅ with
Spec'd ❌ means implementation ran ahead of the contract, which is what `ADR-0002` exists to
prevent.

**The single biggest gap is `app.requestGrant`:** nothing in production grants anything yet,
which is why a real page's `net.connect` correctly answers `'denied'`.

**➖ means "no Node equivalent"**  
So implementing means create your own implementation of it

## Table 2 -- the three adapter families (shim families structure)

An app never calls `orivon.*` directly unless it was written for Orivon. Something has to
present a familiar interface on top. There are three such layers, and each now has an owner.

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | `net`, `dgram`, `fs`, `Buffer`, `stream`... | `net.*`, `fs.*` | ❌ build step 3, started but not the family itself -- an alias table and a hand-written `util` exist ([`module-map.ts`](../../src/shim/module-map.ts), #111); `net`/`dgram`/`fs` shapes and the other core polyfills are not begun |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog` | `app.*`, `fs.userSelected` | ⚠️ built, partial -- [`src/shim-electron/`](../../src/shim-electron/) (#108, closes A95) |
| **Web ecosystem** | `window.nostr` (NIP-07); later `window.ethereum` | `id.*` | ✅ built ([`nip07.ts`](../../src/nostr/nip07.ts)), not wired into a page -- blocked on `id.requestIdentity` plus the connect prompt (build step 4), not merely on wiring (A111) |

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
| `Buffer`, `stream`, `events`, `path`, `os`, `crypto`, `zlib` | `dup` | everything | ❌ missing | Standard browser polyfills; pure JS, cheap. Reviewed against webtorrent's real dependency tree (`shim-dependency-review.md`, #111): each is `pending-dependency`, awaiting owner approval -- no dependency has actually been added, `package.json` still has zero runtime deps |
| `net` / `dgram` / `fs` Node shapes | `dup` | every ported app | ❌ missing | Step 3 -- the shim proper, over Table 1 |
| Synchronous `fs` (`readFileSync`) | **`needs T1`** | ported apps, at startup | ❌ **decided, not yet built** | **A94 resolved 2026-09-09** (owner: Route A, `ipcRenderer.sendSync`, narrowing `capability-api.md` design rule 2 to network operations only). The ADR is drafted, awaiting owner authorship through the sanctioned path; no sync entry point exists in `capability-api.ts` yet |
| `electron` module | `dup` | every tier-2 app | ⚠️ partial | Table 2, family 2 -- `src/shim-electron/` built (#108, closes A95): `app.*`/`ipcRenderer`/`ipcMain` work, `dialog.showOpenDialog` throws (`fs.userSelected` unimplemented), `BrowserWindow`/`Menu`/`Tray` refuse by design |
| HTTP client | `dup` | trackers, web seeds, any REST | ❌ missing | Renderer `fetch` is **CORS-bound**. **A98 resolved 2026-09-09**: the page's own `fetch()` is to be routed through the secure-connect capability for granted hosts, superseding the earlier "HTTP over `net.connect`" lever -- but the ADR is unwritten and nothing is built yet |
| TLS / `https` | **`needs T1`** | nearly every app | ❌ **decided, not yet built** | `orivon.net` gives raw TCP only. **A96 resolved 2026-09-09**: Orivon terminates TLS itself, on the trusted side, via a new capability -- not a JS TLS stack over `net.connect`, so this row stays `needs T1` rather than reclassifying `dup`. The ADR ("Orivon owns the app's HTTP(S) path", covering A96/A98/A99) is drafted, awaiting owner authorship; still absent from `src/contracts/` in this tree |
| `worker_threads` | `dup` | validation-heavy work | ❌ missing | Web Workers are already in the renderer, so the substrate exists and no Table 1 entry is needed; the shape does not match and a shim cannot fully fake it. A fidelity problem, not a substrate one |
| Background lifetime | **`outside`** | seeding, syncing, pinning | ⚠️ **unspecified** | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Shell holds the process, contracts describe it, UI shows it. `mvp-scope.md` counts `backgroundSec` in the metric but nothing grants it |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount. `src/shim-electron/app.ts`'s `getPath` enforces the identical boundary for any name but `'userData'` |
| Desktop shell (tray, autostart, protocol handlers, hotkeys) | **`outside`** | Electron apps' outer half | ⚠️ partial | `BrowserWindow`/`Menu`/`Tray` are now explicit, tested named refusals (`src/shim-electron/desktop-shell.ts`, #108); autostart, protocol handlers and hotkeys remain simply absent |
| Native addon in the dep tree | **`outside`** | see Table 5 | ❌ missing | Per-library substitution, not a platform feature. Pure-JS/WASM substitute, or a helper process |

**Seven `dup` rows, one of them now closed (`util`); two `needs T1`, both now decided but
unbuilt; four `outside`.** Completing Tables 1 and 2 still leaves the same six rows open that
it always did -- `needs T1` and `outside` are unaffected by the polyfill split -- and only two
of them are anywhere near the shim.

**Synchronous `fs` was the one to settle first, and `needs T1` is why:** it is not a missing
function, it is a missing mechanism, so no amount of shim effort reaches it. A ported app fails
at *startup*, not under load -- `readFileSync` is how Node programs read their own config,
usually inside a dependency the porting developer does not control. **A94 is now resolved**
(Route A, `ipcRenderer.sendSync`) -- what is left is landing it: the ADR and the Phase 1
contracts PR, neither of which has reached this tree yet.

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
| 1 | No grant exists in production | Build step 4's prompt | Already scheduled; unblocks *everything* |
| 2 | ~~No `orivon.id.*` entry point~~ -- **closed by #112**: broker, transport and preload wired, e2e-verified (`test/e2e-id-capability.test.ts`) | `id.requestIdentity` (named identities, `window.nostr`) is separate and still open | A111 |
| 3 | CORS blocks tier-1 and tier-2 HTTP | **Superseded by A98 (resolved):** route the page's own `fetch()` through the secure-connect capability for granted hosts, rather than reimplementing HTTP in the shim | Contracts change, decided; same unwritten ADR as row 8 -- ordering unaffected until it lands |
| 4 | ~~No `net.listen`~~ (broker) -- **closed by #109**: real accepted-socket handles, the unsigned-app port rules and a revocation cascade, unit-tested | **Still open: no page wiring**, deliberately deferred pending a nested-port-delivery design | Small -- wire `orivon-surface.ts`/`main-world-socket.ts` the way `net.connect`/`udpBind` already are, once that design exists |
| 5 | ~~Provisional `fs.*` signatures~~ -- **A12 resolved 2026-09-09** (owner: byte-oriented, no encoding option, exactly as implemented) | Land the Phase 1 contracts PR that removes the PROVISIONAL markers | Contracts change, decided; not yet landed in this tree |
| 6 | ~~Sync `fs` undecided~~ -- **A94 resolved 2026-09-09** (owner: Route A, `ipcRenderer.sendSync`) | Land the ADR, then the contracts PR, before step 3 designs `fs` | Contracts rule 2 narrowed to `net` only; decided, not yet built |
| 7 | ~~No `electron` module shim~~ -- **closed by #108**: `src/shim-electron/` built as its own package (A95's resolution) | `dialog.showOpenDialog` still refuses pending `fs.userSelected` (row 5-adjacent) | See Table 2 and Table 3's `electron module` row |
| 8 | ~~TLS absent from contracts~~ -- **A96 resolved 2026-09-09**: Orivon terminates TLS itself via a new capability, not a JS TLS stack over `net.connect` | Land the same unwritten ADR as row 3 ("Orivon owns the app's HTTP(S) path") | Contracts change, decided; blocked only on ADR authorship |
| 9 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly |
| 10 | `hid`/USB -- wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 11 | Native addons in dep trees | Substitute per library -- Table 5 | Per-app, not per-platform |
| 12 | Tier 3 -- no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |
| 13 | App logic is not JavaScript | Nothing works today, WASM included | Blocked upstream: Go has no wasip2, wasi-sdk has no target with threads AND sockets |

Rows 1-4 are where the reach is. **Still unfiled** as of 2026-09-10: rows 9 and 11, plus
declarability (what a grant prompt can honestly say for runtime-chosen hosts) and per-syscall
IPC cost on a chatty workload. Row 8 is filed and resolved (A96) since the last pass.

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
