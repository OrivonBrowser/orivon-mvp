# Changelog

All notable changes to this project are recorded here, at most three lines each; the full
account of a change is in its pull request.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

- **A forked child behaves as a Node child does**: it ends when nothing listens on its IPC channel, `setTimeout` and friends
  return Node's objects (`unref`, `refresh`), `process.versions.node` is set, a taken port is `EADDRINUSE`, a bundled
  `require('assert')` is the function, and `fs.Stats` reports the modes of an app-private store. The Lounge's server runs on it.
- **A Node web server's stack runs on the shim**: real `express` and `socket.io` on `http.createServer`, `fs.watch`, a run-time
  CommonJS `require` (also a forked child's global one), the full `fs.Stats`, `chmod`, and `tty`, `readline`, `http2`,
  `diagnostics_channel`, `async_hooks`, `perf_hooks`, `console` (with its `Console` class) and `process` modules; a fork's `console`
  is a `Console` over its `process.stdout` and `process.stderr`, and `require('process')` is the global itself.
- **An esbuild plugin for ports** (`src/shim/bundler/`): maps every Node builtin to the shim under `platform: 'node'`, fails the
  build on a builtin it lacks, serves `node:sqlite` with its browser engine, and loads from another repository.
- **`node:sqlite` in the Node shim**: `DatabaseSync` and `StatementSync` over the SQLite WebAssembly build, with a database file in
  the app's files (a rollback journal, page-level writes) in a forked child or thread of a cross-origin isolated app, and
  `:memory:` everywhere. A commit reaches the file at the end of its transaction, `synchronous=off` included. Function, aggregate,
  session, extension and backup members refuse by name.
- **The compatibility matrix lists everything a ported app can need**, not only what ports have hit: every
  Node builtin, every `electron` export, every `orivon.*` member, permission string and protocol stack has a
  row, checked against the code, one sub-table per file under `docs/planning/compatibility/`.
- **An app can show pages it serves itself**, each at an origin of its own, beside ordinary websites: a
  `web.embed` local pattern (`http://*.localhost:<port>`), admitted only while the app holds a listener on
  that port (ADR-0047).
- **An app hears of a shown page's new window and download** (`orivon-popup`, `orivon-download` on the
  `<webview>`); nothing opens and no file is kept. A shown page's link to another program is never offered to it.
- **A listener can be loopback only.** `orivon.net.listen` and `udpBind` honour `scope`; `'local'`, the
  default, binds `127.0.0.1`, and the shim maps a loopback host onto it (ADR-0034).
- **`http.createServer` in the Node shim**, with `Server`, `ServerResponse` and `OutgoingMessage`, over
  `orivon.net.listen`; `https.createServer` still refuses.
- **Google's sign-in pages are shown a Firefox identity**, since Google rejects this browser as "not secure"; the
  request headers, `navigator.userAgent` and the missing `navigator.userAgentData` agree on `accounts.google.com`
  and `accounts.youtube.com` alone. Not yet confirmed against a real account.
- **A failed e2e spec leaves its evidence** in `qa-artifacts/latest/`: a screenshot per shown view, the console,
  page errors, failed requests, crashes and the main log. `npm run qa` adds layout-audited, baseline-compared
  shell states, a restart journey and adversarial specs; CI uploads the evidence on a red e2e job.
- **An app's child processes outlive the tab that started them** while another tab of the app is open,
  and end with its last page: they run in a hidden host of the app's own, with the app's grants
  (ADR-0046).
- **`worker_threads.Worker` runs a thread** in a Web Worker, with `parentPort`, `workerData`,
  message ports and `terminate()`, from the page or from a forked child.
- **A forked child or thread of a cross-origin isolated app can call every `fs` `*Sync` method**
  and `spawnSync`/`execSync`/`execFileSync`; the page keeps `readFileSync` and `existsSync`.
- **A CommonJS `require()` of a Node module the shim lacks a member of names the gap** when called,
  instead of `undefined is not a function`.
- **Extensions that capture a tab's audio work**, Volume Master among them: `chrome.offscreen`, `chrome.tabCapture`
  and `chrome.runtime.getContexts`. A capture needs the extension's toolbar button on that tab, and the tab is
  heard only through the extension while captured.
- **A middle click or ctrl+click opens a link in a background tab**, and a shift+click opens it in a new window,
  a private one from a private window.
- **Settings, History and Profiles update live** when a permission, a visit, cleared data or a profile changes
  anywhere, in any window or profile.
- **Tearing a tab off shows where its window will open.** A preview of the page follows the pointer; letting go
  over the page or outside every window opens the window there, in front and at once. Over another window's
  strip a line marks where the tab will land. On Linux X11 a middle click on the strip's empty end opens a tab.
- **Settings and History have a new look**, shared with Profiles and Private: Settings' sections are grouped
  in a sidebar with icons and its search; History marks each site and heads each day with a rule.
- **Chrome extensions.** Install from the Chrome Web Store, a `.crx`/`.zip` or a folder; `orivon://extensions` says who
  updates each one. Content scripts, workers, toolbar buttons, popups and options pages work on every website and on
  apps holding permissions, whose `window.orivon` refuses extension code; blocking rules come next.
- **`worker_threads` and `vm` import**: `worker_threads` answers as Node's main thread does, and
  `vm` runs code in the page's own context; starting a thread, or a context of its own, refuses
  by name.
- **A `.eth` name is shown as `ipfs://<name>`** wherever an address or origin is shown; typing or
  linking either `ipfs://<name>` or `ipns://<name>` opens the name's own, unchanged origin
  (ADR-0038).
- **A spawned program can open sockets**: `spawn` runs a WASI 0.2 component from the jco output
  shipped beside it, its files and sockets reaching `orivon.fs` and `orivon.net` under the app's
  grants (ADR-0040). A Rust program built for `wasm32-wasip2` runs, whether it blocks on `std::net`
  or runs tokio.
- **A Settings page, and the browser features a person lives in.** `orivon://settings` has a section for
  everything Orivon implements: appearance (theme, bookmarks bar, page zoom), search, tabs and windows,
  profiles, privacy and data, the apps that hold permissions, the Ethereum light client, remappable
  keyboard shortcuts, developer tools, and About. It searches, links to each section, marks what differs
  from the default and applies a change at once. The browser gained a main menu, keyboard shortcuts for
  everything it does (each can be changed, swapped, cleared or restored), zoom kept for each site, a
  history that stays on this computer (`orivon://history`, searchable, kept 90 days by default, with
  Clear browsing data), and developer tools on any page with F12, which ask once before opening on an app
  that holds permissions.
- **Tabs move, and two can share a window.** Tabs reorder by dragging or with Ctrl+Shift+PageUp and
  PageDown, go to another window or a window of their own from their menu or by being dragged out, and keep
  the page as it was. Two tabs can be shown side by side or stacked, made by dragging a tab to a page edge,
  from a tab's menu or "Open Link in Split View", with a divider that resizes and a pane that follows the
  click.
- **Profiles and private windows.** A profile is a separate browser with its own bookmarks, history,
  permissions and apps, made and managed at `orivon://profiles`; each runs as a process of its own, and a
  second start of one already open hands over to it. A private window (Ctrl+Shift+N) starts empty on a
  directory of its own, keeps no history, statistics or identity, asks for every permission again and is
  deleted when its last window closes. `ADR-0042`.
- **A native addon reaches the app's files from a forked child** of a cross-origin isolated app,
  each call blocking on the page's `orivon.fs`; that child's `fs.readFileSync` works too
  (ADR-0040).
- **A native addon loads as its WebAssembly build**: `process.dlopen` and `createRequire` take
  the `.node` path and load the build beside it through Node-API for WebAssembly; the `.node`
  machine code never runs (ADR-0040).
- **`child_process` works for ported apps**, every child in a Web Worker: `spawn`/`exec` run a
  WASI program from the app's bundle and `fork` an app module with IPC, both under the app's
  grants; a native program refuses by name (ADR-0040).
- **A WASI program runs inside an app's tab** through Node's `wasi` module, its every file call an
  `orivon.fs` call under the app's grant; native modules and child processes will come as
  WebAssembly too, never as machine code (ADR-0040).
- **An app can show a website inside its own page** (`web.embed`, ADR-0039), each shown page
  sandboxed in the app's own session; a manifest can also ask for cross-origin isolation, which
  turns on `SharedArrayBuffer` for WebAssembly threads.
- **A welcome screen on first launch**, and its picture behind the new-tab page. Nothing loads
  from the network.
- **`ipfs://` and `ipns://` addresses load, shown as themselves**, with every block checked;
  protocols register through one function in `src/protocols/` (ADR-0038).
- **`.eth` names load, with every byte checked on this machine**: a light client proves the name,
  IPFS blocks are hashed against their CID (ADR-0030, ADR-0031).
- **The identity seed survives a restart** in the OS keyring, and a granted app can encrypt its
  own secrets with `orivon.secrets`.
- **The Web3 Score shield shows the site's Website level**, coloured by level, with a Web2 /
  Web2.5 / Web3 mark; the Web3 Score page leads with the same level.
- **A site can publish its bundle hash tree (DDOC)**, and the Web3 Score page shows whether it
  matches; a local origin serving one is Level 2 in developer mode.
- **A Website Level 4 site's grants are shown without warnings** on every consent surface
  (ADR-0037), and every permission row carries an icon for what it grants.
- **A per-site permissions popover** in the address bar: one switch per capability, and the
  site's storage.
- **App tabs route `fetch()`, `XMLHttpRequest`, `EventSource` and WebSocket to granted hosts**,
  under the broker's grant and local-network checks.
- **Installed apps can compile WebAssembly and use `eval`**, and load `data:` and `blob:`
  resources.
- **Fullscreen, pointer lock and keyboard lock from a click**; Escape always gives the window
  back (ADR-0025, ADR-0026).
- **External links and site notifications ask the person first** (ADR-0027, ADR-0028).
- **`window.open()` returns a real window**; a page guarding unsaved work asks Leave or Stay;
  right-click works; tabs identify as Chrome.
- **The Node shim covers much more of Node**: more modules, one virtual root, closing `fs`
  streams, Node's error shapes, and a `Buffer` global in app tabs.
- **Ported apps reach self-signed and private-CA TLS servers**; turning verification off never
  widens what a grant reaches.
- **A manifest with unknown top-level fields installs**, with a warning; `web.context`'s
  `evaluate` takes a per-call timeout.
- **A global Orivon installs on an app's window can be replaced by the app** (ADR-0021), and
  `check:page-globals` enforces it.
- **An app tab that dies on load says so** in the shell's own output.
- **The capability broker** (build step 2): grants that survive a restart, per-origin
  enforcement, per-app `session` partitions, TCP, TLS, UDP, fs and name resolution.
- **`orivon-node-shim`** (build step 3): `net`, `dgram`, `fs`, `dns.lookup`, `http` and `https`
  in Node's shapes over the capabilities.
- **The app loader** (build step 4): a discovery hint, a hash-pinned cache, one consent dialog
  before the app's code runs, and a CSP narrowed to what was granted.
- **The browser shell** (build step 1): tabs, toolbar, address bar with DuckDuckGo search, and
  two preloads at two privilege levels.
- **`src/contracts/`**: the complete `orivon.*` interface as types, the durable asset (ADR-0002).
- **The subsystem registry, the parallel-work system and the human entry path**: README,
  ARCHITECTURE, CONTRIBUTING and a README in every directory.
- **AGPL-3.0-only licence.**

### Fixed

- **A tab title no longer loses the bottom row of its descenders** (g, p, y): its line box was shorter than the text.
- **A burst of short-lived sockets no longer brings the browser down.** The broker's socket streams no longer go
  through Node's `Duplex.toWeb`, whose teardown could throw where nothing could catch it.
- **A program a forked child spawns can use the app's files and network.** Every `orivon.*` call from it failed
  before, which a WASI program saw as an I/O error on its first file call.
- **A WASI program that listens on an IPv6 address no longer aborts when it reads its own address.** A
  listener reports the address it bound, and every reported address is of the socket's own family.
- **A middle, ctrl, shift or ctrl+shift click on a link no longer closes the browser.**
- **An extension's sandbox page gets no extension APIs**, as in Chrome, so untrusted code an extension runs there
  cannot act with the extension's permissions.
- **New tabs, internal pages, the window and every toolbar panel open in the theme's colour**, with no white
  flash, and the main menu opens without being rebuilt.
- **An extension's popup closes** on a click elsewhere in Orivon, a tab switch, a navigation, a window move or
  Escape, and opens in the theme's colour.
- **An extension popup's first `chrome.*` call no longer fails** with "unknown extension context", and Electron
  no longer warns that a permission Orivon serves is unknown.
- **A crash while bookmarks or a profile are being saved leaves the previous file whole.**
- **A second start with no window open shows a window only once it is drawn**, on its new-tab page
  when no address was given.
- **History search answers at once on a long history**, whether most pages match or almost none do.
- **A private window keeps the keyboard shortcuts** of the profile that opened it.
- **Settings, History, Profiles and a private window's first page load under `npm run dev`**; they were blank.
- **The main menu shows every entry with no scroll bar**, and a new split shows both panes painted at once.
- **A `.eth` or `ipfs://` site can be framed only by a page of its own origin**, so another site cannot
  lay it under its own page to steer the person's clicks; an app granted `web.embed` for it still shows it.
- **A native addon built with napi-rs loads**: its WebAssembly build gets Node-API and memory the way
  napi-rs's own loaders provide them, which a real napi-rs 3 addon needs.
- **An app that listens for TCP connections receives them**: the broker now hands each accepted
  connection's port over by transfer alone, which Electron requires.
- **The toolbar no longer creates a session partition for every website visited.**
- **An OIDC sign-in that leaves an app's tab and returns can complete.**
- **Entering fullscreen keeps the page's keyboard focus.**
- **An installed app keeps its app-tab setup after a restart.**
- **Large bundles install and stream from disk**: 512 MiB per bundle, 64 MiB per asset, Range
  requests included.
- **Real static hosts work**: lazy chunks survive an update, client routes reload, a corrupted
  cache recovers, and redirecting hosts install.
- **A declined or revoked capability is not asked for again at every launch.**
- **An unchanged app costs one conditional manifest request an hour.**
- **Chunked file I/O no longer hits the control channel's rate limit**, and a dozen socket and
  fs edge cases behave as in Node.
- **Subresources from granted hosts behave like a browser's**: queued, redirect-capped, with
  real content types.
- **A page can open and save one file through the File System Access API** (ADR-0024).
- **A routed `fetch()` to a dead host names the real failure**, and is replaceable like the
  platform's own.
- **The window appears under `npm run dev`.**
- **The chrome view and its popups expose their bridge only at their own URL**; an isolated
  context is locked before its first load, and a refused navigation is logged.
- **Favicons survive a hash change or a same-origin page**, a failed icon fetch no longer holds a
  socket, the icon cache is bounded, and an SVG entity bomb behind a quoted DOCTYPE literal is
  refused.
- **`.eth` pages keep their gateways through a lost race, a cooldown and a hostile answer**: the
  verifier host no longer crashes on a 999 status or stalls on a 101, and every run certificate
  parses.

### Security

- **A site's permissions work only from a page that committed in that site's own session**: a page
  a link or redirect reached before its tab moved, a page an app shows or a web context is `denied`.
  A grant or revoke never strands an open page; a site's handles close when its last tab goes.
- **The file picker needs a click or key press**, names the site, opens once per site at a time, and
  refuses the browser's own data, the home folder, disk roots and system folders.
- **`orivon.net` refuses to open sockets or resolve names while a system proxy applies** (T20).
- **Consent dialogs belong to the tab that asked**: shown over its window, dropped if it left, one
  at a time per site, lists capped; `app.requestGrant` does not re-ask what the person declined.
- **An fs quota holds against sparse positional writes**, an app's files sit in their own root apart
  from its code, and a widened curve list, quota or socket count asks again.
- **The verifier caps the memory one page can hold**, dials CCIP-Read at a checked address on
  port 443, validates and caps its IPNS records, checks its host's messages, and stamps shown
  pages.
- **Packaged builds turn off RunAsNode, NODE_OPTIONS and `--inspect`**, encrypt cookies and check
  `app.asar`; the address bar hides userinfo, and a `magnet:` link must parse before it leaves.

### Resolved

- **The week-0 spike**: gates 0, 1a, 1b and 2 pass; see `docs/planning/spike-verdict.md`.
- **Handle contracts**: WHATWG streams are the durable interface (ADR-0008).

### Notable reversals

- **Protocol encryption is available**: `mse.js` ships a pure-JS RC4 fallback.
- **Transferable `ArrayBuffer`s are no rescue**: renderer to main they never arrive, and
  structured clone is fast enough.
- **The telemetry metric counts `activeSec`**, not time the app was open.
- **There is no flagship app**: build step 5 ports existing desktop apps as test cases (ADR-0001).
- **Judged Web3 Score levels are in**, each naming its provider (ADR-0006).
