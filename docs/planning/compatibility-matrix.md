# App compatibility matrix

**What is wired up right now, and the cheapest next lever.** Derived 2026-09-09 by reading the
tree. [`../architecture/app-compatibility.md`](../architecture/app-compatibility.md) owns *why
the tiers exist*; this file owns *what works today*. If they disagree, that one is the design
and this one is stale.

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
| `net.listen` (TCP in) | ✅ | ❌ | ❌ | ❌ | Specified incl. the unsigned-app rules; not built |
| `fs.readFile` / `writeFile` | ✅ | ✅ | ✅ | ❌ | Confined to app dir |
| `fs.open/mkdir/readdir/stat/rm/rename` | ⚠️ | ❌ | ❌ | ❌ | Signatures marked PROVISIONAL in the contract (A12) |
| `fs.userSelected` (picker) | ✅ | ❌ | ❌ | ➖ | The only route outside the app dir. Backs `dialog.*`, not a Node API |
| `id.publicKey` / `sign` | ✅ | ❌ | ❌ | ➖ | Derivation built in `policy/derive*.ts`; **no entry point**. Backs `window.nostr` -- see Table 2 |
| `id.requestIdentity` | ✅ | ❌ | ❌ | ➖ | Needs the connect prompt |
| `app.manifest` / `grants` | ✅ | ✅ | ❌ | ➖ | Broker-side only. Backs Electron's `app.*` -- see Table 2 |
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
present a familiar interface on top. There are three such layers, not one, and only the first
is what `src/shim/` currently claims.

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | `net`, `dgram`, `fs`, `Buffer`, `stream`... | `net.*`, `fs.*` | ❌ build step 3, not started |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog` | `app.*`, `fs.userSelected` | ❌ **unaccounted for** -- A95 |
| **Web ecosystem** | `window.nostr` (NIP-07); later `window.ethereum` | `id.*` | ✅ built ([`nip07.ts`](../../src/nostr/nip07.ts)), not wired into a page |

**The `electron` family is the one nothing in the repo accounts for**, even though tier 2 is
*defined* as Electron apps and `require('electron')` is their guaranteed first import. What it
needs:

| Electron API | What backs it |
|---|---|
| `app.getPath('userData')` | the app's sandbox directory root |
| `app.getVersion()` | `orivon.app.manifest()` |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` |
| `ipcRenderer.invoke` / `ipcMain.handle` | **a local message bus** -- both halves of the app are inside Orivon, so no capability is involved at all |
| `BrowserWindow`, `Menu`, `Tray` | the desktop-shell row in Table 3; largely out of scope |

## Table 3 -- the runtime environment (ability)

**What the app is capable of doing in the browser environment.**

This is the half the 2026-08-25 correction called *"the capability-backed part is the small
part"*. [`src/shim/`](../../src/shim/) holds `globals.ts`, a README and tests, nothing more --
and [its own README](../../src/shim/README.md) declares its scope as exactly `net`, `dgram` and
`fs`, which is **narrower than Table 2's `net, dgram, fs, Buffer, stream...`**. That gap is why
row 2 below is `dup` and yet owned by nobody.

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
| `Buffer`, `stream`, `events`, `path`, `os`, `crypto` | `dup` | everything | ❌ missing | Standard browser polyfills; pure JS, cheap. **Unowned:** inside Table 2's `...`, outside the shim README's declared three modules |
| `net` / `dgram` / `fs` Node shapes | `dup` | every ported app | ❌ missing | Step 3 -- the shim proper, over Table 1 |
| Synchronous `fs` (`readFileSync`) | **`needs T1`** | ported apps, at startup | ⚠️ **undecided** | Table 1 is async by construction, and no JavaScript turns a pending promise into a returned value on the same call stack. Needs a *mechanism*, not a function: `ipcRenderer.sendSync`, or `Atomics.wait` in a Worker, which moves where app code runs. Contradicts `capability-api.md` design rule 2. **A94** |
| `electron` module | `dup` | every tier-2 app | ❌ missing | Table 2, family 2. **A95** |
| HTTP client | `dup` | trackers, web seeds, any REST | ❌ missing | Renderer `fetch` is **CORS-bound**. Plain HTTP is buildable over `net.connect` today; `https` is not -- see the next row |
| TLS / `https` | **`needs T1`** | nearly every app | ❌ **absent from contracts** | `orivon.net` gives raw TCP only. Either a new Table 1 capability, or a JS TLS stack over `net.connect` -- the second route would reclassify this row `dup`, which is exactly the undecided part. Unfiled |
| `worker_threads` | `dup` | validation-heavy work | ❌ missing | Web Workers are already in the renderer, so the substrate exists and no Table 1 entry is needed; the shape does not match and a shim cannot fully fake it. A fidelity problem, not a substrate one |
| Background lifetime | **`outside`** | seeding, syncing, pinning | ⚠️ **unspecified** | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Shell holds the process, contracts describe it, UI shows it. `mvp-scope.md` counts `backgroundSec` in the metric but nothing grants it |
| Ambient FS (`~/.bitcoin`) | **`outside`** | migrating an installed app | 🚫 excluded by design | A refusal, not a gap. `fs` is rooted; `userSelected` is a picker, not a mount |
| Desktop shell (tray, autostart, protocol handlers, hotkeys) | **`outside`** | Electron apps' outer half | ❌ missing | Shell-side. Table 2's own Electron sub-table marks these out of scope rather than covering them |
| Native addon in the dep tree | **`outside`** | see Table 5 | ❌ missing | Per-library substitution, not a platform feature. Pure-JS/WASM substitute, or a helper process |

**Six `dup`, two `needs T1`, four `outside`.** So completing Tables 1 and 2 leaves six rows
open, and only two of them are anywhere near the shim.

**Synchronous `fs` is the one to settle first, and `needs T1` is why:** it is not a missing
function, it is a missing mechanism, so no amount of shim effort reaches it. A ported app fails
at *startup*, not under load -- `readFileSync` is how Node programs read their own config,
usually inside a dependency the porting developer does not control. Settling **A94** before step
3 designs `fs` costs a conversation; discovering it mid-shim costs a rewrite of where app code
runs.

**Of the four `outside` rows, only background lifetime is a gap.** Ambient FS and the desktop
shell are deliberate boundaries, and native addons are per-library (Table 5). Background
lifetime is unfiled, touches the success metric directly, and is the one row here that finishing
every other table would leave exactly where it stands -- Table 4 row 9.

## Table 4 -- blockers, and the cheapest lever for each

Ordered by reach per unit of effort. **The ordering is an AI recommendation, not a schedule** --
only rows 1 and 9 are owned by anything today.

| # | Blocker | Cheapest lever | Cost shape |
|---|---|---|---|
| 1 | No grant exists in production | Build step 4's prompt | Already scheduled; unblocks *everything* |
| 2 | No `orivon.id.*` entry point | Wire the built derivation to a broker method | Small -- logic exists, `nip07.ts` waiting |
| 3 | CORS blocks tier-1 and tier-2 HTTP | HTTP over `net.connect`, in the shim | Medium, pure JS -- but blocked on TLS |
| 4 | No `net.listen` | Build it | Spec'd already, incl. unsigned-app rules |
| 5 | Provisional `fs.*` signatures | Settle A12 | **Contracts change -- own PR, merges first** |
| 6 | Sync `fs` undecided | Settle A94 before step 3 designs `fs` | Contracts rule 2; Route B moves where app code runs |
| 7 | No `electron` module shim | Settle A95's scope | Step 3 scoping; `src/shim/` claims only `net`/`dgram`/`fs` today |
| 8 | TLS absent from contracts | Decide raw-TCP+JS-TLS vs a broker capability | Contracts change. Silently blocks step 3's `https` |
| 9 | No background lifetime | Unfiled; needs a decision first | Contracts + shell; touches the metric directly |
| 10 | `hid`/USB -- wallet cluster | `orivon.hid.*` + device chooser | Contracts + prompt UX + security argument |
| 11 | Native addons in dep trees | Substitute per library -- Table 5 | Per-app, not per-platform |
| 12 | Tier 3 -- no HTML frontend | Container + xpra ([doc](container-apps-opportunity.md)) | Parked; reopens `subprocess` in a narrow shape |
| 13 | App logic is not JavaScript | Nothing works today, WASM included | Blocked upstream: Go has no wasip2, wasi-sdk has no target with threads AND sockets |

Rows 1-4 are where the reach is. **Still unfiled** as of 2026-09-09: rows 8, 9, 11, plus
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
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker` -- a function that exists but isn't returned is not reachable |
| Table 1, Page | `grep -n "call('" src/preload/orivon-surface.ts`, plus `src/preload/main-world-socket.ts` for what the main-world wrapper builds. The e2e test is the only proof a real page can call it |
| Table 1, Node shim | `ls src/shim/` |
| Table 2 | Node family: `src/shim/`. Electron family: nowhere yet. Web family: `src/nostr/` |
| Table 3, Status | Mostly absence -- verify by looking for the module, not for a mention of it |
| Table 3, Class | Not observable in the tree; derived. `dup` if Table 2's families name the surface at all, `needs T1` if they do but Table 1 has no entry the adapter could be built on, `outside` if no Node/`electron`/web API expresses the problem. Re-derive the row when Table 1 or the shim README's declared scope changes -- not when a status flips |
| Table 4 | When a row closes, replace it with a one-line note naming the PR rather than deleting it |
| Header date | Update it whenever a cell changes, and say which cells changed |

**Do not let this grow into a second copy of `app-compatibility.md`.** If an entry starts
explaining *why a tier exists*, it belongs there.
