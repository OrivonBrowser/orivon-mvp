# Changelog

All notable changes to this project are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

- **The identity seed survives a restart, and an app can hold its own encrypted secret.** The
  seed behind `orivon.id` now lives in the OS keyring (Electron `safeStorage`), not a placeholder
  that refused every call. A new `secrets` capability (`orivon.secrets.available`/`encrypt`/
  `decrypt`) lets a granted app encrypt and decrypt its own data with a key derived from that
  seed, never the seed itself; without a reachable keyring the identity is generated fresh each
  launch and never written to disk, and `available()` says so before an app commits data it would
  lose. The `electron` compatibility package's `safeStorage` now backs the same capability for
  ported apps. Also fixes a real gap: a consent-made `id` grant, the shape every real
  `app.requestGrant()` call produces, was refused for every curve in production until now.

- **A site can publish its bundle hash tree, and the Web3 Score page shows whether it matches
  (DDOC).** The site puts `/.well-known/orivon-ddoc.json` beside its manifest: the bundle hash and
  every file's leaf. The loader fetches it with the bundle and stores it beside the pin. The site
  info's Web3 Score page then reads verified, failed (naming the files that differ), not
  published, or not checked. Nothing about it blocks an install. `docs/architecture/bundle-hash.md`
  specifies the file and how a tool writes one from a static folder.

- **App tabs route `XMLHttpRequest` and `EventSource` to granted hosts, as they route
  `fetch()`.** A routed request follows redirects, streams its response, accepts `Blob`,
  `FormData` and stream bodies, and waits for a free connection at the app's socket limit instead
  of failing. A host the app was not granted gets the page's own API, as on any website.
- **An app's WebSocket reaches the hosts it was granted.** `new WebSocket('wss://...')` to a host
  the app holds an https grant for (or `ws://` with a TCP grant) runs over `orivon.net` like the
  routed `fetch`, under the broker's grant and local-network checks; every other socket stays the
  page's own, under its CSP.
- **Installed apps can compile WebAssembly and use `eval`**, load `data:` and `blob:` images,
  fonts, media, workers and frames, and reach granted https hosts from workers and XHR. A `*`
  https grant reaches any public https host. Developer-mode origins run under the same policy.
- **A page can go fullscreen from a click**, and Escape always gives the window back, with an
  on-screen notice saying so (ADR-0025).
- **Games can capture the mouse, and in fullscreen the keyboard** (ADR-0026). Escape brings the
  cursor back, holding Escape leaves a fullscreen page that holds the keyboard, and a notice says
  which.
- **External links open after the person allows it.** A `mailto:`, `magnet:` or payment link asks
  every time, naming the site and the URL, and only then goes to the computer's default app
  (ADR-0027).
- **Sites can ask to show notifications.** The person is asked once per site, and Allow or Block
  is remembered (ADR-0028).
- **`window.open()` returns a real window.** Sign-in popups can talk back through
  `window.opener`, and a `blob:` link the page made opens.
- **A page guarding unsaved work asks Leave or Stay** instead of silently refusing to navigate.
  Right-click works in tabs and the address bar, and tabs identify as Chrome.
- **App tabs have a `Buffer` global**, so Node code using a bare `Buffer` runs without bundler
  injection.
- **The Node shim covers much more of Node.** `url`, `querystring`, `string_decoder`, `timers`,
  `assert`, `util` and `tls`; `node:`-prefixed and subpath imports; one virtual root for the
  working directory, home, temp and `userData`; `fs` streams that close and release their handle;
  `readFileSync` errnos and `existsSync`. The http client gains timeouts, abort signals, `upgrade`
  and 1xx events, and `Agent`; `net.Socket` gains Node's constructor, an idle timeout and state
  accessors; errors carry Node's `errno`, `syscall` and codes; `dns.lookup` answers literals and
  `localhost` itself; `dgram` validates sends as Node does.
- **`web.context`'s `evaluate` takes a per-call timeout**, which can only shorten the platform's.
- **Ported apps can reach self-signed and private-CA TLS servers.** `tls.connect` and `https`
  honour `rejectUnauthorized: false`, `ca`, client certificates (`cert`/`key`/`pfx`),
  `servername`, ALPN and a custom `checkServerIdentity`, and a TLS socket reports `authorized`,
  `authorizationError`, `alpnProtocol` and `getPeerCertificate()` as in Node. Turning
  verification off never widens what an app's grant reaches.
- **A manifest with extra fields installs.** An unknown top-level field (`$schema`,
  `description`, `icons`, `homepage`) is ignored with a warning; an unknown field inside
  `capabilities` still refuses the manifest.

- **A Chrome-style per-site permissions popover.** The address pill now leads with the Web3
  Score shield (carrying the old trust dot's secure/insecure/cached states) and a key that
  appears once a site has asked for a permission; both open a popover with the connection row,
  one switch per capability or picked path the site has asked for (staged until Confirm), the
  Web3 Score's own delivery evidence, and a Cookies and site data page covering both the site's
  ordinary browser storage and what it stores through `orivon.fs`. A switched-off capability no
  longer reappears as a re-consent prompt on the next visit. The all-sites list moves to a tune
  icon in the toolbar cluster.
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

- **A sign-in that sends an app's tab to a provider and back can complete.** The app finds its
  `sessionStorage` where it left it, and its own back history, so an OIDC login no longer loses
  its state on the way back.
- **Entering fullscreen no longer takes the page's keyboard focus**, so a video player's keys keep
  working under the exit notice.
- **An installed app keeps its app-tab setup after a restart**, and the tab that installs an app
  reloads once so it runs as the app.
- **Bundles up to 512 MiB install, and assets up to 64 MiB are served, without being held in
  memory**: streamed to and from disk, Range requests included.
- **Real static hosts work.** An update no longer breaks an open single-page app's lazily loaded
  chunks, reloading a client-side route works, a corrupted cache recovers instead of locking the
  app out, and hosts that redirect the root document (Cloudflare Pages, GitHub Pages) install.
- **A capability the person declined, or revoked in Settings, is not asked for again at every
  launch**, and the app can still request it.
- **An unchanged installed app costs one conditional (304) manifest request an hour**, and the
  interval survives a restart.
- **Chunked file I/O no longer hits the control channel's rate limit**, which broke nedb past a
  few hundred documents. The fs quota measures disk usage; a socket closed cleanly on both sides
  frees its slot; a wider `requestGrant` no longer resets live sockets; `localhost:<port>` grants
  work; the file picker waits 120 s; a malformed UDP send is refused instead of killing the
  socket; an operation on a closed handle gives `EBADF`; a peer reset reaches the page as
  `ECONNRESET`; an operation past the in-flight cap waits briefly instead of failing.
- **Subresources from granted hosts behave like a browser's.** Over-limit requests queue instead
  of failing, redirect chains are capped at 20, a request is dropped after five minutes without a
  byte rather than 30 s, and audio, subtitle, streaming-manifest and web-manifest files are served
  with their real types.

- **A page can open and save a file through the File System Access API.** One file the person
  picks or drops can be read and written; folders stay refused (ADR-0024). Without this,
  FreeTube's import and export failed with `NotAllowedError`, as did any website saving a file
  this way.
- **A routed `fetch()` to a dead host names the real failure.** A DNS or connection failure
  before the TLS handshake was reported as "the secure connection failed", and the error now
  carries the platform's own code, such as `EHOSTUNREACH` or `ECONNREFUSED`.
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
