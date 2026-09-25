# Decision log

Every other page in this repository states how Orivon works. None of them says who decided it or
when. That record lives here, and in the ADRs beside this file.

**The split.** An ADR is for a choice that is load-bearing and expensive to reverse: it gets its
own file, with alternatives and reversibility. Everything else that was decided rather than
derived (a scope call, a wording call, a build-order call) gets one row here. If a page and this
log disagree about what the system does, the page is right and this row is stale.

## What this log is not

It is not a reconstruction of provenance the repository never kept. The `d-NNNN` and `D-NNNN`
tokens below were minted before any register existed ([`../open-questions.md`](../open-questions.md)
A90), so each subject here is recovered from the citations that use it, not from a record kept at
the time. Where a date could not be recovered from a citation, the cell is empty rather than
guessed. Rows with no ID were lifted out of the prose of the documents named beside them.

## Numbered decisions

| ID | Date | Decision | Cited by |
|---|---|---|---|
| `d-0017` | 2026-09-05 | Accepting a below-floor version persists it as the new pin; remembered per origin and never re-prompted | [`ADR-0013`](ADR-0013-rollback-is-warned-and-chosen-not-blocked.md) |
| `d-0020` | 2026-09-06 | `window.orivon`'s `net` surface is built on `contextBridge.executeInMainWorld` | [`ADR-0014`](ADR-0014-main-world-streams-via-experimental-api.md) |
| `d-0021` | | `WriteMessage.chunk` must never exceed `LIMITS.writeWindowBytes`; the caller splits | `src/contracts/ipc.ts` |
| `d-0022` | 2026-09-06 | The user-facing grant prompt is built at build step 4, not step 2 | `../planning/build-plan.md`, `../open-questions.md` A36 |
| `d-0023` | 2026-09-09 | `net.listen` is built in build step 2 rather than deferred, so the flagship can seed | `../planning/build-plan.md`, A97 |
| `d-0024` | 2026-09-09 | The permission prompt is in scope for this round, reviewed as it is built | `../planning/build-plan.md`, A103 |
| `d-0025` | 2026-09-13 | Consent is asked once, before the app's own code runs, for its whole declared set | [`ADR-0012`](ADR-0012-fetch-and-cache-precede-consent.md), A146 |
| `d-0027` | | The connect prompt names the first host and counts the rest, never listing every one | `src/main/consent/grant-prompt-connect.ts` |
| `d-0028` | 2026-09-15 | Each accepted socket's port is delivered over the server's own port (`AcceptedMessage`) | A114, `../architecture/handle-contracts.md` |
| `d-0029` | 2026-09-15 | The folder picker returns a `DirectoryHandle` from `userSelected({ directory: true })` | A167, `../architecture/capability-api.md` |
| `d-0030` | 2026-09-15 | DNS resolution is a broker capability, `OrivonNet.lookup`; there is no `orivon.dns` namespace | A107, A171 |
| `d-0031` | 2026-09-16 | `net.lookup`'s authorising union drops `https.connect`, which never carried a resolver | A190, A193 |
| `d-0032` | 2026-09-16 | The `fs.userSelected` wording gate closed; the FILE shape reuses `fs.open`'s handle-scoped siblings | A187, A194 |
| `d-0033` | 2026-09-17 | AI sessions open one or two PRs per working day, not one per feature | `../development/parallel-work.md`, `CLAUDE.md` |
| `d-0034` | 2026-09-17 | A PR body scales to several changes; a bare "None" is not an answer; `ux:` gains `dev` | `../development/pr-blueprint.md` |
| `d-0035` | 2026-09-22 | The routed `fetch` carries the platform's own property descriptor; a page may replace it, and detection reads the function, not the descriptor | `../../src/preload/README.md`, `ADR-0017` |
| `d-0036` | 2026-09-22 | Dev-mode `.eth` names are declared secure origins, so a `.eth` tab keeps the APIs the loopback URL has | `../development/setup.md`, `../planning/compatibility-matrix.md` |
| `d-0037` | 2026-09-23 | The address pill leads with the Web3 Score shield (replacing the trust dot), then a key hidden until the site has asked for a permission; the cluster's key becomes a tune icon for the all-sites list; the shield opens the site-info popup's Web3 Score page, the key its main page | `../../src/renderer/README.md`, `../../src/main/permissions/README.md` |
| `d-0038` | 2026-09-22 | A routed request whose first hop is refused `'denied'` falls back to the page's native `fetch`/`XMLHttpRequest`/`EventSource`, as an ordinary website would get. AI | `../../src/preload/README.md` |
| `d-0039` | 2026-09-22 | The routed path follows redirects as the Fetch spec does, at most 20 hops, re-checking the grant on every hop with no native fallback mid-chain, and drops `Authorization`, `Cookie`, `Proxy-Authorization` and `Host` on an origin change. AI | A116, `../../src/preload/README.md` |
| `d-0040` | 2026-09-22 | A routed dial refused `'limit'` waits in a FIFO queue (120 s at most, 500 ms retry back-off) instead of failing. AI; provisional numbers | A207, `../../src/preload/README.md` |
| `d-0041` | 2026-09-22 | `XMLHttpRequest` and `EventSource` are routed to granted hosts as `fetch` is; `sendBeacon` stays native, since it is no-cors and never CORS-blocked. AI | `../../src/preload/README.md`, `../planning/compatibility-matrix.md` |
| `d-0042` | 2026-09-22 | A routed response body is streamed with no size cap, read at most 512 KiB ahead of the app; the response head is capped at 256 KiB; a request with no caller signal or timeout fails after 300 s without a byte. AI; provisional numbers | A207, `../../src/preload/README.md` |
| `d-0043` | 2026-09-22 | Routed requests send no default `Origin` or `Referer`, as a native client does; they default `User-Agent` to `navigator.userAgent` and `Accept` to `*/*`. AI | `../../src/preload/README.md` |
| `d-0044` | 2026-09-22 | A peer reset reaches the page as `'reset'` with `platformCode` `ECONNRESET`, carried by a new optional `StreamEndMessage.platformCode` (an additive contract change). AI | `../../src/contracts/ipc.ts` |
| `d-0045` | 2026-09-22 | A routed request's network failure keeps the spec's `TypeError('Failed to fetch')`; the host, errno and reason ride on `error.cause`. AI | `../../src/preload/README.md` |
| `d-0046` | 2026-09-22 | The served CSP's `script-src` carries `'unsafe-eval'` (owner) and `'wasm-unsafe-eval'` (AI); `data:` and `blob:` join `connect-src`, `img-src`, `font-src` and `media-src`; `worker-src 'self' blob:`; `frame-src 'self' data: blob:` (AI) | `../../src/loader/README.md`, A42 |
| `d-0047` | 2026-09-22 | `connect-src` also carries the `https.connect` grant, as scheme-qualified `https://host:port` sources (AI). A `*` host in `https.connect` emits `https:` in `connect-src`, `img-src`, `font-src` and `media-src`, never `wss:`. Owner; reverses A192's standing omission for `https.connect`, while A43's for `tcp.connect` stands | A192, A43, `../../src/broker/policy/README.md` |
| `d-0048` | 2026-09-22 | `form-action` stays unset: it has no fallback to `default-src`, and restricting it would refuse form-post sign-in redirects while bounding nothing navigation leaves open. AI | A42, `../../src/loader/README.md` |
| `d-0049` | 2026-09-22 | The reach path queues an over-allowance request (FIFO, 256 waiters, 30 s) instead of answering 404, caps a redirect chain at 20 hops and returns a redirect bodiless, times a dial out after five idle minutes, and sends CORS headers with a synthetic 204 for a preflight. AI; the queue bounds and idle timeout provisional; the CORS headers inert in Electron 44 | A212, A213, `../../src/loader/README.md` |
| `d-0050` | 2026-09-22 | A dev-granted origin's documents are served the same CSP an installed app's are, appended to the dev server's own. Owner | A211, `../../src/main/dev/README.md` |
| `d-0051` | 2026-09-22 | `MAX_ASSET_BYTES` is 64 MiB and `MAX_BUNDLE_BYTES` 512 MiB, and the loader streams each asset to staging and hashes it incrementally. Owner | A15, `../architecture/bundle-hash.md`, ADR-0009 |
| `d-0052` | 2026-09-22 | A restored app is registered from its verified pinned manifest at startup, without raising the version floor; the fresh manifest's own registration replaces it. Its socket allowance follows the pinned declaration meanwhile. AI | `../../src/loader/README.md`, `../../src/broker/broker-contracts.ts` |
| `d-0053` | 2026-09-22 | The tab that reported a first install which newly registered the origin is reloaded once, after consent, so it runs as the app. AI, then owner: kept on 2026-09-23, reversing A146's 2026-09-15 decline of this option (A234) | A146, A234, `../../src/main/install/README.md` |
| `d-0054` | 2026-09-22 | Loader writes are a temp file renamed over the target, with no `fsync`; an install commits only files that differ from the disk; a bundle that fails verification at startup is not served, so the origin loads as an ordinary site until its hint reinstalls it. AI | A62, `../../src/loader/README.md` |
| `d-0055` | 2026-09-22 | An app is checked for an update at most once an hour (`d-0088` for how); a fetch fails after 20 s without progress, a whole bundle after 30 minutes, and four assets download at once. AI; provisional numbers | A15, `../../src/loader/README.md` |
| `d-0056` | 2026-09-22 | An update does not re-ask for a capability the person already declined: patterns the pinned manifest already declared count as covered, and grant nothing. AI | `../../src/loader/README.md` |
| `d-0057` | 2026-09-22 | An install prunes nothing; a superseded pin's files stay servable, re-verified, until the next start prunes them. AI | A58, `../../src/loader/README.md` |
| `d-0058` | 2026-09-22 | A navigation to an extension-less path the bundle does not pin serves the entry document (the SPA history fallback), told apart by `Upgrade-Insecure-Requests` plus an `Accept` naming `text/html`; `/` redirects to an entry in a subdirectory. AI | `../../src/loader/README.md` |
| `d-0059` | 2026-09-22 | The loader follows same-origin redirects only, at most five; `entry: "index.html"` covers a host that serves the root document at `/`; an HTML response for a `.js`, `.mjs`, `.cjs`, `.css`, `.wasm` or `.json` asset is refused. AI | A141, `../../src/loader/README.md` |
| `d-0060` | 2026-09-22 | `MAX_MANIFEST_BYTES` is 278,400 bytes, so a manifest declaring the most assets a bundle may hold still fits. AI | `../../src/loader/manifest.ts`, A120 |
| `d-0061` | 2026-09-22 | At install, same-origin `src`/`href` in the entry document that the manifest's `assets` omits are logged as a warning, never added. AI | `../../src/loader/README.md` |
| `d-0062` | 2026-09-22 | Handle-scoped I/O (`fs.read`/`write`/`fstat`/`truncate`/`sync`/`close`, `net.close`/`setNoDelay`/`setKeepAlive`) draws on its own pacing budget (4096 burst, 4096/s, at most 1 s wait), not the control bucket. AI; provisional numbers | `../../src/broker/transport/control-limiter.ts` |
| `d-0063` | 2026-09-22 | An operation past the in-flight cap waits in a per-origin FIFO bounded at 256 waiters and 10 s, instead of being refused at once. AI; awaits owner confirmation | A214, `../architecture/handle-contracts.md`, `../../src/contracts/limits.ts` |
| `d-0064` | 2026-09-22 | A connect pattern whose host is exactly `localhost` authorises `127.0.0.1` and `::1` at its port; `localhost` is never resolved. AI; the T12 exception owner-confirmed 2026-09-23 (A215) | A215, `../../src/broker/policy/README.md` |
| `d-0065` | 2026-09-22 | An IPv6 literal request is canonicalised before the connect check and dialled canonical; an IPv4 literal must already be canonical. AI | `../../src/broker/policy/README.md` |
| `d-0066` | 2026-09-22 | A grant replacement keeps each live handle the new patterns still cover and revokes only the rest. AI | A219, `../../src/broker/handles/` |
| `d-0067` | 2026-09-22 | The fs quota counts disk usage: reconciled from disk once per session, `writeFile` charges growth, `rm`/overwrite/`rename` release what they free. AI | A216, `../../src/broker/fs-capability.ts` |
| `d-0068` | 2026-09-22 | An operation on an ended handle answers `'closed'` with `EBADF`, or `'revoked'` when its grant, pick or session was withdrawn. AI | A220, `../../src/broker/handles/README.md` |
| `d-0069` | 2026-09-22 | A socket closed cleanly in both directions frees its handle and its allowance slot. AI | `../../src/broker/transport/port-pump.ts` |
| `d-0070` | 2026-09-22 | The file picker waits `TIMEOUT_MS.grant` (120 s), and a pick landing after its request timed out is closed. AI | `../../src/preload/orivon-surface.ts` |
| `d-0071` | 2026-09-22 | A malformed datagram send is answered `send-failed` with `'invalid'` instead of being dropped. AI | `../../src/broker/transport/` |
| `d-0072` | 2026-09-22 | `WebContext.evaluate` takes an optional `{ timeoutMs }` that can only shorten the platform deadline (an additive contract change), and a pending `evaluate` settles when its context closes, as a contract property. AI | `../../src/contracts/handles.ts` |
| `d-0073` | 2026-09-22 | Every Node-shaped path the shim presents (cwd, homedir, userData, `$HOME`, `$APPDATA`, `$TMPDIR`) is rooted at one virtual `/orivon/app`, tmpdir `/orivon/app/tmp`; the fs shim strips it and refuses a path outside it with `EACCES`. AI; provisional value | `../../src/shim/README.md` |
| `d-0074` | 2026-09-22 | The shim's `util` is the `util` package plus Node-exact `promisify`, `inherits`, `isDeepStrictEqual` and `TextEncoder`/`TextDecoder`, accepting about thirty small transitive packages. AI | `../../src/shim/README.md`, `../planning/shim-dependency-review.md` |
| `d-0075` | 2026-09-22 | The shim hand-writes `url`, `querystring`, `string_decoder`, `timers`, `timers/promises` and `assert`, and resolves `node:`-prefixed and subpath specifiers. AI | `../../src/shim/module-map.ts` |
| `d-0076` | 2026-09-22 | The shim's `tls` runs over `connectSecure`; options that change who is trusted refuse by name; `rejectUnauthorized: false` is accepted with verification left on. AI; superseded on 2026-09-23 by the owner's `d-0097` (A227) | A227, `../../src/shim/README.md` |
| `d-0077` | 2026-09-22 | `net.Server` refuses a loopback-only listen host rather than widening it to every interface. AI | A225, `../../src/shim/README.md` |
| `d-0078` | 2026-09-22 | An errno the shim synthesises uses Linux numbering. AI | `../../src/shim/README.md` |
| `d-0079` | 2026-09-22 | `process` reports `versions` `{}`, `version` `''`, `argv` `[]`, `pid` 1, `arch` `'javascript'` and `release.name` `'browser'`; `nextTick`/`setImmediate` errors reach the page's `reportError`; `setImmediate` is a `MessageChannel` task. AI; the values provisional | A223, `../../src/shim/README.md` |
| `d-0080` | 2026-09-22 | Tabs report a plain Chrome User-Agent, with no `Electron/` or `orivon/` token. AI | `../../src/main/shell/README.md` |
| `d-0081` | 2026-09-22 | A popup the page can talk to is Chromium's own webContents adopted as a tab in its opener's session; `noopener`, links and cross-session opens become ordinary tabs; a popup into an isolated app always opens in that app's own session. AI | A230, `../../src/main/shell/README.md`, `../architecture/security-model.md` T18 |
| `d-0082` | 2026-09-22 | A `beforeunload` guard raises a synchronous Leave/Stay prompt. AI | A231, `../../src/main/shell/README.md` |
| `d-0083` | 2026-09-22 | Tabs and the address bar get a right-click context menu. AI | `../../src/main/shell/README.md` |
| `d-0084` | 2026-09-22 | App tabs keep Chromium's default background throttling, for now. Owner | `../planning/compatibility-matrix.md` |
| `d-0085` | 2026-09-22 | App tabs get the `buffer` package as a `Buffer` page global (writable, configurable, non-enumerable), installed through `contextBridge.executeInMainWorld` with the package inlined at build time, and the shim's `buffer` module adopts it so `instanceof` agrees. Chosen over `webFrame.executeJavaScript`, whose before-page-scripts timing is observed rather than documented, and over the `Function` constructor, which a page CSP without `'unsafe-eval'` blocks. AI | A221, A235, `../../src/preload/README.md` |
| `d-0086` | 2026-09-22 | The manifest parser ignores an unknown top-level field and the loader logs a warning naming it (at most 20 named); an unknown field anywhere inside `capabilities` still rejects the manifest, and `orivonApiVersion` stays exact. Owner | `../architecture/capability-api.md`, `../../src/loader/README.md` |
| `d-0087` | 2026-09-22 | A revoke in the permissions panel is recorded as a declined capability, so the install-consent dialog does not ask for it again; `app.requestGrant` is unaffected, and an accepted request clears the record. AI; provisional | A237, `../../src/main/permissions/README.md` |
| `d-0088` | 2026-09-22 | The update-check time is persisted per origin (`apps/<hash>/update-check.json`), and once the interval passes the manifest request is conditional (`If-None-Match`/`If-Modified-Since`, validators tied to the pinned manifest's leaf and sanitised); a 304 means up to date. AI; provisional | A236, A238, A239, `../../src/loader/README.md` |
| `d-0089` | 2026-09-22 | Serving streams each asset from disk in 64 KiB positional reads, Range kept; a retained previous-pin file's leaf verdict is memoised per file identity (size, mtime, inode); a HEAD gets headers only. AI; provisional | `../../src/loader/README.md` |
| `d-0090` | 2026-09-22 | An app tab's `WebSocket` to a granted cross-origin host is routed over `orivon.net`: `wss:` under `https.connect` via `connectSecure`, `ws:` under `tcp.connect` via `connect`, an RFC 6455 client in the page with no extension offered. An ungranted or same-origin socket stays native under the page's CSP. AI | A211, A240, ADR-0017, `../../src/preload/README.md` |
| `d-0091` | 2026-09-22 | The dev CSP adds no `ws:` source for hot reload: `connect-src 'self'` is measured to admit a `ws:` socket to the page's own host and port in Electron 44. AI | A241, `../../src/main/dev/README.md` |
| `d-0092` | 2026-09-22 | The permission gate allows `pointerLock` and `keyboardLock` without asking; the shell draws "Press Esc to show your cursor" and "Press and hold Esc to exit full screen". Owner | ADR-0026 |
| `d-0093` | 2026-09-22 | An external link (`openExternal`) opens only when the person allows it, asked every time, with the URL shown and the dangerous schemes never offered. Owner | ADR-0027 |
| `d-0094` | 2026-09-22 | A site shows notifications only after the person allows it; Allow and Block are remembered per origin, Not now is not. Owner | ADR-0028, A243 |
| `d-0095` | 2026-09-22 | A Chromium permission passes the gate on one of two grounds: platform gating plus a legacy path or a shell-drawn affordance, or a real prompt the person answers. Owner | A202, `../../src/main/sessions/README.md` |
| `d-0096` | 2026-09-23 | A popup an app opens onto the open web keeps the app's session until its opener closes, so a sign-in provider's cookies land in the app partition; accepted as an `ADR-0018` residual. Owner | A230, `../../src/main/shell/README.md` |
| `d-0097` | 2026-09-23 | `connectSecure` honours `rejectUnauthorized`, `ca`, `cert`/`key`/`pfx`/`passphrase`, `servername` and ALPN, and reports the handshake; `rejectUnauthorized: false` really skips verification. The owner's words: "Select the option that ensures most compatibility with Electron apps." Supersedes `d-0076`. Owner | ADR-0017, A224, A227, A229 |
| `d-0098` | 2026-09-23 | A TLS option that unbinds the certificate from the granted name (`rejectUnauthorized: false`, the app's own `ca`, another `servername`) adds `checkConnect`'s resolve-once address check, and only the checked literal is dialled. AI; awaits owner confirmation | A248, ADR-0017, `../architecture/security-model.md` T12, `../../src/broker/README.md` |
| `d-0099` | 2026-09-23 | A custom `checkServerIdentity` runs in the shim, in Node's order, and its connection is address-checked; SNI defaults to the host; `https` sends the Host header's name as SNI, as Node's agent does. AI | `../../src/shim/README.md` |
| `d-0100` | 2026-09-23 | STARTTLS (`tls.connect({ socket })`) stays refused by name. AI | A226 |
| `d-0101` | 2026-09-24 | A site publishes its bundle hash tree at `/.well-known/orivon-ddoc.json`, root and every leaf; the Web3 Score page shows DDOC as verified, failed (naming the files), not published or not checked; none of them blocks a load, since acting on a failure is the Web3 Score's job. Owner | ADR-0029, `../architecture/bundle-hash.md` |
| `d-0102` | 2026-09-24 | DDOC does not depend on trustless resolution: it is the website axis, and trust in a DNS answer is the connection axis's question. DDOC's anchor in this build is the site's own host, *provisional*. Reverses A4b's premise. Owner | ADR-0029, ADR-0006, A4b, `../mvp-scope.md` |
| `d-0103` | 2026-09-24 | An `id` grant with empty `patterns` (every consent-made grant: `manifest-patterns.ts` maps `id` presence-only) authorises whatever curves the origin's currently-registered manifest declares, re-checked live, not frozen at grant time; a non-empty `patterns` list (the dev-only grant hook) still narrows further. Fixes a real gap: every consent-made `id` grant was refused in production before this. AI | `../../src/broker/id-capability.ts` |
| `d-0104` | 2026-09-24 | `LIMITS.secretBytes` (the largest `orivon.secrets.encrypt` plaintext) is 64 KiB. AI; provisional | ADR-0033, `../../src/contracts/limits.ts` |
| `d-0105` | 2026-09-24 | The roadmap: there is no flagship app. Build step 4 is the app loader with DDOC among its features; step 5 ports Node.js desktop apps as the platform's test cases; step 6 is ENS and IPFS, trust-minimised; the trust indicator is step 7. The torrent app and Nostr identity are ideas, not build steps. Journeys 1 and 3 become a ported desktop app from a URL and a verified `.eth` name. Owner | [`ADR-0001`](ADR-0001-flagship-app-bittorrent-streaming.md), `../mvp-scope.md`, `../planning/build-plan.md`, A249 |
| `d-0106` | 2026-09-24 | Judged score levels are in scope; their provider need not be trustless, and may be local. Owner | [`ADR-0006`](ADR-0006-trust-indicator-from-observed-behaviour.md), `../mvp-scope.md`, A250 |
| `d-0107` | 2026-09-24 | DDOC's off-host anchor is in scope, as the `.eth` name's ENS record read at build step 6; a DNS record stays out. Owner | [`ADR-0029`](ADR-0029-sites-publish-their-bundle-hash-tree.md), `../mvp-scope.md` |

## Directives

A separate, earlier series, minted in the owner's own working notes rather than in this
repository. Recorded here because source comments and documents cite the tokens.

| ID | Date | Directive | Cited by |
|---|---|---|---|
| `D-0002` | | Never launch Electron in a way that can steal window focus or orphan a process tree | `.claude/` launch rules, `orivon-electron` skill |
| `D-0004` | | The grant prompt gets no details-expander: a narrow declaration must not look like an unlimited one | A100-adjacent, `src/main/README.md` |
| `D-0005` | | Approve the wider eight-package shim dependency set, not the review's narrower five | `../planning/shim-dependency-review.md`, `../planning/compatibility-matrix.md` |
| `D-0006` | | DNS resolution happens in the broker, because a sandboxed renderer has no resolver | `src/contracts/capability-api.ts`, A107 |
| `D-0007` | 2026-09-09 | A picked folder is remembered across restarts and revocable from the settings list | A167, `../architecture/handle-contracts.md` |
| `D-0010` | 2026-09-10 | Item 2: any navigation repartitions a tab, not only a typed one. Item 4: wiring `app.requestGrant` to the page is the highest-reach item | A108/A109, `src/main/README.md` |
| `D-0013` | | Correct `README.md`'s status banner in the same PR that makes it false | `../planning/step-4-app-loader-plan.md` |

## Decisions lifted out of the pages

No ID was ever minted for these. They were stated inline in the documents named beside them, and
moved here so those documents can state the behaviour without the provenance.

| Date | Decision | Was stated in |
|---|---|---|
| 2026-08-25 | Signed/unsigned trust tiers and `publisherKey` cut from v0; integrity is hash-pinning alone | `../architecture/capability-api.md`, ADR-0002, ADR-0005 |
| 2026-08-25 | Grants are keyed on `(origin, capability, pattern set)`, never on the capability kind | `../architecture/capability-api.md`, `../architecture/security-model.md` T19 |
| 2026-08-25 | Handles are WHATWG streams; Node shapes are reconstructed by the shim (A10) | ADR-0008, `../architecture/capability-api.md` |
| 2026-08-25 | The success metric is stated on `activeSec`, not on time the app is open | ADR-0004, `../mvp-scope.md` |
| 2026-08-25 | The "115-130 installs" figure is withdrawn; the honest funnel is thousands of downloads | `../mvp-scope.md` |
| 2026-08-25 | App #3 for the genericity test is the e2e fixture app | `../mvp-scope.md` |
| 2026-08-25 | MP4/H.264 only in v0; MKV waits on a post-launch remuxer | `../planning/build-plan.md`, `../mvp-scope.md`, `README.md` |
| 2026-08-25 | Auto-install of updates is cut; v0 checks and notifies | `../planning/build-plan.md`, `ARCHITECTURE.md` |
| 2026-08-25 | Tier-2 examples corrected: the hardware-wallet cluster is blocked on `hid` | `../architecture/app-compatibility.md` |
| 2026-08-26 | Address-bar search via DuckDuckGo, added at build step 1 | `../mvp-scope.md` IN table |
| 2026-08-26 | Apps get the specific failure reason inside their grant; `denied` stays uniform | `../architecture/handle-contracts.md` §Errors |
| 2026-08-27 | `origin` and `identityId` frozen: canonical origin, broker-generated opaque id | ADR-0010, `../architecture/capability-api.md` |
| 2026-08-27 | Code guidelines: comments earn their place, 500-line files, one implementation per idea | `../development/code-guidelines.md` |
| 2026-08-27 | Bundle-hash vector V5 re-expressed in percent-encoded form; the table is closed | ADR-0009, `../architecture/bundle-hash.md` |
| 2026-08-28 | Bookmarks bar, real tab favicons and the new-tab dashboard added to scope | `../mvp-scope.md` IN table, ADR-0003 |
| 2026-09-03 | There is no "open as app" action; the `<link>` hint is the only discovery trigger | `ARCHITECTURE.md`, `../architecture/capability-api.md`, `../mvp-scope.md` |
| 2026-09-03 | DDOC expands to "Domain Data Ownership Confirmation", canonical everywhere | `../glossary.md`, open-questions C1 |
| 2026-09-03 | `+Privacy` placement withdrawn as a question; it follows from each ladder's top rung | `../glossary.md`, ADR-0006, open-questions B3 |
| 2026-09-04 | A below-floor version is warned and chosen, never silently blocked | ADR-0013, `../architecture/security-model.md` T19 |
| 2026-09-04 | Rule 2 is enforced in CI by `check:size`; Rule 3 stays unenforced | `../development/code-guidelines.md` |
| 2026-09-05 | An acknowledged rollback that also widens authority still prompts | ADR-0013, `../architecture/security-model.md` T19 |
| 2026-09-10 | The async rule narrows to network operations; `fs` gains `readFileSync` | ADR-0016, `../architecture/capability-api.md` |
| 2026-09-15 | `main` syncs with `origin` by `--ff-only`, unprompted on a clean tree; on a dirty tree the agent reports and does not act | `CLAUDE.md` |
| 2026-09-21 | Ported third-party apps and the porting harness move to `orivon-ports`; `apps/` here keeps the flagship and the test fixtures | ADR-0020, `CLAUDE.md`, `ARCHITECTURE.md` |
| 2026-09-22 | A port couples to the shell through storage assertions, not only a test path; where those assertions belong is unsettled | ADR-0020, open-questions B5 |
| 2026-09-22 | The apps the test suite serves move to `test/apps/`; there is no top-level `apps/` directory. `test/apps/` is carved out of Rule 2's "test file" definition so the comment and size guards keep covering it | ADR-0020, `CLAUDE.md`, `ARCHITECTURE.md`, `../development/code-guidelines.md` |
| 2026-09-22 | `apps/torrent/` is removed; the flagship has no directory here until build step 5 opens, and `build-plan.md` holds its design | ADR-0001, `../planning/build-plan.md`, `../mvp-scope.md` |
| 2026-09-22 | `src/main/` is organised into nine job-named directories, following the naming convention (not the directory count) `src/broker/` set | ADR-0023, ADR-0015 |

## Adding a row

Mint the next `d-NNNN` and add a row here in the same change that acts on the decision. End the
decision with who took it: `Owner`, or `AI` for an AI recommendation accepted by default, and
mark it *provisional* when a measurement or the owner's confirmation is still to settle it. Then
state the behaviour in the document it governs, **without the provenance**: the page says what
the system does, this log says who decided it and when.

If the choice is load-bearing and expensive to reverse, it is an ADR instead
([`ADR-0000-template.md`](ADR-0000-template.md)), and this log does not duplicate it.
