# Changelog

All notable changes to this project are recorded here, at most three lines each; the full
account of a change is in its pull request.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once there is something to version.

> **Nothing has been released.** There is no version, no tag, no packaged build. The list below
> is what has landed on `main` during development.

## [Unreleased]

### Added

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
  deleted when its last window closes. `ADR-0041`.
- **A welcome screen, and a picture on the new tab.** The first time Orivon opens on a profile it
  shows a full-window screen ("The browser Web3 deserves.") with an "Enter Orivon" button;
  clicking it reveals the new-tab page, and it does not come back. `npm run dev` shows it on every
  launch, and `npm run dev -- --skip-intro` skips it. The same mountain-meadow picture is now the
  new-tab page's background, under a dark wash in both colour schemes. The screen loads nothing
  from the network: its font and picture ship with the browser.
- **An app can show a website inside its own page.** A new `web.embed` capability lets an app
  put Electron's `<webview>` element in its page, under one warning-level grant that says what
  it gives: "show any website inside itself, and read and change what those pages show", or the
  sites named. Every page it shows runs apart from the app and from ordinary browsing, in a
  session of the app's own that keeps a site's sign-in across restarts, sandboxed, with no
  `orivon.*`, no popups and no downloads, and it may load documents only from the granted sites.
  `orivon.web.setEmbedScript` sets a script that runs first in every page the app shows, whatever
  that page's own policy says, with a channel back to the element. Revoking the grant closes
  every page the app is showing. An app can also ask, in its manifest, for its pages to be
  served cross-origin isolated, which turns on `SharedArrayBuffer` for a WebAssembly component
  built with threads.
- **`ipfs://` and `ipns://` addresses load, shown as themselves.** Typing or clicking
  `ipfs://<cid>` opens the content with every block checked, exactly as a `.eth` name's is, and the
  address bar, consent dialogs and permissions show `ipfs://<cid>/` while the page runs at an
  ordinary https origin, `https://<cid>.ipfs.orivon`. `ipns://` takes an IPNS key or a DNSLink name.
  A link to one never reaches whatever app claims the scheme on the computer. Protocols now live in
  `src/protocols/`, each registered through one function over data the shell reads, so the next one
  is an isolated piece of work. Registering one while Orivon runs is not built; every address scheme
  shares one routed suffix so that it would need no restart (ADR-0038).
- **The identity seed survives a restart, and an app can hold its own encrypted secret.** The
  seed behind `orivon.id` now lives in the OS keyring (Electron `safeStorage`), not a placeholder
  that refused every call. A new `secrets` capability (`orivon.secrets.available`/`encrypt`/
  `decrypt`) lets a granted app encrypt and decrypt its own data with a key derived from that
  seed, never the seed itself; without a reachable keyring the identity is generated fresh each
  launch and never written to disk, and `available()` says so before an app commits data it would
  lose. The `electron` compatibility package's `safeStorage` now backs the same capability for
  ported apps. Also fixes a real gap: a consent-made `id` grant, the shape every real
  `app.requestGrant()` call produces, was refused for every curve in production until now.
- **`.eth` names load, with every byte checked on this machine.** Typing `vitalik.eth` opens
  `https://vitalik.eth`: a light client (Helios) proves what the name points to on Ethereum, the
  content comes from IPFS gateways with every block hashed against its CID, and anything that
  fails a check is an error page, never the content. A `.eth` app installs through the same one
  dialog and runs from its pin. Settings gains a read-only "Ethereum light client" section naming
  every server it asks. No page can time a `.eth` request to learn which names another site's
  pages opened: the verifier keeps one cache per site (ADR-0030, ADR-0031).
- **The Web3 Score page leads with the Website level**, on every site. Level 2 means the site
  meets DDOC: a `.eth` name's IPFS content, or an installed site whose files match the tree it
  publishes. Levels 3 and up show `?` until a Web3 Score provider judges them, and the page names
  what a provider would assess, the CID or the bundle hash.
- **The address bar's Web3 Score shield now shows the site's Website level directly**, coloured
  red (Level 1, "Web2") / orange / yellow / green (Level 4, "Web3"), instead of the plain
  secure/insecure/cached read it carried before; a plain grey outline until a level resolves. The
  Web3 Score page colours each level the same way. The Delivery ladder collapses from four D1-D4
  rungs to three levels matching the canonical Web3 Score page's own Connection-to-network scale
  (red/yellow/green): D2 is met only by a `.eth` name proven trustlessly whose content is itself
  content-addressed, and nothing in this build reaches D3 automatically. A developer-only file
  (`ORIVON_SCORE_LEVELS_FILE`, gated behind `ORIVON_DEV_ORIGINS=1`) can override either level per
  origin, for previewing Level 3/4 and Delivery Level 3 before a real provider or peer-to-peer
  fetching exist, always named as an override rather than shown as observed.
- **The Web3 Score shield keeps its outline shape, and a Web2 / Web2.5 / Web3 mark names the
  level.** The shield no longer turns into a wide filled badge once a level resolves: it stays the
  outline a new tab shows, its stroke coloured by level. The words move to a mark at the address
  pill's right end, replacing Orivon's logo there: Web2 in orange for Level 1, Web2.5 in yellow for
  Levels 2 and 3, Web3 in green for Level 4. Reloading or finishing a load on the same site no
  longer flashes the shield grey.
- **In developer mode, a local origin that serves a DDOC hash tree is Website Level 2.** A
  loopback URL or a developer `.eth` name has no domain record to anchor its tree, so with
  `ORIVON_DEV_ORIGINS=1` a readable `/.well-known/orivon-ddoc.json` is taken as its DDOC, and the
  Web3 Score page says it is marked only because Orivon is running in developer mode.
- **A site shown at Website Level 4 has its grants presented without warnings**, on every consent
  surface: the install-consent dialog, the `app.requestGrant` prompt, the update-widening prompt,
  the site-info popup's switches and the all-sites settings panel. The words a grant carries never
  change, only the `⚠` marker, the warning background and the native dialog's icon.
- **Every permission row now carries an icon for what it grants** — one glyph per capability kind,
  picked-file/folder kind, or site notification — in the site-info popup and the all-sites panel.

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
- **The chrome view and its popups expose their bridge only at their own URL**; an isolated
  context is locked before its first load, and a refused navigation is logged.
- **Favicons survive a hash change or a same-origin page**, a failed icon fetch no longer holds a
  socket, the icon cache is bounded, and an SVG entity bomb behind a quoted DOCTYPE literal is
  refused.
- **`.eth` pages keep their gateways through a lost race, a cooldown and a hostile answer**: the
  verifier host no longer crashes on a 999 status or stalls on a 101, and every run certificate
  parses.

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
