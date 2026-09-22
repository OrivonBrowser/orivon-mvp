# Changelog

All notable changes to this project are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

- **A global Orivon installs on an app's window can be replaced by the app**, as it can in a
  browser, and `npm run check:page-globals` fails the build on one that cannot (ADR-0021). A
  locked global kills any bundle that ponyfills it, so this is what stops one app's blank page
  becoming every app's.
- **An app tab that dies on load says so.** Its uncaught errors, a preload that threw and a dead
  renderer now reach the shell's own output instead of staying inside the renderer, where a
  blank window was the only symptom. Ordinary web pages stay unnarrated.

- **The capability broker** (build step 2). Manifest parsing, a grant ledger that survives a
  restart, per-origin enforcement, and per-app `session` partitions so two origins never share
  storage. Outbound TCP, TLS, UDP, inbound TCP, a rooted filesystem (including an open file
  handle) and name resolution are all reachable from a real page under a grant. An identity that
  can sign is wired end to end.
- **`orivon-node-shim`** (build step 3). `net` (client and server), `dgram`, `fs` (including
  `FileHandle`) and `dns.lookup` present real Node shapes over the capabilities, with Node's
  `http`/`https` clients on top of the TLS one, and the core browser polyfills. A handful of
  narrower cases still refuse loudly rather than failing silently (a `net.Server` bound to a
  specific host rather than every interface, and a `FileHandle`'s own stream methods), and each
  has a filed reason.
- **The page's own `fetch()` is routed** through the capability for granted hosts, carrying
  app-chosen headers. This is what lets an ordinary web frontend reach hosts a browser's
  same-origin rules would refuse.
- **The permission prompt and the permissions list.** A real manifest is rendered at install
  with breadth visible, so an app asking for unlimited network access does not look like one
  asking for two sites, and grants are listed and revocable.
- **`window.orivon.app.requestGrant` reaches a page, and a real page can now hold a real
  grant.** A page can ask for a capability and get a real prompt, and accepting it persists
  a grant a later capability call actually uses.
- **The app loader.** Visiting a page that declares itself an app now triggers the whole
  pipeline automatically: a discovery hint in the page's own HTML, fetching and hash-pinning
  its declared files, and caching them locally. A person is asked once, in plain language, for
  everything the app's manifest declares, before the app's own code runs; accepting installs it.
  Later visits are served from local cache, with the network unplugged for anything not part of
  the pinned bundle, and the served page's own content-security policy narrowed to exactly what
  was granted. A first-ever visit can still see an early permission check denied before that
  one-time dialog resolves; every later visit is unaffected.
- **The browser shell** (build step 1). A frameless `BaseWindow` composing a chrome
  `WebContentsView` over per-tab views: tab strip, toolbar, address bar, back/forward,
  window controls. Two preloads at two privilege levels: `app.ts` for ordinary tabs,
  `shell.ts` only for the chrome view.
- **Address-bar search via DuckDuckGo.** Non-address input is treated as a search query.
  A known limitation, stated in-product: search text leaves the machine.
- **`src/contracts/`.** The complete `orivon.*` interface as types: the closed error enum, the
  five handle interfaces, the manifest and grant shapes, per-origin limits, and the IPC message
  shapes including the credit-window backpressure protocol. Types only, references nothing
  outside itself. This is the durable asset
  ([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).
- **The subsystem registry** (`src/main/registry.ts`). Subsystems register in
  `src/main/subsystems.ts` rather than editing app lifecycle code, so adding one is an append
  rather than an edit, which is the difference between a clean merge and a conflict when
  several streams are running.
- **`scripts/check-contracts-pure.mjs`.** Fails the build if `src/contracts/` is incomplete or
  references anything outside itself. Runs in CI.
- **The parallel-work system.** The stream ownership map, worktree flow, and conflict repair
  ([`docs/development/parallel-work.md`](docs/development/parallel-work.md)). `merge=union` on
  the append-only files.
- **The human entry path.** `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  a documentation index, setup and testing guides, a release checklist, and a `README.md` in
  every directory stating what it depends on and what it must never import.
- **AGPL-3.0-only licence.** `package.json` previously said `UNLICENSED`, which legally forbade
  the clone-and-run path this project treats as a supported platform strategy.

### Fixed

- **A page can open and save a file through the File System Access API.** One file the person
  picks or drops can be read and written; folders stay refused (ADR-0024). Without this,
  FreeTube's import and export failed with `NotAllowedError`, as did any website saving a file
  this way.
- **The routed `fetch()` is replaceable, as the platform's own is.** It was installed
  non-writable, which in strict mode stops a bundle shadowing `fetch` on a surrogate global --
  the pattern common `fetch` ponyfills use -- so such an app died while its module graph was
  still evaluating, with nothing naming a cause.

- **The window never appeared under `npm run dev`.** `ready-to-show` is unreliable when loading
  from the dev server; the shell now shows the window once, deterministically.

### Resolved

- **The week-0 spike.** Gates 0, 1a, 1b and 2 **pass** with measured evidence. Gate 4
  (throughput) fails its literal relative-to-control threshold and beats the actual product
  requirement by roughly 10x. Gate 3 is **blocked, not failed**: the app works, but
  Playwright's `_electron` driver cannot attach to that window, for a cause still unidentified.
  See [`docs/planning/spike-verdict.md`](docs/planning/spike-verdict.md). The `utilityProcess`
  fallback was not needed.
- **Handle contracts** ([`ADR-0008`](docs/decisions/ADR-0008-handles-are-whatwg-streams.md)).
  WHATWG streams are the durable interface; Node's shapes are reconstructed by the shim one
  layer above.

### Notable reversals

Recorded rather than quietly corrected, because a project that hides having been wrong learns
more slowly.

- **Protocol encryption was recorded as unavailable. It is not.** `mse.js` ships a complete
  pure-JS RC4 fallback, and `crypto-browserify` supplies the two genuinely missing pieces. A
  successful encrypted handshake was measured. It should be on.
- **Transferable `ArrayBuffer`s were named as the rescue if throughput failed.** That rescue
  does not exist: renderer → main, the message silently never arrives
  ([electron#34905](https://github.com/electron/electron/issues/34905)). It does not matter:
  structured clone already runs two orders of magnitude faster than the requirement.
- **The telemetry metric measured how long the app was open.** A torrent client seeds in the
  background, so a user who pasted one magnet and walked away would cross the target on day one
  having used the product once. The metric is now stated on `activeSec`, which is harder, which
  is the point.
