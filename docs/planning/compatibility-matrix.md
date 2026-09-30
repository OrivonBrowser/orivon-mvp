# Compatibility matrix

**What is wired up right now, and the cheapest next lever, across apps, extensions and the
browser around them.** [`../architecture/app-compatibility.md`](../architecture/app-compatibility.md)
owns *why the tiers exist*; this file owns *what works today*. If they disagree, that one is the
design and this one is stale.

**This page is the entry; the rows of Tables 1, 2, 3 and 5 are in [`compatibility/`](compatibility/),
one file per sub-table.** Each table below keeps its definition and an index with a tally per
sub-table. Tables 4, 6, 7 and 8 are whole on this page.

**Five contract entries have no implementation behind them:** `id.requestIdentity`, `protocols`,
`media.camera` and `media.microphone`, `clipboard.read`, and reopening a picked path. Two more
stop short of the page: `FileHandle.readable()`/`writable()`, and the `closed` promise of a file or
folder handle. Every other member of `orivon.*` is built Spec'd → Broker → Page. `hid` and
`subprocess` are excluded from v0.

**An app qualifies by running in the Node environment, not by being JavaScript**
([`ADR-0036`](../decisions/ADR-0036-an-app-qualifies-by-running-in-the-node-environment.md)):
WebAssembly runs in an app exactly as it runs in Node. Every gap in these tables is a limit of this
build, taken case by case as a real app reaches it, never a rule about which apps may exist.

Two axes, and they fail in completely different ways:

- **Table 1 is authority**: what is an app *allowed* to do. Missing it, the app runs and every
  privileged call returns `'denied'`.
- **Tables 2 and 3 are ability**: can the app's code *execute* at all. Missing it, the app is
  allowed to do everything and crashes on line 1.

**Table 3 is not a third axis.** It is an inventory over ground Table 2 already covers, at a
finer grain: many of its rows are Table 2's families itemised member by member, and closing one
closes the other: the same item, listed twice, not two blockers. Its `Class` column says which rows
are that duplication and which are genuinely elsewhere. **Completing Tables 1 and 2 closes every
`dup` row automatically**; the `needs T1` and `outside` rows survive it, and the `outside` ones were
never shim work.

## How Tables 1 to 3 are filled

A table that gains a row each time a port trips over something says "built" for what has been
tried and nothing about the rest. These tables are filled the other way round. Each sub-table takes
its rows from a list that exists whether or not any app has reached it, and gives every item of
that list a row, or a named place in one.

| Sub-table | The list it enumerates |
|---|---|
| 1a | every member of [`src/contracts/`](../../src/contracts/): methods, handles, capability kinds, limits, error codes, manifest fields |
| 1b | fourteen classes of authority an app can need on a computer, from the network to updates |
| 2a | Node 24's `builtinModules`: 72 specifiers |
| 2b | the 48 value exports of `require('electron')` in Electron 44's typings, the classes they reach, and the `<webview>` element |
| 2c, 2d | the helper packages apps reach Electron through; the providers a page expects injected |
| 3a | Node 24's global names and every own member, event and environment key of `process` |
| 3b | the module-scope names, `import.meta`, package conditions, the manifest's fields, the loader's MIME table and limits |
| 3c to 3g | every export of the Node modules in that area, with the options and behaviours of each |
| 3h | the CSP directives, response headers, storage kinds, worker kinds and frame kinds |
| 3i | the page-lifecycle events, Electron's `app` lifecycle, window operations, the shell's own shortcuts |
| 3j | every permission string and device hook in Electron's typings |
| 3k | the transport primitives, and the protocol stacks built on them |
| 5 | the native packages apps depend on, by family |

A gap that has a row is an ordinary state. An item with no row is the defect, and
[Table 6](#table-6-how-to-update-this) has the command that regenerates each list, so the two can
be compared.

**Status.** ✅ built | ⚠️ partial or differs | ❌ missing | 🚫 excluded by design | ➖ not
applicable. `⚠️ differs` marks the dangerous case: the call runs without an error and behaves
unlike Node or Electron.

**How a gap shows to the app's code**, in the four phrases the rows use:

- *refuses by name*: the member exists and throws a named `OrivonShimError` or `ElectronShimError`
  when called. Feature detection (`typeof x === 'function'`) still says it is there.
- *reads `undefined`*: the member is absent, and calling it is a bare `TypeError`.
- *fails the build*: the app's bundler rejects the import.
- *differs*: a result comes back, and it is not the one Node or Electron gives.

**How often a need occurs.** A "Used by" figure, or "N of 80" and "N of 56" in a row, comes from a
source-text search over 80 open-source Electron apps and over the server code of 56 Node apps that
serve a web front end. Each is an upper bound from pattern matching. It says how common a need is,
never that a given app runs.

## Table 1: the capability surface (authority)

**What an app is allowed to do, and what nothing yet allows.** One file:
[`compatibility/table-1-capabilities.md`](compatibility/table-1-capabilities.md). Table 1a holds
the capabilities that exist; Table 1b holds every other authority an app can need on a computer,
by class, with the gate's answer where a web API is the route and the layer an answer would land
in where nothing is.

**Spec'd** = in [`src/contracts/`](../../src/contracts/) | **Broker** = implemented in
[`src/broker/`](../../src/broker/) and reachable from `createBroker` | **Page** = reachable from
`window.orivon` | **Node shim** = a Node-shaped equivalent in [`src/shim/`](../../src/shim/).
A cell holds ✅, ⚠️, ❌, 🚫 or ➖ as the legend above says; a row whose route is a web-platform API
has ➖ in all four and a note that starts "Web platform:".

| Part | What it holds | Rows |
|---|---|--:|
| [1a](compatibility/table-1-capabilities.md#table-1a-what-orivon-offers) | Every member of `orivon.*`, every capability kind, the pattern grammars, every limit and error code, and the manifest fields that change what an app may do | 52 |
| [1b](compatibility/table-1-capabilities.md#table-1b-authority-no-capability-covers) | Authority no capability covers. Network out | 25 |
|  | Network in | 10 |
|  | Name resolution and network state | 8 |
|  | Files | 19 |
|  | Processes and code | 10 |
|  | Identity and secrets | 12 |
|  | Devices | 13 |
|  | System information | 11 |
|  | Desktop integration | 15 |
|  | Windows and embedding | 12 |
|  | Lifetime | 6 |
|  | Storage | 6 |
|  | Updates and distribution | 6 |
|  | Money and accounts | 4 |

**Only prefixes of ✅ are legal** across Spec'd, Broker and Page: a call travels in that order, so a
cell is never better than the one before it. Table 1a's own page states the rule in full, and
what is proven end to end.

## Table 2: the four adapter families

An app never calls `orivon.*` directly unless it was written for Orivon. Something has to present a familiar interface on top. There are four such layers. Table 2a covers the Node stdlib family module by module, Table 2b the `electron` module export by export, Table 2c the packages that wrap Electron, and Table 2d the web-ecosystem providers.

| Family | What it presents | Backed by | Status |
|---|---|---|:--:|
| **Node stdlib** | The 72 specifiers of Node 24's `builtinModules`. [`module-map.ts`](../../src/shim/module-map.ts) maps 40 of them (`net`, `dgram`, `fs`, `http`, `https`, `tls`, `buffer`, `stream`, `tty`, `process`, `node:sqlite`...) and leaves 32 unmapped | `net.*`, `fs.*`, `orivon.net.lookup`, npm polyfill packages, hand-written modules, Web Workers, the web platform | ⚠️ partial: none of the 40 mapped modules has every Node 24 export behaving as Node's (36 partial, 4 differ), and the 32 unmapped ones are `❌ missing`. An unmapped specifier is left to the app's own bundler. A mapped module resolves under its `node:` name in Vite and in the esbuild plugin (`node:sqlite` only under that name, since the bare `sqlite` is another npm package); webpack 5 needs a plugin that strips the scheme. **Named refusals, by design:** `net.Server#listen` and `dgram` `bind` on one address that is neither loopback nor every interface, `FileHandle#createReadStream`/`createWriteStream` (A184), `tls` STARTTLS and a prebuilt `secureContext` (A226), `https.createServer` (no TLS listener), WASI links, file times and sockets, and every other `dns.*`/`net.*` member the shim has not decided on. Table 2a has every module |
| **`electron` module** | `app`, `ipcRenderer`/`ipcMain`, `dialog` | `app.*`, `fs.userSelected` | ⚠️ partial, in [`src/shim-electron/`](../../src/shim-electron/): of the 48 value exports of `require('electron')`, none is built; 4 are partial (`app`, `ipcMain`, `ipcRenderer`, `safeStorage`), 1 differs (`nativeTheme`), 18 refuse by name and 25 are absent. Table 2b has every export |
| **Web ecosystem** | `window.nostr` (NIP-07), `window.ethereum` | `id.*` | ❌ missing: no page receives either. [`nip07.ts`](../../src/nostr/nip07.ts) builds the NIP-07 object against a stub signer, and wiring it into a page needs `id.requestIdentity` (A111). `window.ethereum` is not built. A wallet extension can inject one in a granted, network-served tab ([ADR-0044](../decisions/ADR-0044-a-grant-no-longer-gives-an-origin-its-own-session.md)). Table 2d has every provider |
| **The app's own preload surface** | whatever that app's preload exposed -- `window.ftElectron` for FreeTube | any capability its calls happen to map to | ➖ **Not Orivon's to ship.** One file per ported app, living with the app |

### How a port gets these families

The alias table [`module-map.ts`](../../src/shim/module-map.ts) and the [`src/shim-electron/`](../../src/shim-electron/) package are consumed by this repository's own renderer build ([`electron.vite.config.ts`](../../electron.vite.config.ts)). For Node modules an esbuild plugin, [`bundler/esbuild-plugin.ts`](../../src/shim/bundler/esbuild-plugin.ts), applies the alias table to a port's own build: it maps every row to the shim under `platform: 'node'`, fails the build on a Node builtin the shim has no row for, and ships the SQLite engine's files. No package publishes it, `package.json` is private, and a port locates this checkout with `ORIVON_MVP_ROOT`. The Lounge's server bundles with the plugin, and its client imports no builtin. The other four ports in `orivon-ports` apply neither the plugin nor the alias table. Each bundles with its own polyfills or with empty stubs: FreeTube's build sets `resolve.fallback` to `false` for eleven modules (`fs`, `path`, `stream`, `crypto`, `http`, `https`, `zlib`, `url`, `net`, `tls`, `child_process`), all of which the shim maps; ASGARDEX uses `process/browser`, `stream-browserify`, `crypto-browserify` and `assert`, and empties `path`, `url`, `https`, `http`, `zlib` and `fs`; Element empties `fs`, `net`, `tls` and `crypto` and takes `events` and `util` from npm; AirGap Vault takes `path`, `stream`, `crypto`, `http`, `https` and `zlib` from `path-browserify`, `stream-browserify`, `crypto-browserify`, `stream-http`, `https-browserify` and `browserify-zlib`. No renderer of the five imports `electron`. So the shim is consumable as an esbuild plugin only: no webpack or Vite preset of the alias table with the `installGlobals` entry exists, and the other four ports do not use the plugin. Whether they should bundle against the shim instead is A313.

| Sub-table | What it holds | Rows | ✅ | ⚠️ | ❌ | 🚫 | ➖ |
|---|---|--:|--:|--:|--:|--:|--:|
| [2a](compatibility/table-2a-node-modules.md) | Node's standard library, one row per builtin specifier, with a "Used by" column from the app scans | 60 | 0 | 40 | 20 | 0 | 0 |
| [2b](compatibility/table-2b-electron.md) | The `electron` module, one row per export and per group of members, with a "Used by" column | 177 | 12 | 22 | 123 | 19 | 1 |
| [2c](compatibility/table-2b-electron.md#table-2c-packages-that-wrap-electron) | Packages that wrap Electron (`electron-store`, `electron-updater`, `keytar` and others) | 28 | 1 | 9 | 18 | 0 | 0 |
| [2d](compatibility/table-2b-electron.md#table-2d-web-ecosystem-providers) | Providers a page expects injected (`window.nostr`, `window.ethereum`, wallet discovery) and the app's own preload surface | 15 | 1 | 4 | 6 | 0 | 4 |

## Table 3: the runtime environment (ability)

**What the app is capable of doing in the browser environment.** The capability-backed part is
the small part.

**`Class` answers one question: if I complete Tables 1 and 2, is this row still open?**

- **`dup`**: **no.** This row *is* Table 2 at a finer grain. Implement it there and it closes
  here. Pure shim work: write JavaScript in `src/shim/`, no decision needed first.
- **`needs T1`**: **yes**, until Table 1 grows an entry it does not have. The adapter sits
  inside Table 2's family, but there is nothing underneath to build it on, so the work lands in
  [`src/contracts/`](../../src/contracts/): own PR, merges first.
- **`outside`**: **yes.** Neither table covers it. No Node module, `electron` call or web API
  expresses the problem, so no amount of shim work touches it.

| Sub-table | What it holds | Rows | ✅ | ⚠️ | ❌ | 🚫 | ➖ |
|---|---|--:|--:|--:|--:|--:|--:|
| [3a](compatibility/table-3a-globals-and-process.md) | Globals and `process`: every Node global, every `process` member, event and environment key, where the globals exist, timers, detection idioms | 107 | 23 | 45 | 34 | 3 | 2 |
| [3b](compatibility/table-3b-modules-and-delivery.md) | Module system, bundling and delivery: `require` and `import.meta`, package conditions, aliases, the manifest, MIME types, limits, routing, the first visit, the delivery modes compared | 73 | 21 | 35 | 13 | 4 | 0 |
| [3c](compatibility/table-3c-files.md) | Files: every `fs`, `fs.promises`, `FileHandle`, `Stats` and `fs.constants` member, `path`, `os`, path semantics and bounds | 98 | 7 | 61 | 29 | 1 | 0 |
| [3d](compatibility/table-3d-network.md) | Network: `net`, `dgram`, `dns`, `tls`, `http`, `https`, `http2`, and the page's routed `fetch`, `XMLHttpRequest`, `EventSource`, `WebSocket` | 102 | 19 | 67 | 16 | 0 | 0 |
| [3e](compatibility/table-3e-crypto-compression-buffers.md) | Crypto, compression and buffers: every `crypto` export and algorithm family, `zlib`, `Buffer` | 80 | 15 | 44 | 21 | 0 | 0 |
| [3f](compatibility/table-3f-streams-events-utilities.md) | Streams, events, utilities, timers and `assert` | 38 | 2 | 26 | 10 | 0 | 0 |
| [3g](compatibility/table-3g-running-code.md) | Running code: `child_process`, `worker_threads`, `cluster`, `vm`, `module`, WASI preview1 and 0.2, Node-API, WebAssembly engine features and toolchains | 135 | 14 | 93 | 23 | 5 | 0 |
| [3h](compatibility/table-3h-the-page.md) | The page: origin, every CSP directive, response headers, cookies and storage, workers and frames, `navigator` | 69 | 19 | 36 | 2 | 6 | 6 |
| [3i](compatibility/table-3i-windows-and-lifecycle.md) | Windows, lifecycle and the desktop around the app: the main process, windows and tabs, quit signals, throttling, background lifetime, shortcuts the browser takes, menus, dialogs, drag and drop, packaging assumptions | 63 | 6 | 26 | 23 | 8 | 0 |
| [3j](compatibility/table-3j-permissions-devices-secrets.md) | Permissions, devices, identity and secrets: every permission string and device hook, WebAuthn, the keyring | 52 | 9 | 10 | 23 | 8 | 2 |
| [3k](compatibility/table-3k-protocol-stacks.md), primitives | The network primitives a protocol can need | 58 | 14 | 27 | 14 | 3 | 0 |
| [3k](compatibility/table-3k-protocol-stacks.md), stacks | Protocol stacks (peer-to-peer, blockchains, anonymity networks, messaging and mail, databases and services, home and media devices, sign-in), each with the primitives it needs | 163 | 67 | 60 | 34 | 2 | 0 |

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
| 14 | Four of the five ports in `orivon-ports` do not bundle against the Node shim: the alias table and the page globals reach a port only through an esbuild plugin ([`bundler/esbuild-plugin.ts`](../../src/shim/bundler/esbuild-plugin.ts)) that The Lounge's server uses, so each of the others brings its own polyfills or empties the modules, and what Tables 2 and 3 say the shim offers reaches only that one port | A preset for each other bundler the ports use, webpack among them: the aliases of [`module-map.ts`](../../src/shim/module-map.ts), the `node:` handling webpack needs, and the globals entry; each port moved over when it is next touched | Shim + `orivon-ports`; A313 (owner) |
| 15 | 32 of Node's 72 builtin specifiers have no alias row, so an import fails the build or yields an empty object ([Table 2a](compatibility/table-2a-node-modules.md)) | An alias row with an honest answer for each cheap one: `assert/strict`, `sys`, `punycode`, `stream/web`, `stream/consumers`, `path/win32`, `constants`, and an inert `cluster` stub | Shim only |
| 16 | A missing member does not always refuse by name: `process` (the global, which `require('process')` returns), the `electron` package's `app` and IPC objects, the unwrapped `stream` and `events` packages, 15 `dgram.Socket` members, the subpath modules' named exports, and data members typed as functions | Wrap each with the refusal the other modules already use (`refusingProxy`, generated stand-ins), and give data members real values | Shim only; A310 |
| 17 | Options a shim function accepts and never reads change the result with no error ([Tables 3c](compatibility/table-3c-files.md) to [3e](compatibility/table-3e-crypto-compression-buffers.md)) | Refuse by name where the option changes the result, warn once where it does not | Shim only; A311 |
| 18 | Calls a ported Electron app makes at start-up throw: `app.on`, `app.requestSingleInstanceLock`, `app.commandLine.appendSwitch`, `Menu.setApplicationMenu`, `crashReporter.start`, `powerMonitor.on`, `new Tray` ([Table 2b](compatibility/table-2b-electron.md)) | Inert answers for lifecycle and desktop calls that mean nothing in a tab, refusals kept for calls whose result the app relies on | Shim only (`src/shim-electron/`) |
| 19 | A peer on the local network is reachable only by an address literal written in the manifest: no LAN-scoped pattern ([Table 3k](compatibility/table-3k-protocol-stacks.md) ranks it first) | A local-network connect pattern, asked as its own grant | Contracts + broker policy + prompt UX |
| 20 | No UDP multicast or broadcast: mDNS, SSDP, UPnP port mapping and LAN discovery cannot run | A multicast grant naming the group and port | Contracts + broker + adapters |
| 21 | No TLS upgrade of an open socket (STARTTLS): PostgreSQL and MySQL with TLS, SMTP on 587, IMAP on 143, XMPP, LDAP | Upgrade a connected socket on the trusted side, with the grant check the upgrade needs | Contracts + broker; A226 |
| 22 | `http2` loads and every function refuses by name, so a gRPC client cannot connect | An HTTP/2 client in the shim over `net.connectSecure`, whose `alpnProtocols` option can ask for `h2` | Shim only |

Rows 1 and 2 are the top of the list: neither needs anything but the work itself or one
confirmation. Row 6 sits behind them despite touching the metric, because it needs
a decision before it is even build-shaped. Rows 14 to 22 are the widest gaps the enumeration
of Tables 1 to 3 exposed, listed after rows 1 to 11 rather than ranked among them; rows 15 to 18
and 22 are shim work with no decision first. **Unfiled:** rows 6 and 7, row 8's camera and
microphone half, rows 15, 18, 19, 20 and 22, plus declarability (what a grant prompt can honestly
say for runtime-chosen hosts) and per-syscall IPC cost on a chatty workload.

## Table 5: the native-module question, per library

*Which native packages have an answer on Orivon, and what each answer needs.* The rows, one per
package, are in [`compatibility/table-5-native-modules.md`](compatibility/table-5-native-modules.md).
Native machine code never runs for an app
([ADR-0040](../decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)): an addon
loads as its own WebAssembly build through [`src/shim/addon/`](../../src/shim/addon/), or the
app's bundler swaps the package for a JavaScript or WebAssembly one that the table names.

| Family | Rows | ✅ | ⚠️ | ❌ | 🚫 |
|---|--:|--:|--:|--:|--:|
| Databases and storage | 14 | 0 | 12 | 2 | 0 |
| Cryptography and secrets | 17 | 15 | 0 | 2 | 0 |
| Compression and encoding | 14 | 10 | 4 | 0 | 0 |
| Media, graphics, audio and machine learning | 17 | 7 | 9 | 1 | 0 |
| System and devices | 29 | 3 | 5 | 12 | 9 |
| Networking | 14 | 2 | 6 | 4 | 2 |
| Build tools shipped at run time | 14 | 10 | 1 | 1 | 2 |

## Table 6: how to update this

Check the code, do not trust the tables above.

| Cell | Recipe |
|---|---|
| Table 1, Spec'd | Read [`capability-api.ts`](../../src/contracts/capability-api.ts). A PROVISIONAL doc comment means ⚠️, not ✅ |
| Table 1, Broker | `grep -n "async function" src/broker/index.ts`, **then** check the object returned by `createBroker`: a function that exists but isn't returned is not reachable. The broker is split: `net`'s five entry points (`connect`/`connectSecure`/`udpBind`/`listen`/`lookup`) live in `capabilities/net.ts`, `fs`'s nine (including `open`) in `capabilities/fs.ts`, and `id`'s two in `capabilities/id.ts`, each returned from its own factory and re-exported through `createBroker`'s own returned object, so check those files too, not just `index.ts` |
| Table 1, Page | `grep -n "call('" src/preload/surface/orivon.ts`, plus `src/preload/surface/main-world-socket.ts` for what the main-world wrapper builds. A real-Electron e2e test is the strongest proof a real page can call it; where none exists, a test exercising the real `installOrivon` wiring rather than a hand-built stub is the fallback: weaker, but still a real dispatch/preload path, not just a file that exists |
| Table 1, Node shim | `ls src/shim/` |
| Table 1a, the list | Every `interface`, method and `type` in [`src/contracts/`](../../src/contracts/): `grep -nE "^export (interface\|type\|const)\|^  [a-zA-Z]+\??[(:]" src/contracts/*.ts`. `CapabilityKind` in `manifest.ts` and `LIMITS` in `limits.ts` are closed lists: count them |
| Table 1b | No mechanical list. Walk the fourteen class headings and ask, for a new kind of app, which authority it needs that has no row. A row leaves 1b for 1a when a capability covers it |
| Table 2a, the list | `node -p "require('module').builtinModules.join('\n')"` on the Node line Electron bundles (`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -p process.versions.node`). Every specifier has a row. A module's counts: `node -p "Object.keys(require('<m>')).length"` against the module's `generated/<name>.ts`, which lists each member that refuses |
| Table 2b, the list | The `const` declarations of `namespace CrossProcessExports` and the classes of `namespace Main` in `node_modules/electron/electron.d.ts`. What the package exports: `grep -n "^export" src/shim-electron/index.ts`. A member that is not wrapped by `refusingProxy` reads `undefined` |
| Table 2c, 2d | The helper packages in a port's `package.json`; [`src/nostr/`](../../src/nostr/) and the preload for providers |
| Table 3a, the list | `node -p "Object.getOwnPropertyNames(globalThis).length"` and `node -p "Object.getOwnPropertyNames(process)"`; what the shim installs is [`globals.ts`](../../src/shim/globals.ts) and [`globals-types.ts`](../../src/shim/globals-types.ts) |
| Table 3b | [`manifest.ts`](../../src/contracts/manifest.ts) for the fields, [`content-type.ts`](../../src/loader/serve/content-type.ts) for the MIME table, [`path.ts`](../../src/loader/serve/path.ts) for routing; module-system rows are measured by bundling a two-line entry with each bundler |
| Tables 3c to 3g | As Table 2a, per module, then the module's own files under [`src/shim/`](../../src/shim/). An option that a function accepts and never reads is a `differs` row: grep the option name in the implementing file |
| Table 3h | [`csp.ts`](../../src/loader/serve/csp.ts) and [`granted-origin-csp.ts`](../../src/main/install/granted-origin-csp.ts) for every directive; [`asset.ts`](../../src/loader/serve/asset.ts) for every header |
| Table 3i | [`src/main/shell/`](../../src/main/shell/) and [`src/main/shortcuts/`](../../src/main/shortcuts/); a behaviour with no e2e test says "not measured" |
| Table 3j, the list | The permission union of `setPermissionRequestHandler` in `electron.d.ts`, against [`permission-gate.ts`](../../src/main/sessions/permission-gate.ts): every string has a row |
| Table 3k | The primitives are Table 1's network rows; a stack's status is the weakest primitive it needs |
| Index tallies on this page | Count the rows of each sub-table by the status emoji in its status column (`Status`, `This package`, `On Orivon` or `Verdict`); the first emoji in the cell is the row's status. A tally that disagrees with its file is stale |
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
| `commands` | ⚠️ | `getAll` lists each declared command with an empty shortcut; no key is ever registered, so `onCommand` never fires; no page to view or rebind a combination |
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
| `action` (MV3) / `browserAction` (MV2) | ✅ | Toolbar button, badge, title, icon, popup and `getUserSettings`, which always answers `isOnToolbar: true` |
| `alarms` | ✅ | `create` + `onAlarm` measured firing |
| `commands` | ⚠️ | `getAll` returns each command the manifest declares with an empty shortcut, and no key is registered, so `onCommand` never fires (measured; `vendor/electron-chrome-extensions/src/browser/api/commands.ts`) |
| `contextMenus` | ✅ | `create`/`remove`/`removeAll`/`onClicked` work; `update` is a no-op |
| `cookies` | ✅ | `get`/`getAll`/`set`/`remove`/`getAllCookieStores`/`onChanged`, gated on the `cookies` permission and per-URL host access |
| `devtools.inspectedWindow`, `devtools.network`, `devtools.panels` | ✅ | Native to Electron |
| `dns` | ⚠️ | `chrome.dns.resolve` exists as a real function, not exercised in measurement; dev-channel-only in real Chrome too |
| `downloads` | ⚠️ | Every method and event is a declared no-op stub; nothing downloads, cancels or reports |
| `extension` | ⚠️ | `isAllowedFileSchemeAccess`/`isAllowedIncognitoAccess` always answer `false`; `getViews` always `[]` |
| `i18n` | ⚠️ | `getMessage` resolves the real `_locales` string and `getUILanguage` returns the real UI language (measured: `en-GB`); `getAcceptLanguages` is not measured |
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
| `tabs` | ⚠️ | A rich working set, filtered by permission/host access; `pinned` comes from the tab's record and `audible` and `mutedInfo` from its page, but `update({ pinned, muted })` changes neither; `captureVisibleTab` specifically is not a function |
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
| i18n / `_locales` | ✅ | Name/description/icon resolution on the extensions page; `chrome.i18n` answers from Electron's own implementation (Table 7c) |
| Toolbar: pin/unpin, badge, icon, title | ⚠️ | Badge, icon and title work. There is no pin or unpin: `getUserSettings` always answers `isOnToolbar: true` and no pin control exists (measured) |
| Toolbar: enable/disable a button per tab | ✅ | `getState`/`activate` |
| Site access controls: "on click" / "on specific sites" / "on all sites" picker | ❌ | Not modelled; host access is all-or-nothing per the manifest's own declared patterns, decided once at install/update |
| Site access controls: `activeTab` (temporary grant on click) | ❌ | Treated like any other declared permission, not as a one-click temporary host grant |
| Incognito / private windows | ❌ | A private session loads no extensions at all; the `incognito` manifest key drives nothing |
| Updates from the Web Store | ✅ | Table 7a |
| Install from CRX/zip/unpacked | ✅ | Table 7a |
| Enabling/disabling/uninstalling | ✅ | Table 7a |
| Errors page | ❌ | Table 7a |
| Keyboard shortcuts page | ❌ | `chrome.commands.getAll` lists commands with empty shortcuts (Table 7c); no page to view or rebind a combination |
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
| Reload / stop | ✅ | `nav.reload`/`nav.hardReload`; the reload button becomes Stop while a tab loads (`nav.stop`, `src/renderer/chrome/reload-stop.ts`), and Escape in the page stops a load (`src/main/shell/signals/stop-key.ts`) |
| Home button | ✅ | A toolbar button (`toolbar.home`, off by default; `src/renderer/chrome/home-button.ts`) and `nav.home` (`Alt+Home`) open the home page in the current tab; a middle or Ctrl click opens a background tab |
| Omnibox: address-or-search classification | ✅ | `src/main/browsing/omnibox.ts`, refuses `javascript:`/`data:`/`file:`/`about:` typed in the bar |
| Search suggestions (live dropdown) | ❌ | No suggestion/autocomplete code for the address bar |
| History/bookmark autocomplete in the bar | ❌ | Omnibox is pure classification only |
| Default search engine choice | ✅ | Eight built-in engines (DuckDuckGo default), `search-engines.ts` |
| Custom search engines / keywords | ⚠️ | One custom template URL; no per-keyword multiple engines, no bang syntax |
| URL display / eliding | ⚠️ | Orivon's own plain `<input>`, not a Chromium omnibox; shows the literal full URL, only rewriting an internal `https://<name>.ipfs.orivon` address back to `ipfs://<name>` |
| Security indicator / padlock | ⚠️ | No padlock; a broader "Website Level" trust indicator (`src/trust/`) replaces it |
| Site info panel | ✅ | `src/main/permissions/site-info.ts`, `popover-view.ts`, `site-info-panel.ts` |
| Copy URL | ✅ | Native input field behaviour |
| Paste-and-go | ✅ | The address bar's context menu has Paste and Go: main reads the clipboard and the address form submits it as typed (`src/main/shell/paste-and-go.ts`, `chrome-context-menu.ts`) |
| QR code share of current page | ❌ | Not found |
| `view-source:` | ⚠️ | `page.viewSource` (`Ctrl+U`) and the page menu open `view-source:<address>` in a tab beside the page, for an http(s) page in an ordinary tab (`src/main/page-tools/view-source.ts`); typing it in the address bar is not recognised as an address |
| `data:` / `file:` typed in the address bar | 🚫 | `DANGEROUS_SCHEMES` refuses `javascript:`, `data:`, `file:`, `about:` typed or pasted |
| `file://` browsing (via a link, not typed) | ⚠️ | Treated as internal (loads directly); directory-listing behaviour is Chromium's own default, unverified without a launch |

### Tabs

| Feature | Orivon | Note |
|---|---|---|
| New tab | ✅ | `tab.new` (`Mod+T`) |
| Close tab | ✅ | `tab.close` (`Mod+W`) |
| Reopen last closed tab | ✅ | `tab.reopen` (`Ctrl+Shift+T`) puts back the last closed tab where it was, or the last closed window with its tabs; 25 entries, in memory (`src/main/session-restore/closed-stack.ts`, `reopen.ts`) |
| Restore previous session on launch | ✅ | `startup.mode` "Continue where you left off" reopens the windows in `session.json` (`src/main/startup/startup-plan.ts`); after a run that did not end cleanly a bar offers them back; a private session and a kiosk do neither |
| Pin tab | ✅ | `tab.pin` (unbound) and the tab menu; pinned tabs lead the strip, are 36px wide with no title or close button (`src/main/shell/tab-pin.ts`, `tab-order.ts`) |
| Mute tab | ✅ | `tab.mute` (unbound), the tab menu and the speaker badge on the tab; the mute belongs to the tab and follows it to another window (`src/main/shell/signals/audio.ts`) |
| Audio-playing indicator | ✅ | A speaker badge on the tab from `audio-state-changed`; a muted tab keeps it, and a pinned tab shows it as a mark on its icon (`src/renderer/chrome/tab-badges.ts`) |
| Duplicate tab | ✅ | `tab.duplicate` and the tab menu open a copy, with its back and forward list, right of its source; not offered for the new-tab page or a shell page (`src/main/shell/tab-commands.ts`, `tab-history.ts`) |
| Drag to reorder | ✅ | `tab-drag.ts`, `tab-order.ts`; a pinned tab stays in the leading run, and a split refuses a pinned tab |
| Tear off into a new window | ✅ | `tear-drag.ts` |
| Move tab to another open window | ✅ | `tab-menu.ts`, `tab-move.ts` |
| Tab groups (named/coloured) | ❌ | No grouping concept |
| Vertical tabs | ❌ | Tab strip is horizontal only |
| Tab search (Ctrl+Shift+A style) | ✅ | `tab.search` (`Ctrl+Shift+A`), More tools and the strip's button list every open tab of every window and the recently closed ones, filtered by title and address as you type (`src/main/tab-search/`, overlay `tab-search`) |
| Hover preview / thumbnail | ❌ | Not found |
| Tab discarding / memory saver | ❌ | No discard/suspend logic |
| Split view (two tabs side by side) | ✅ | `split-controller.ts`, `split-model.ts`, `split-frame.ts` |
| Close other tabs | ✅ | `tab.closeOthers` and the tab menu close every unpinned tab but the one chosen (`src/main/shell/tab-commands.ts`) |
| Close tabs to the right | ✅ | `tab.closeRight` and the tab menu close the unpinned tabs right of a tab, or of its split pair (`src/main/shell/tab-commands.ts`) |
| Next/previous tab, go to tab N | ✅ | `tab.next`/`tab.previous`/`tab.goto1..9`/`tab.gotoLast` |
| Open a link in a new tab (`target=_blank`, `window.open`) | ✅ | Every such request reaches `setWindowOpenHandler`; ctrl+shift+click and `target=_blank` open it in the foreground |
| Open a link in a background tab (keeps the current tab focused) | ✅ | A middle click or a plain ctrl+click opens a background tab; the current tab stays in front (`popups.ts`) |
| Open a link in a new window (Shift+click) | ✅ | Opens a real new window; a private window's shift+click opens a private window (`popups.ts`) |
| Middle-click a tab to close it | ✅ | `auxclick`/`mousedown` guard on each tab element |
| Middle-click the empty end of the tab strip to open a tab | ⚠️ | Linux X11 only (`docs/open-questions.md` A292) |
| Tab loading spinner | ✅ | `.loading` class on the favicon element |
| Tab title tooltip on hover | ✅ | Title, host, and whether the tab is playing audio, muted, in a split view or crashed (`src/renderer/chrome/tab-badges.ts`, `tab-crashed.ts`) |
| Tab close button appears on hover | ✅ | `.tab:hover .close`; a pinned tab has none, and an inactive tab too narrow for one shows none |
| Tab crashed indicator | ✅ | `src/main/shell/signals/crashed.ts` keeps the renderer's death on the tab; the strip shows a warning icon in place of the favicon and a tooltip line (`src/renderer/chrome/tab-crashed.ts`) |

### Windows and profiles

| Feature | Orivon | Note |
|---|---|---|
| Multiple windows | ✅ | `window-registry.ts` |
| Private/incognito window | ✅ | Empty-on-open, deleted-on-close session (`private-session.ts`) |
| Guest mode | ❌ | No guest-session concept distinct from a private window |
| Profiles | ✅ | `orivon://profiles`, `profile-store.ts`: a separate browser instance/data directory |
| Full screen (browser chrome, F11) | ✅ | `fullscreen.ts` |
| Kiosk mode | ✅ | `--orivon-kiosk` opens full-screen windows with no tab strip or toolbar that run only back, forward, reload, zoom, find, print and quit; quit is the only way out, and a page's own `window.open` still opens a tab (`src/main/window-state/kiosk.ts`) |
| Always on top | ✅ | `window.alwaysOnTop` (More tools, unbound) keeps the focused window above others; per window, not remembered |
| Window state (size/maximized) restored on relaunch | ✅ | The first window of a launch opens at the last-used window's size, position and maximised state, clamped to a visible display (`src/main/window-state/`); a private session records nothing; on Wayland the position is the compositor's |
| Multiple monitors, HiDPI, touch, IME input | ➖ | Chromium's own default support applies |

### New tab page and start-up

| Feature | Orivon | Note |
|---|---|---|
| Custom new-tab page | ✅ | A dashboard replacing `about:blank` (`src/renderer/newtab/`) |
| Homepage setting | ✅ | `home.url` (Settings, On start-up): any address the address bar would load; empty means the new tab page (`src/main/shell/home.ts`) |
| Startup pages ("open these pages") | ✅ | `startup.mode` "Open specific pages" and `startup.pages`: up to eight addresses, each checked as the address bar checks one (`src/main/startup/`, `src/renderer/pages/settings/controls/page-list.ts`) |
| Continue where you left off | ✅ | `startup.mode` "Continue where you left off" reopens the last session's windows, tabs, pins and places from `session.json`; the addresses on the command line open in front (`src/main/startup/startup-plan.ts`) |
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
| Passkeys / WebAuthn | ❌ | No code calls `app.configureWebAuthn`. Per Electron's typings, until it is called `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` resolves `false` and platform-authenticator requests are not serviced. A roaming security key is not measured |
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
| HTTPS-only / upgrade mode | ⚠️ | No general toggle. An installed app and a production `.eth` or `ipfs://` origin are served over `https:` by construction. A loopback origin (`http://127.0.0.1:<port>`) in every build, and in developer mode a `http://<name>.eth` name, run over `http:` with their grants held for the session only. A page an app shows in a `<webview>` from its own loopback listener (`http://<site>.localhost:<port>/`) is `http:` as well |
| Mixed-content blocking | ➖ | Chromium's own default applies to a page's native requests. A routed request from an app tab to a granted `http://` or `ws:` host is not blocked, because the manifest named that host and the person granted it |
| Secure DNS / DoH (general browsing) | ❌ | `.eth` resolution uses fixed DoH resolvers internally; not a general per-site setting |
| Certificate viewer | ❌ | `certificate-check.ts` pins Orivon's own verifier certificate, not a user-facing viewer |
| Certificate error interstitial | ➖ | Chromium's own default applies |
| Custom CA management | ❌ | Not found |
| HSTS | ⚠️ | Chromium applies the HSTS headers it is sent and its preload list in every tab; Electron has no API to list or clear the stored entries, so no Orivon page shows them |
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
| Bluetooth (Web Bluetooth) | ❌ | No `select-bluetooth-device` listener exists, and Electron's typings say every Bluetooth request is then cancelled (not measured). The device-permission handler does not cover Bluetooth |
| Sensors (motion/orientation/ambient light) | ⚠️ | No Electron permission name exists for them, so the gate never decides; Chromium's default in this build applies (not measured) |
| Pop-ups | ⚠️ | `window.open()` popups keeping `opener` are allowed and become a tab; no separate "block pop-ups" toggle |
| Redirects | ➖ | Chromium's own default navigation handling applies |
| Automatic downloads | ❌ | Not found |
| Protocol handlers (`registerProtocolHandler`) | ❌ | Not found; unrelated to the app-install manifest hint mechanism |
| File System Access, one file | ✅ | Allowed for a picked or dropped file, read or write (`ADR-0024`) |
| File System Access, a folder | ➖ | Refused by design on both handlers |
| Idle detection | ❌ | Denied |
| Window management (multi-screen) | ❌ | Denied |
| Storage access API (cross-site) | ❌ | Denied |
| Payment handlers | ⚠️ | No Electron permission name exists for them and no payment UI is built; Chromium's default in this build applies (not measured) |
| JavaScript on/off per site | ❌ | Not found |
| Images on/off per site | ❌ | Not found |
| Sound per site | ❌ | Not found |
| Zoom per site | ✅ | Remembered per origin (`src/main/zoom/`) |
| Local fonts (Local Font Access API) | ⚠️ | No Electron permission name exists for it; Chromium's default in this build applies (not measured) |
| Screen/window sharing (`getDisplayMedia`) | ❌ | Left unset (Electron's own default refusal) |
| Persistent storage (`navigator.storage.persist`) | ⚠️ | The permission gate does not decide it (Electron's typings have no such name), so the answer is Chromium's default in this build (not measured) |
| AR/VR (WebXR) | ⚠️ | No Electron permission name exists for it; Chromium's default in this build applies (not measured) |
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
| Find in page | ✅ | `find.open` (`Ctrl+F`), `find.next` (`Ctrl+G`, `F3`), `find.previous`: a bar with a live count, match case and Enter/Shift+Enter, per tab; `Ctrl+F` and `Ctrl+G` go to a registered app's tab (`src/main/find/`, overlay `find`) |
| Zoom (page) | ✅ | `zoom.in`/`zoom.out`/`zoom.reset`, per-origin; a tab zooms per webContents (`isolated` mode) so the page's pixels scale and `innerWidth` follows (`src/main/zoom/attach-zoom.ts`) |
| Print / print preview | ⚠️ | `page.print` (`Ctrl+P`, menu, More tools) opens the system print dialog with backgrounds on, and with no printer offers Save as PDF instead; no in-browser preview (`src/main/page-tools/print.ts`) |
| Save page as | ✅ | `page.save` (`Ctrl+S`) saves complete HTML, a single-file `.mhtml` by extension, and downloads an image, PDF or text page as it is; `page.pdf` saves the page as PDF (`src/main/page-tools/save-page.ts`, `save-pdf.ts`) |
| View source | ✅ | `page.viewSource` (`Ctrl+U`) opens `view-source:` beside the page for an http(s) page that is not an app's tab (`src/main/page-tools/view-source.ts`) |
| Reader mode | ❌ | Not found |
| Translate | ❌ | Not found |
| Spellcheck | ⚠️ | `spellcheck.enabled` (on by default) checks text in every tab; the menu offers up to five suggestions, Add to Dictionary and a Check Spelling switch; no language picker, and Chromium downloads each dictionary once (`src/main/spellcheck/`) |
| Dictionary / look up word | ❌ | Not found |
| PDF viewer | ✅ | A served PDF opens in an ordinary tab in Chromium's built-in viewer with no `plugins` flag and no setting (`test/e2e-page-tools.test.ts`) |
| Image viewer | ➖ | Chromium's own default applies |
| Picture-in-picture | ✅ | `page.pip` (More tools, the video's menu) pops out the video under the pointer, or the playing or largest one, and puts it back on a second run (`src/main/page-tools/pip.ts`) |
| Media controls / global media hub | ❌ | Not found |
| Casting (Chromecast/AirPlay) | ❌ | Not found |
| Screenshots / page capture | ✅ | `page.screenshot` (`Ctrl+Shift+S`): the visible area or the whole page, to the clipboard or a PNG file; a page longer than 16,384 device pixels is cut there (`src/main/page-tools/screenshot.ts`, overlay `screenshot`) |
| Text-to-speech / read aloud | ❌ | No "read aloud" UI; the page's own `speechSynthesis` call is ungated |
| Forced dark mode for light-only sites | ⚠️ | `appearance.theme` flips OS-level `prefers-color-scheme`; no forced repaint of a site with no dark styles |
| Page fonts / minimum font size | ❌ | Not found |
| Text encoding override | ❌ | Not found |
| Alert / confirm / prompt dialogs | ⚠️ | `alert` and `confirm` open Electron's native message box (not measured) with no "prevent additional dialogs" checkbox (`safeDialogs` is off). `prompt()` returns `null` at once: Electron draws no prompt dialog and offers no hook to supply one (A232) |
| Pinch zoom, smooth scrolling, autoscroll (middle-click drag on a page) | ➖ | Chromium's own default applies to page content |
| Drag-and-drop of links/images/files into the page | ➖ | Chromium's own default applies |
| Network / DNS / certificate error pages ("can't be reached") | ➖ | Chromium's own built-in interstitials apply |
| "Aw, snap" crash page / sad-tab reload | ✅ | Overlay `sad-tab` (`src/main/sad-tab/`) over a crashed active tab with Reload and Close tab; an unresponsive page gets the same card with Wait and Reload; a background crash shows only the strip icon until the tab is activated |
| `beforeunload` guard | ✅ | Asks Leave/Stay (`leave-page-prompt.ts`) |

### Context menus

| Feature | Orivon | Note |
|---|---|---|
| Link: open in new tab | ✅ | Opens in a background tab (`src/main/shell/context-menu-groups.ts`) |
| Link: open in new window | ✅ | Open Link in New Window opens a real window (`context-menu-groups.ts`) |
| Link: open in private window | ✅ | Starts a private session on the address; hidden inside a private window and in a kiosk (`context-menu-groups.ts`, `ProfilesService.openPrivate`) |
| Link: copy link address | ✅ | |
| Link: save link as | ✅ | `webContents.downloadURL` through Electron's own save dialog (`context-menu-groups.ts`) |
| Link: open in split view | ✅ | Orivon-specific addition |
| Link: copy link text | ✅ | `context-menu-groups.ts` |
| Image: open image in new tab | ✅ | Shown for http(s) images; opens in a background tab |
| Image: save image as | ✅ | `webContents.downloadURL` through Electron's own save dialog; not offered for `data:` or `blob:` images |
| Image: copy image | ✅ | |
| Image: copy image address | ✅ | Shown for http(s) images |
| Image: search image | ❌ | Not found |
| Selection: copy | ✅ | |
| Selection: search selected text | ✅ | The engine chosen in Settings searches for the selection, in a tab in front; the text is sent only on the click, at most 1,000 characters (`context-menu-groups.ts`, `context-menu-text.ts`) |
| Selection: translate selection | ❌ | Not found |
| Page: back/forward/reload in menu | ✅ | Back, Forward and Reload when nothing more specific was clicked; Back and Forward follow the tab's history |
| Page: save page as, print, screenshot, view source | ✅ | In the same group, for a web page; an internal page shows only Back, Forward and Reload |
| Page: inspect element | ✅ | Opens DevTools at the clicked element |
| Cut/copy/paste/select all (editable fields) | ✅ | Undo, Redo, Cut, Copy, Paste, Paste as Plain Text, Select All and Check Spelling, each enabled from the field's state; a misspelt word adds suggestions and Add to Dictionary; plus the chrome's own edit menu |
| Video/audio: open, save, copy address, picture in picture | ✅ | Open Video in New Tab, Save Video As, Copy Video Address and a Picture in Picture check (`context-menu-groups.ts`) |

### Web platform features that need the browser

| Feature | Orivon | Note |
|---|---|---|
| Notifications API | ✅ | See Site settings |
| Push API | ❌ | No push-service wiring; Electron ships no default push backend |
| Service workers | ➖ | Chromium's own default applies to ordinary web content; extension service workers are separate (Table 7). On an installed app's origin the served policy allows `worker-src 'self' blob:`, and no `Service-Worker-Allowed` header is sent, so a worker's scope is its script's directory (not measured). No end-to-end test registers a service worker on an app origin |
| Background sync | ❌ | Not found |
| Periodic background sync | ❌ | Not found |
| Badging API (`setAppBadge`) | ❌ | Not found |
| Web Share API | ❌ | No OS share-sheet implementation |
| Payment Request API | ⚠️ | No Electron permission name exists for it and no payment UI is built; Chromium's default in this build applies (not measured) |
| `registerProtocolHandler` | ❌ | Not found |
| PWA install / standalone app windows | ❌ | Orivon's own "app" concept is unrelated to a `beforeinstallprompt` PWA path |
| File handlers (web app file associations) | ❌ | Not found |
| DRM / Widevine / EME | ❌ | No CDM wiring; the stock `electron` package ships without Widevine |
| Proprietary codecs (H.264/AAC/HEVC) | ⚠️ | The stock `libffmpeg.so` of Electron 44.0.0 decodes H.264, AAC, MP3, FLAC, Opus, Vorbis and PCM and demuxes MP4 and MOV, Matroska and WebM, Ogg, WAV, MP3, AAC and FLAC. It has no HEVC, AC-3, E-AC-3 or DTS decoder (`MediaSource.isTypeSupported` answers true for H.264 and AAC and false for HEVC). HEVC through a platform hardware decoder is not measured |
| WebRTC | ➖ | Chromium's own default applies. An app tab's WebRTC is not bounded by CSP or by grants and reaches STUN, TURN and peers with no grant (A41); media tracks depend on camera/microphone permission, denied by default |
| WebGL / WebGPU | ➖ | Chromium's own default GPU-accelerated rendering applies |
| WebXR | ⚠️ | No Electron permission name exists for it; Chromium's default in this build applies (not measured) |
| Geolocation provider | ❌ | Denied; Electron ships no geolocation API key by default |
| Speech recognition | ⚠️ | No Electron permission name exists for it. Recognition needs the microphone, which the gate denies for every page (`media`), and Electron ships no recognition backend key (not measured) |
| Speech synthesis | ➖ | Ungated; no browser-level UI uses it |
| Web Bluetooth / USB / Serial / HID | ❌ | USB, Serial and HID: the check handler denies `usb`, `serial` and `hid` and the device-permission handler answers `false`. Bluetooth: no `select-bluetooth-device` listener exists, and Electron's typings say every Bluetooth request is then cancelled (not measured); the device-permission handler does not cover Bluetooth |
| Gamepad API | ➖ | Ungated; Chromium's own default applies |
| Screen Wake Lock API | ⚠️ | No Electron permission name exists for it, so no code denies it and Chromium's default in this build decides (not measured) |
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
| Linux packaging (AppImage/deb) | ⚠️ | `electron-builder.yml` and `npm run package:linux` build a `deb` and an AppImage; there is no packaging job in CI and no release workflow, so nothing is built or published automatically |
| External protocol links (`mailto:`, `magnet:`, `bitcoin:`, ...) | ✅ | Opened by the OS's default app only after a per-site, per-URL confirmation dialog (`ADR-0027`) |
| `beforeunload` guard | ✅ | See Page content tools |
| Right-click menu (chrome + page) | ✅ | See Context menus |
| Custom, non-Electron User-Agent string | ✅ | Every tab reports one plain Chrome UA with no `Electron/` or `orivon/` token, except `accounts.google.com` and `accounts.youtube.com`, which are shown a Firefox identity and no `Sec-CH-UA*` headers (`src/main/shell/sign-in-identity.ts`) |
