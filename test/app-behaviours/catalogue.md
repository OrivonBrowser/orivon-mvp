# What an app relies on

One row per behaviour a working app counts on, stated as something a person or a test could see,
and tied to the end-to-end spec that proves it. The suites in [`testing.md`](../../docs/development/testing.md) are grouped
by what Orivon built. This page is grouped by what an app needs, so a change that breaks an app turns
a test red whose title carries the behaviour's id, whichever file the change was in.

[`check:app-behaviours`](../../scripts/app-behaviours/check-app-behaviours.mjs) keeps this page and the specs in step:

- each row names an `e2e-*.test.ts` spec that runs in CI, and that spec has a test titled
  `[app:<id>]`; a unit test may be listed beside it but never proves a row alone;
- no spec carries an `[app:<id>]` this page lacks;
- a row that no spec proves yet says `not covered: <reason>`, and the reason is the debt.

[`testing.md`](../../docs/development/testing.md) section App behaviours says how to add a row. **A row changes only with a line
under `### Changed for apps` in [`CHANGELOG.md`](../../CHANGELOG.md)** (`**<id>**: what changed. Apps
that do Y must now do Z. Recheck: the ports.`): CI fails a pull request that rewrites or removes a
behaviour's sentence without one, and the same for a change to the public surface of `src/contracts/`
(section The contracts surface in [`testing.md`](../../docs/development/testing.md)). The matrix of what works today is
[`compatibility-matrix.md`](../../docs/planning/compatibility-matrix.md); this page is its test-side index.

Ports are named only where the compatibility pages already name them.

## Consent and grants

| Id | Behaviour | Apps that rely on it | Ports | Proven by |
|---|---|---|---|---|
| `consent-question-holds-the-page` | The first visit to an origin that declares capabilities opens a question in the tab's own window, and the page waits where it is until the person answers; an app opened from an `ipfs://` address asks before it runs | every app that declares a capability | all | [`e2e-consent-navigation-hold`](../app-loading/e2e-consent-navigation-hold.test.ts), [`e2e-ipfs-install`](../web3/e2e-ipfs-install.test.ts) |
| `loopback-manifest-hint-grants-the-origin` | A page on a loopback origin that links its manifest with `<link rel="orivon-manifest">` is asked about, and on Allow the grants attach to that origin on the shared session, with nothing installed | an app served by a plain static server | FreeTube, The Lounge | [`e2e-loopback-grant`](../app-loading/e2e-loopback-grant.test.ts) (the `e2e-ordinary` CI job) |
| `granted-capabilities-are-reported` | `orivon.app.grants()` lists nothing before the person allows, and lists what was allowed after | apps that adapt to what they were granted | ASGARDEX, FreeTube | [`e2e-site-info`](../sites/e2e-site-info.test.ts) |
| `local-file-grant` | A file opened from this computer that links its manifest is asked about with a warning whose Allow needs a second press; one press grants nothing, and after the second its capabilities, its saved files and its inline script work, again after a restart with no question; a sibling file is another origin and is asked again | apps shipped as files and opened from disk | none | [`e2e-app-local-file`](./e2e-app-local-file.test.ts) |
| `declined-capability-is-refused` | A capability the person turned off is refused to the page's own calls, and `requestGrant` resolves false on Deny | apps that run with less than they declared | ASGARDEX | [`e2e-site-info`](../sites/e2e-site-info.test.ts) |
| `empty-manifest-registers-silently` | A manifest that declares no capability registers the origin and shows no question | read-only sites and apps | AirGap Vault | not covered: unit tests only (`install-consent.test.ts`, `app-install.test.ts`); `e2e-eth-install` answers whatever question appears and never asserts that none did |
| `plain-http-grant-is-session-scoped` | A grant to a plain `http` loopback origin or a developer `.eth` name lasts one launch and is asked again at the next | apps tried from a local static server | FreeTube, ASGARDEX | not covered: unit tests only (`origin.test.ts`); the developer grant the e2e suite uses bypasses the ledger |

## Network

| Id | Behaviour | Apps that rely on it | Ports | Proven by |
|---|---|---|---|---|
| `routed-fetch-reaches-granted-hosts` | A page `fetch` or `XMLHttpRequest` to a granted cross-origin host succeeds with no CORS check and keeps the headers the app sets | apps with a REST or video API | FreeTube, ASGARDEX, Element | [`e2e-fetch-routing`](../capabilities/e2e-fetch-routing.test.ts) |
| `routed-fetch-delivers-whole-body` | A long response body arrives whole, across garbage collections, whether sent with a length or chunked | apps that stream large responses | FreeTube | [`e2e-routed-body-gc`](../capabilities/e2e-routed-body-gc.test.ts) |
| `routed-fetch-follows-redirects` | A routed `fetch` follows redirects to a granted host up to a bounded count | apps behind redirecting APIs | Element | not covered: unit tests only (`fetch-redirect.test.ts`); no spec drives a redirect through an app's `fetch` |
| `routed-fetch-sends-formdata` | A routed `fetch` accepts a `FormData` body | apps that upload | Element | not covered: unit tests only (`fetch-flow.test.ts`); no spec posts a form through an app's `fetch` |
| `tcp-connect-to-granted-loopback-port` | A connection to the exact loopback `host:port` the manifest names reaches it, and bytes come back | apps that talk to a local daemon | The Lounge | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `wildcard-host-never-reaches-loopback` | A `*:*` grant does not reach a loopback or private address, even where something listens; the call is refused as `denied` | every app with `*:*` | The Lounge, ASGARDEX | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `reserved-port-needs-exact-pattern` | A `*:*` grant does not reach a reserved port such as 6667; only a pattern naming the port does | apps that dial IRC or other fixed services | The Lounge | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `concurrent-sockets-limit-holds` | With `concurrentSockets` set, the socket past the limit is refused as `limit`, and one opens again after a close | apps that open many sockets | The Lounge, ASGARDEX | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `tls-self-signed-refused-unless-opted-out` | `connectSecure` refuses a self-signed server as `unreachable` with a platform code, and reaches it, unauthorized, when the app passes `rejectUnauthorized: false` | apps for servers with their own certificates | The Lounge | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `local-listener-accepts-connections` | An app granted a local listener port accepts connections on `127.0.0.1` from other programs | apps that embed a server | The Lounge | [`e2e-http-server`](../node-runtime/e2e-http-server.test.ts) |
| `second-listener-gets-eaddrinuse` | Listening on a port another program holds fails with `EADDRINUSE` | apps that detect a running copy of themselves | The Lounge | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `page-media-from-own-listener` | An app that holds a `tcp.listen` grant plays `<audio>` and `<video>` and shows `<img>` from `http://localhost` or `http://127.0.0.1` on a port its own listener holds, and a request from the same page to any other loopback port is cancelled before it connects; a page with no listen grant loads loopback images as before | apps that serve media to their own player | WebTorrent | [`e2e-app-own-listener-media`](e2e-app-own-listener-media.test.ts) |

## Files and stored data

| Id | Behaviour | Apps that rely on it | Ports | Proven by |
|---|---|---|---|---|
| `fs-confined-to-app-root` | A path that climbs out of the app's files directory is refused as `denied` | every app that writes files | all | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `fs-quota-refuses-past-limit` | A write that would pass `quotaBytes` is refused as `limit` and the earlier files stay whole | apps with a declared store size | ASGARDEX, FreeTube | [`e2e-app-broker-rules`](./e2e-app-broker-rules.test.ts) |
| `app-files-survive-restart` | A file an app wrote through `orivon.fs` is there after the browser restarts on the same profile | every app with state | ASGARDEX, The Lounge | [`e2e-app-state-restart`](./e2e-app-state-restart.test.ts) |
| `atomic-write-by-rename` | Writing a temporary file and renaming it over an existing one leaves the new contents | libraries that save atomically | The Lounge | [`e2e-app-state-restart`](./e2e-app-state-restart.test.ts) |
| `node-fs-writes-land-at-app-root` | Node-shaped `fs` calls, from the page, a forked child or a worker, write into the app's files and read back | ported Node programs | FreeTube, The Lounge | [`e2e-child-process`](../node-runtime/e2e-child-process.test.ts), [`e2e-sqlite`](../node-runtime/e2e-sqlite.test.ts) |
| `page-sync-fs-writes-land` | The page can call Node's synchronous path-based `fs` (`mkdirSync`, `writeFileSync`, `copyFileSync`, `statSync`, `readdirSync`, `renameSync`, `readFileSync`, `rmSync`): what they write is what `orivon.fs` and `fs.promises` read back, a write past the declared quota is refused as `limit`, and a call that holds a file handle (`openSync`) is refused by name | ported Node programs that run Node in their window | WebTorrent | [`e2e-page-sync-fs`](../node-runtime/e2e-page-sync-fs.test.ts) |
| `indexeddb-survives-restart` | Data an app writes to IndexedDB is there after the browser restarts on the same profile | web apps with local databases | Element, FreeTube | [`e2e-app-state-restart`](./e2e-app-state-restart.test.ts) |
| `localstorage-survives-restart` | `localStorage` values survive a restart | web apps with settings | Element, AirGap Vault | [`e2e-app-state-restart`](./e2e-app-state-restart.test.ts) |
| `non-extractable-cryptokey-survives-restart` | A non-extractable `CryptoKey` stored in IndexedDB still decrypts after a restart | apps that wrap secrets with a stored key | Element | [`e2e-app-state-restart`](./e2e-app-state-restart.test.ts) |
| `sessionstorage-survives-cross-origin-return` | `sessionStorage` is the same when a tab leaves the app's origin and comes back | apps that sign in through a provider | Element | [`e2e-session-storage-return`](../sites/e2e-session-storage-return.test.ts) |
| `clearing-site-data-removes-app-files` | Clearing an app's site data removes the files it wrote | apps that offer a reset | The Lounge | not covered: no spec clears site data and then reads the app's files |
| `user-picked-file-and-folder-handles` | `orivon.fs.userSelected` hands back a file or a folder the person chose, and the app can write into the folder | apps that export or download to a chosen place | ASGARDEX, FreeTube | not covered: unit tests only (`handles-user-selected.test.ts`); the native picker cannot be driven headless |

## The page on an app's origin

| Id | Behaviour | Apps that rely on it | Ports | Proven by |
|---|---|---|---|---|
| `secure-context-on-app-origin` | An app's loopback origin is a secure context, with `crypto.subtle` and `crypto.randomUUID` | apps that hash, sign or make ids | Element, AirGap Vault | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `history-back-forward-in-app` | `history.back()` and `history.forward()` move through the entries the app pushed | single-page apps | Element | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `service-worker-registers-on-app-origin` | A service worker registers on the app's origin and answers a message from the page | apps with offline or push workers | Element | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `wake-lock-request-settles` | `navigator.wakeLock.request` settles, granted or refused, and never hangs | video and call apps | FreeTube, Element | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `window-open-noopener-opens-tab` | A click that runs `window.open(url, '_blank', 'noopener,noreferrer')` opens a tab whose `window.opener` is null | apps with external links | ASGARDEX | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `web-lock-held-until-tab-closes` | While one tab holds an exclusive Web Lock another tab of the origin waits, and closing the first lets it proceed | apps that allow one live copy | Element | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `pagehide-fires-on-tab-close` | Closing a tab fires `pagehide` in its page | apps that clean up on exit | Element | [`e2e-app-origin-platform`](./e2e-app-origin-platform.test.ts) |
| `wasm-streaming-under-served-csp` | `WebAssembly.instantiateStreaming` of a served `.wasm` works under the app's served policy | apps with WebAssembly | Element, AirGap Vault | [`e2e-served-csp`](../app-loading/e2e-served-csp.test.ts) |
| `blob-worker-runs` | A worker started from a `blob:` URL runs under the app's served policy | apps that compute in workers | AirGap Vault | [`e2e-served-csp`](../app-loading/e2e-served-csp.test.ts) |
| `sandboxed-frame-with-csp-runs-served-script` | A `sandbox="allow-scripts"` frame with a `csp` attribute runs a script the app serves | apps that evaluate code in a frame | FreeTube | not covered: only the real FreeTube spec drives it, and that needs a ports checkout; `e2e-served-csp` runs a `data:` frame without the `sandbox` and `csp` attributes |
| `cross-origin-isolated-when-declared` | A page whose manifest asks for isolation reports `crossOriginIsolated`, and one that does not asks for it is not isolated | apps with threads or shared memory | The Lounge | [`e2e-wasm-threads`](../node-runtime/e2e-wasm-threads.test.ts) |
| `page-globals-replaceable` | A global Orivon installs on a page can be assigned over, shadowed and deleted by the app | bundles that ponyfill `Buffer` or `fetch` | FreeTube, The Lounge | [`e2e-page-buffer`](../node-runtime/e2e-page-buffer.test.ts) |
| `clipboard-write-without-prompt` | A page writes to the clipboard on a click with no question | apps with copy buttons | AirGap Vault | [`e2e-clipboard-write`](../capabilities/e2e-clipboard-write.test.ts) |
| `page-declared-favicon-shows` | A page's `<link rel="icon">` shows in its tab, and comes back on a return after a blank page or a failed load | every app | all | [`e2e-tab-favicon`](../tabs/e2e-tab-favicon.test.ts) |
| `target-blank-link-opens-tab` | A `target="_blank"` link opens a tab | apps with external links | ASGARDEX, The Lounge | [`e2e-link-open`](../tabs/e2e-link-open.test.ts) |
| `window-open-external-address-asks` | A page's `window.open` of an address another program handles (`mailto:`, `magnet:`) raises the external-link question, as a click on a link to it does, and opens no tab | apps that hand links to the system | WebTorrent | [`e2e-app-electron-clipboard-shell`](e2e-app-electron-clipboard-shell.test.ts) |
| `electron-clipboard-reads-the-pasted-text` | The `electron` shim's `clipboard.readText()` answers the text being pasted while a `paste` event is dispatched and `''` at any other time, and `writeText` copies through the browser and returns nothing | apps that add what the person pastes | WebTorrent | [`e2e-app-electron-clipboard-shell`](e2e-app-electron-clipboard-shell.test.ts) |
| `electron-shell-open-external-opens-a-tab` | The `electron` shim's `shell.openExternal(url)` opens an address in a new tab, hands an address another program handles to the external-link question, and rejects with `invalid-usage` a value that is not an absolute URL | apps with links to the outside | WebTorrent | [`e2e-app-electron-clipboard-shell`](e2e-app-electron-clipboard-shell.test.ts) |
| `media-element-track-lists` | In an app's tab every `<audio>` and `<video>` element has the standard `audioTracks` and `videoTracks` lists (empty before media loads), so a player that reads their `length` on `loadedmetadata` works; an ordinary site's tab keeps Chromium's default, which has neither | media players | WebTorrent | [`e2e-app-media-tracks`](e2e-app-media-tracks.test.ts) |

## Running code and showing other pages

| Id | Behaviour | Apps that rely on it | Ports | Proven by |
|---|---|---|---|---|
| `fork-runs-module-in-worker` | `child_process.fork` of a bundled module runs it in a Worker with its own `fs`, and its output and exit come back | ported Node servers | The Lounge | [`e2e-child-process`](../node-runtime/e2e-child-process.test.ts) |
| `forked-child-ends-with-last-page` | A forked child outlives the tab that started it and ends when the app's last page closes | ported Node servers | The Lounge | [`e2e-child-host`](../node-runtime/e2e-child-host.test.ts) |
| `node-sqlite-in-worker` | `node:sqlite` in a forked child opens a real database file in the app's files | apps with an embedded database | The Lounge | [`e2e-sqlite`](../node-runtime/e2e-sqlite.test.ts) |
| `webview-shows-local-pattern` | An app granted `web.embed` for a loopback pattern shows that page in a `<webview>` and talks to it | apps that serve their own UI | The Lounge | [`e2e-embed-local`](../capabilities/e2e-embed-local.test.ts) |
| `webview-popup-reaches-the-app` | A window request or a download from a page shown in a `<webview>` reaches the app as one bubbling event, and nothing opens and no file is written until the app decides | apps that embed a site | The Lounge | [`e2e-embed-events`](../capabilities/e2e-embed-events.test.ts) |
| `web-context-open-evaluate-close` | `orivon.web.openContext` opens a hidden page on a granted origin, `evaluate` runs in it, and `close` ends it | apps that need a site's own scripts | FreeTube | [`e2e-web-context`](../capabilities/e2e-web-context.test.ts) |
| `app-media-declared-is-asked-once` | An app that declares `media.camera` or `media.microphone` is asked at its first `getUserMedia` for that kind, in the tab's own panel, and the page waits for the answer; on Allow it gets the stream and is not asked again, on Deny it gets `NotAllowedError` and is not asked again on that page load | apps with calls or recording | - | [`e2e-app-media`](e2e-app-media.test.ts) |
| `app-media-undeclared-is-refused` | An app that does not declare `media.camera` or `media.microphone` is refused `getUserMedia` for it with `NotAllowedError` and no question | apps that run with less than they could ask for | - | [`e2e-app-media`](e2e-app-media.test.ts) |
| `app-screen-declared-shows-the-picker` | An app that declares `media.screen` is asked at its first `getDisplayMedia`, in the tab's own panel; on Allow Orivon's picker opens and what the person chooses is what the app receives, with no second question on the next share | screen-sharing and recording apps | - | [`e2e-app-screen-share`](e2e-app-screen-share.test.ts) |
| `app-screen-undeclared-is-refused` | An app that does not declare `media.screen` is refused `getDisplayMedia` with `NotAllowedError`, and neither a question nor the picker appears | apps that run with less than they could ask for | - | [`e2e-app-screen-share`](e2e-app-screen-share.test.ts) |
| `electron-desktop-capturer-serves-the-picked-source` | The `electron` shim's `desktopCapturer.getSources` opens Orivon's picker and resolves the one source the person chose, with a one-frame `thumbnail`; the legacy `getUserMedia` call with `chromeMediaSource: 'desktop'` and that source's id returns that stream (video only) once, and any other `chromeMediaSource` id is refused with `NotAllowedError` | ported Electron apps that share a screen | - | [`e2e-app-screen-share`](e2e-app-screen-share.test.ts) |

## Names and addresses

| Id | Behaviour | Apps that rely on it | Ports | Proven by |
|---|---|---|---|---|
| `eth-name-loads-verified` | A `.eth` name loads through ENS and IPFS with every block verified, and tampered blocks are refused | apps published to a name | - | [`e2e-eth-verified`](../web3/e2e-eth-verified.test.ts) |
| `ipfs-url-opens` | An `ipfs://` address, or an `ipns://` name or key, opens the site behind it | apps published by content address or under an IPNS key | - | [`e2e-ipfs-address`](../web3/e2e-ipfs-address.test.ts) |
| `installed-app-moves-only-when-accepted` | An app installed at a name keeps running the version it was installed at, in every tab, while the name points at newer content; the person is asked, and only on Yes does every tab show the new version, which the next start keeps without asking again | apps published to a name that ships new builds | - | [`e2e-eth-app-update-verified`](../web3/e2e-eth-app-update-verified.test.ts) |
| `score-lookup-needs-the-trust-grant` | A page that declared `trust.score` and was not granted it is refused `denied` by `orivon.trust.websiteScore`, also after the person answered Deny, and nothing is asked of the provider; one that is granted and asks in a loop is refused `limit` once its bucket of 128 lookups is spent | apps that show a mark per site from the person's own Web3 Score provider | Orivon Explore (`explore`) | [`e2e-trust-website-score`](../web3/e2e-trust-website-score.test.ts) |
| `score-lookup-answers-the-chosen-provider` | A page granted `trust.score` gets the chosen provider's name and the level it judged for an `ipfs://` address and for a `.eth` name (bare or over `https`); a web address, content the provider has no score for and text that is no address answer level `null`; with no provider chosen the answer is `null` and nothing is asked; the provider receives buckets, never an identifier | apps that show a mark per site from the person's own Web3 Score provider | Orivon Explore (`explore`) | [`e2e-trust-website-score`](../web3/e2e-trust-website-score.test.ts) |

## Capability coverage

Every capability kind in `src/contracts/manifest.ts` has a line here: the rows that say what an app can count
on once it holds the capability, or `not covered: <reason>`. A kind added to the contract fails CI until it
has a line, so a capability cannot land without that decision.

| Capability | Proven by rows |
|---|---|
| `tcp.connect` | `tcp-connect-to-granted-loopback-port`, `wildcard-host-never-reaches-loopback`, `reserved-port-needs-exact-pattern`, `concurrent-sockets-limit-holds` |
| `tcp.listen.local` | `local-listener-accepts-connections`, `second-listener-gets-eaddrinuse`, `page-media-from-own-listener` |
| `tcp.listen.network` | not covered: a network-scope listener is reachable from the local network, and the end-to-end suite is loopback only |
| `udp.bind.local` | not covered: no ported app relies on UDP yet; `e2e-udp-capability` proves the capability itself, and a row is added when a port needs it |
| `udp.bind.network` | not covered: as `udp.bind.local`, and reachable from the local network |
| `udp.send` | not covered: as `udp.bind.local` |
| `https.connect` | `routed-fetch-reaches-granted-hosts`, `tls-self-signed-refused-unless-opted-out` |
| `fs` | `fs-confined-to-app-root`, `fs-quota-refuses-past-limit`, `app-files-survive-restart`, `atomic-write-by-rename`, `node-fs-writes-land-at-app-root`, `page-sync-fs-writes-land`, `local-file-grant` |
| `id` | not covered: no ported app uses `orivon.id` yet; `e2e-id-capability` proves the capability itself |
| `web.context` | `web-context-open-evaluate-close` |
| `web.embed` | `webview-shows-local-pattern`, `webview-popup-reaches-the-app` |
| `media.camera` | `app-media-declared-is-asked-once`, `app-media-undeclared-is-refused` |
| `media.microphone` | `app-media-declared-is-asked-once`, `app-media-undeclared-is-refused` |
| `media.screen` | `app-screen-declared-shows-the-picker`, `app-screen-undeclared-is-refused`, `electron-desktop-capturer-serves-the-picked-source` |
| `clipboard.read` | not covered: a contract entry with no implementation behind it |
| `secrets` | not covered: no spec drives `orivon.secrets` from an app's page |
| `trust.score` | `score-lookup-needs-the-trust-grant`, `score-lookup-answers-the-chosen-provider` |
| `devices.hid` | not covered: the runtime lands in the next PR |
