# Changelog

All notable changes to this project are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

- **The browser shell** (build step 1). A frameless `BaseWindow` composing a chrome
  `WebContentsView` over per-tab views: tab strip, toolbar, address bar, back/forward,
  window controls. Two preloads at two privilege levels — `app.ts` for ordinary tabs,
  `shell.ts` only for the chrome view.
- **Address-bar search via DuckDuckGo.** Non-address input is treated as a search query.
  A known limitation, stated in-product: search text leaves the machine.
- **`src/contracts/`** — the complete `orivon.*` interface as types: the closed error enum, the
  five handle interfaces, the manifest and grant shapes, per-origin limits, and the IPC message
  shapes including the credit-window backpressure protocol. Types only, references nothing
  outside itself. This is the durable asset
  ([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).
- **The subsystem registry** (`src/main/registry.ts`). Subsystems register in
  `src/main/subsystems.ts` rather than editing app lifecycle code, so adding one is an append
  rather than an edit — the difference between a clean merge and a conflict when several
  streams are running.
- **`scripts/check-contracts-pure.mjs`** — fails the build if `src/contracts/` is incomplete or
  references anything outside itself. Runs in CI.
- **The parallel-work system** — the stream ownership map, worktree flow, and conflict repair
  ([`docs/development/parallel-work.md`](docs/development/parallel-work.md)). `merge=union` on
  the append-only files.
- **The human entry path** — `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  a documentation index, setup and testing guides, a release checklist, and a `README.md` in
  every directory stating what it depends on and what it must never import.
- **Apache-2.0 licence.** `package.json` previously said `UNLICENSED`, which legally forbade
  the clone-and-run path this project treats as a supported platform strategy.

### Fixed

- **The window never appeared under `npm run dev`.** `ready-to-show` is unreliable when loading
  from the dev server; the shell now shows the window once, deterministically.

### Resolved

- **The week-0 spike.** Gates 0, 1a, 1b and 2 **pass** with measured evidence. Gate 4
  (throughput) fails its literal relative-to-control threshold and beats the actual product
  requirement by roughly 10x. Gate 3 is **blocked, not failed** — the app works, but
  Playwright's `_electron` driver cannot attach to that window, for a cause still unidentified.
  See [`docs/planning/spike-verdict.md`](docs/planning/spike-verdict.md). The `utilityProcess`
  fallback was **not** needed.
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
  does not exist — renderer → main, the message silently never arrives
  ([electron#34905](https://github.com/electron/electron/issues/34905)). It does not matter:
  structured clone already runs two orders of magnitude faster than the requirement.
- **The telemetry metric measured how long the app was open.** A torrent client seeds in the
  background, so a user who pasted one magnet and walked away would cross the target on day one
  having used the product once. The metric is now stated on `activeSec`, which is harder, which
  is the point.
