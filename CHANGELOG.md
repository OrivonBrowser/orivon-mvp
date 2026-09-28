# Changelog

All notable changes to this project are recorded here, at most three lines each; the full
account of a change is in its pull request.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

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
