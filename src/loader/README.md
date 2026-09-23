# `src/loader/`: the app loader

**What lives here.** Manifest discovery at `/.well-known/orivon.json`, asset fetch and cache,
per-version hash pinning, and the update decision (silent / re-consent / capability prompt /
reject).

**What it depends on.** [`src/contracts/`](../contracts/) and [`src/broker/`](../broker/)
(for storage and the grant ledger).

**What it must never import.** [`src/shim/`](../shim/).

**Owner stream.** `loader`, build step 4.

**Never probe automatically.** An unsolicited request to every origin the user visits is an
active, attributable *"this visitor runs Orivon"* signal, sent from a privacy-branded browser.
Discovery is a `<link rel="orivon-manifest">` hint in HTML already delivered, the only
trigger; there is no separate user action, a Web3site is the URL, not a thing to convert a
website into (`capability-api.md` §How a URL becomes an app). The well-known path is fetched
**only after** seeing that hint.

**The install origin's hostname must resolve as public-unicast before that fetch, no exception**
([`install-origin.ts`](install-origin.ts), T12/A46). This is the shell itself, unsandboxed,
making the very first request, with no grant and no manifest yet to gate it, so a hint pointing
at a loopback, private, link-local or cloud-metadata address is refused outright, even the
loopback case `docs/open-questions.md` A46 otherwise permits for a *user-typed* address: the only
discovery trigger here is a page-supplied hint, which is exactly the provenance A46 says loopback
must never be reachable from.

**The update decision is where a silent failure is a security failure.** Its failure mode is
"no prompt appeared", which no manual checklist catches, and the capability at stake is
`tcp.connect *:*`. Re-consent triggers on a **subset check over the granted pattern set**, not
on capability kinds; see [`capability-api.md`](../../docs/architecture/capability-api.md) A9 §2.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why [`fetch-bundle.ts`](fetch-bundle.ts) is its own file, not part of `index.ts`.** Split out
per [`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 2: it owns exactly
one concern: turning `(fetch, hintedUrl)` into a validated bundle. TOFU versus `decideUpdate()`
branching is `index.ts`'s job, and persistence is [`install.ts`](install.ts)'s.
[`fetch-asset.ts`](fetch-asset.ts) holds the one-asset half and the bounded pool.

**A bundle never sits whole in memory: bytes stream to staging and are hashed from there.**
The byte caps (`bundle-hash.ts`'s `MAX_ASSET_BYTES`, 64 MiB, and `MAX_BUNDLE_BYTES`, 512 MiB;
an owner decision, sized for a real built frontend with a 31 MB wasm-heavy chunk and room to
grow) bound download and disk, so memory must stay flat however close a bundle comes to them.
Each response body is written chunk by chunk into the origin's **staging area**
(`apps/<origin-hash>/staging/`, a sibling of `code/`, never inside it), then hashed by reading
that file back through [`leaf-hash.ts`](leaf-hash.ts): node:crypto's incremental SHA-256 fed
`bundle-hash.ts`'s own `leafPrefix`, so the byte layout stays defined once and only the engine
differs from the WebCrypto one `bundleTree` uses. Hashing reads the file back rather than hashing
as bytes arrive because the leaf preimage puts the content's length BEFORE the content, and a
declared `Content-Length` is advisory. The root comes from `bundleTreeFromLeaves`, which applies
exactly the validation `bundleTree` does. Only the manifest is held in memory, and it is bounded
by `MAX_MANIFEST_BYTES`. A fetched bundle waiting on a prompt waits in staging too
(`StagedAsset` names its bytes, never carries them); the next fetch for that origin, or a
refused one, clears it.

**Assets are fetched four at a time, and a download ends for going quiet, never for being
long.** `FETCH_CONCURRENCY` (4) assets share one `ByteBudget`, taken chunk by chunk in one
synchronous step, so parallel fetches can never together pass `MAX_BUNDLE_BYTES`; the first
failure aborts the rest. Each fetch has an idle deadline (`FETCH_IDLE_TIMEOUT_MS`, 20 s without
a response or a new chunk), so a 64 MiB asset on a slow but steady link finishes, and the whole
operation has `BUNDLE_TIMEOUT_MS` (30 minutes, about 300 KB/s for a full 512 MiB bundle), so a
peer trickling one byte just inside the idle deadline is still cut off. Both numbers are
AI-recommended and uncalibrated (A15).

**An install writes only what changed, one atomic rename per file, and a crash heals itself.**
[`install.ts`](install.ts) compares each staged leaf with a streaming hash of the file already in
`code/` at that path and commits (renames) only those that differ; an unchanged bundle writes
nothing at all and keeps its pin record, so a repeat visit no longer rewrites the cache. Every
write is a rename from staging (`node-storage.ts`'s `writeAtomically`, `commitStaged`), so a
reader sees the old file or the new one, never a partial one (A62's second half). Comparing
against the bytes on disk, not the old pin's leaf, is what lets a damaged cache heal: a file that
no longer matches is rewritten even when its pinned leaf did not change. A crash part-way through
leaves some files new and the old pin in place; the next start's verification then fails and the
app recovers as described under "When the cached bundle fails verification" below.

**There is no `assetPaths` parameter anywhere in this directory.**
`fetchBundle` reads the app's file list off the manifest itself (`manifest.entry` unioned with
`manifest.assets`, [`ADR-0011`](../../docs/decisions/ADR-0011-manifests-declare-their-own-asset-list.md))
once it has fetched and parsed it, never supplied by a caller. It cannot be a caller's job: the
well-known manifest path is fixed and known only to `fetchBundle` itself (this file's own
header, above), so nothing external ever has a parsed manifest to read `assets` off *before*
calling `load()`; the caller of `load()` only ever has `hintedUrl`, the same thing a passive
hint listener has.

`entry` is unioned into the fetched set unconditionally, not only when convenient: it is a leaf
of the bundle like any other declared asset, and the entry-leaf check needs it fetched to find
it. **Some of `fetch-bundle.ts`'s checks are unreachable through the public API, on purpose.**
Several guard against a hostile asset list (an absolute cross-origin URL, a path-traversal string,
two names that collide under case-folding, too many entries), but `manifest.ts`'s own validation
(`readAssets`/`validateRelativePath`/`MAX_ASSETS`) rejects every one of those shapes before
`fetchBundle` ever sees them. They stay in `fetch-bundle.ts` as defence in depth (this function
must not quietly trust that `manifest.ts`'s validation is airtight), and their test coverage lives
in [`manifest.test.ts`](./tests/manifest.test.ts), which exercises the same input shapes. A
*redirect* landing two distinct declared names, or a redirected entry, at a different canonical
path than declared cannot be produced by this file's suite at all, for the reason below.

**`fetchBundle` trusts the url it requested, never `response.url`, and follows only a
same-origin redirect.** Real Electron's `net.fetch` reports `response.url` as the empty string on
every ordinary response (measured, `docs/open-questions.md` A59/A141), so the same-origin and
canonical-path checks trust the url they *requested* (`manifestUrl`, `assetUrl`), and every asset
is pinned under that path. That is safe only because a `Fetch` may never deliver bytes from
another origin, a hard requirement on any implementation (that type's own doc comment,
[`fetch-budget.ts`](fetch-budget.ts)). Refusing every redirect met it, but also refused real
static hosts, which answer `/index.html` with a redirect to `/` (Cloudflare Pages, Vercel) or
`/app` with `/app/` (GitHub Pages). So [`electron-fetch.ts`](electron-fetch.ts)'s `netFetch` uses
`net.request` with `redirect: 'manual'` and shows each hop to `redirectRefusal` before taking it:
same scheme, host and port, at most `MAX_REDIRECTS` (5), or the request is aborted. The bytes of
a followed hop are pinned under the requested path, still on the origin being installed.

**An unknown top-level manifest field is ignored; an unknown field inside `capabilities` is
refused.** [`manifest.ts`](manifest.ts) leaves a top-level field it does not know out of the
parsed manifest and returns its name in `ignoredFields`, which `fetch-bundle.ts` logs as a
warning. Refusing it would fail the install for a field that grants nothing (`$schema`,
`description`, `icons`, or a field a later Orivon adds), and since the pinned manifest is parsed
again at every start, a field some other Orivon version accepted at install would lock the
installed app out. Inside
`capabilities` every field asks for authority, so an unknown one there still rejects the
manifest: silently dropping a permission the app asked for would install an app that then
fails in ways nobody can trace. `orivonApiVersion` must still be exactly `0`.
`scripts/check-manifest-parity.mjs` is what keeps a contract field from being ignored by
mistake: it fails when the contract and the loader's key lists disagree in either direction.

**The root document is declared by its file name.** `entry: "index.html"` is fetched at
`/index.html` (following such a redirect to `/` where the host sends one) and served at `/`; a bare
root cannot itself be a pinned leaf, since `/` is not a valid canonical path, so `entry: "/"` is
refused with that hint. An asset whose name promises script, style, wasm or JSON but whose response
is an HTML page is refused too ([`fetch-asset.ts`](fetch-asset.ts)'s `servedAsHtml`): an SPA host
answers a missing file with `200` and its index page, which would otherwise be pinned as the
script and fail later with an opaque syntax error.

Two more checks are unreachable through the public API for the same reason: `fetch-bundle.ts`'s
entry-leaf check (`ADR-0009` amendment #2), because `entryPath` and the asset loop's own canonical path are the
identical computation for the entry's own asset, so they cannot disagree without a bug in that
computation itself, which no test can manufacture without reintroducing the bug; and
`bundleTree()`'s own case-folding collision check, which has direct coverage in
[`bundle-hash.test.ts`](../broker/policy/tests/bundle-hash.test.ts) instead. Both stay as defence
in depth against their own computations ever drifting apart.

**Undeclared files are named at install, never added.** An entry document that loads a
same-origin script, stylesheet or image its manifest's `assets` leaves out installs cleanly and
then renders blank: the file is not pinned, so the cache refuses it. When a bundle is newly pinned,
[`undeclared-assets.ts`](undeclared-assets.ts) scans the entry document's `src`/`href` on
subresource elements and logs every same-origin path the pinned set lacks. It only warns: ADR-0011
has the loader read the list, never infer it, and a runtime `import()` a scan cannot see is the
publisher's to declare either way.

**The real adapter (`electronFetch`/`netFetch`) is tested for real, not only through a stub
`Fetch`.** [`test/e2e-loader-adapter.test.ts`](../../test/e2e-loader-adapter.test.ts) drives the
real `netFetch` (and, for the one case its own address guard
allows, the real `electronFetch`) inside a real Electron process against a real local server,
including a real same-origin and a real cross-origin redirect, so the redirect rule this section
depends on is proven rather than assumed.

**Why [`install-origin.ts`](install-origin.ts) is its own file.** Split out of `fetch-bundle.ts`
per Rule 2 (adding the T12/A46 guard pushed that file to 524 lines): it owns exactly one
question, "may this hostname be installed at all," independent of everything else `fetchBundle()`
does once that question is answered. Tested through `fetch-bundle.test.ts` rather than a file of
its own, the same way `manifest-capabilities.ts` is tested through `manifest.test.ts`, since it has no
caller-visible contract beyond what `fetchBundle()` already exercises.

**Why `pruneAssets` compares folded paths, and why folding is the safe direction.**
[`node-storage.ts`](node-storage.ts) decides what to delete by comparing the manifest's declared
asset paths against what `readdir` reports on disk. Two spellings of one filename break that
comparison in two ways, and both were real. APFS and HFS+ store a non-ASCII filename decomposed
(NFD) even when the bytes written were precomposed (NFC, the form a JSON manifest normally
carries). APFS and NTFS are also case-insensitive but case-preserving, so a bundle update that
changes only an asset path's case rewrites the *same* physical file while `readdir` keeps
reporting the original spelling. Both are supported run-from-source targets
([`CLAUDE.md`](../../CLAUDE.md) Rule 8). Both sides of the comparison therefore go through
`canonical-path.ts`'s `foldForIdentity` (NFC, then case-fold), the same folding
`collisionKey` applies, minus its percent-decode step, which would corrupt a literal `%` in an
already-decoded real filename.

Folding case is deliberately *more* permissive than a genuinely case-sensitive filesystem is:
`/App.js` and `/app.js` are two files on ext4 and would now be treated as one. That is the
direction to err in for a delete. Reading two files as one leaves a stale file on disk, which is
disk hygiene; reading one file as two deletes a live asset the app needs, which is data loss.

**Why an empty directory is only removed when this prune emptied it.** Nothing in the loader
removed a directory at all before pruning existed, so the write path (`mkdir` then `writeFile`)
never had to survive a directory disappearing under it. A sweep of every empty directory under
the code root would reintroduce exactly that: a concurrent install's `mkdir` for a new
subdirectory, not yet written into, looks indistinguishable from a leftover
([`open-questions.md`](../../docs/open-questions.md) A62). So `removeEmptyAncestors` climbs only
from directories this prune deleted a file from. The cost is that a directory left empty by an
interrupted earlier run survives until a prune deletes from it again.

**Why an install never prunes: the next start does.** An update can land while the app is open,
and a single-page app still running the previous bundle lazily `import()`s its old hashed chunks;
pruning at install turned each of those into a 404 and a `ChunkLoadError`. So
[`install.ts`](install.ts) leaves every superseded file on disk, and `electron-serve.ts` keeps
serving them for the rest of the process: `registerServingFor` remembers every path each pin it
served declared (`servedAssets`) and hands the new handler the ones the new pin dropped
(`retainedAssets`), which [`serve-path.ts`](serve-path.ts) answers only after checking the file
still hashes to the leaf it was pinned with. A path both pins declare is overwritten, so only the
new bytes exist; that is the entry document and any unhashed file, which the reload fetches anyway.
`restorePinnedServing` prunes to the verified pin, and clears any staging a crash left, at the
next start, before any page can still need the old files.

**Re-verification cost: whole-tree, once, at handler creation, not one leaf hash per request.**
[`ADR-0007`](../../docs/decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md) requires
the cached tree be "re-verified at every load, not only at fetch," and a large bundle makes that
sentence a real cost decision, not a formality. [`serve-verify.ts`](serve-verify.ts) re-hashes
every pinned asset, streaming it through [`leaf-hash.ts`](leaf-hash.ts) so memory stays flat,
checks each leaf and the root against the pin exactly once, when
[`serve.ts`](serve.ts)'s `createAppRequestHandler` builds the handler that
[`electron-serve.ts`](electron-serve.ts) then registers with
`session.fromPartition(...).protocol.handle(...)`, not on every individual request that handler
later answers. Two things make this the right cost to pay, not merely the cheap one: `protocol
.handle` registrations do not survive an Electron process restart (confirmed against
`electron/electron`'s `protocol_registry.cc`: a session's handler map is process-local), so a
fresh handler, and therefore a fresh whole-tree check, is unavoidable once per app **per launch**
regardless of how many requests that launch makes; and the ADR's own phrase is "**between runs**",
which this satisfies exactly. What it does **not** catch is a file rewritten on disk mid-session,
after the handler for that origin has already been built, a narrower TOCTOU-shaped risk this
loader accepts rather than pays for on every request: a per-leaf hash on every single asset fetch
would mean re-hashing an app's whole JS bundle on every navigation and every repeated image
request, for a threat (local write access to a running browser's own profile directory, in a
window of an already-open app) that has larger consequences than a stale cached file. Provisional,
flagged rather than silently chosen, the same as
`bundle-hash.ts`'s own `MAX_ASSET_BYTES`/`MAX_BUNDLE_BYTES`.

**Why `readAsset` collapses every failure into one `undefined`, unlike `readPin`.** `readPin`'s
own doc distinguishes "never pinned" from "pinned but unreadable" because `index.ts`'s TOFU-vs-
reconsent branch genuinely needs to tell them apart. Nothing downstream of `readAsset` needs that:
`serve-verify.ts`'s whole-tree check denies the ENTIRE bundle the moment any one asset cannot be
confirmed present with its pinned bytes, regardless of whether the cause was a missing file, a
permissions error, or a directory where a file was expected. One contract, not two, because there
is only one caller-visible outcome.

**What a same-origin path serves: the exact pinned asset, with two entry-only exceptions.**
A pinned bundle is a fixed, hashed asset map, not a filesystem: `isValidCanonicalPath` refuses
every path ending in `/` except the bare root, so there is no directory index to design for.
[`serve-path.ts`](serve-path.ts)'s `resolveRequestPath` answers every request with an exact
pinned-path lookup or a denial, except two cases that both answer with the pinned entry and
never with anything unpinned. `/` maps to `manifest.entry`, and when the entry sits in a
subdirectory (`app/index.html`) `/` answers a 302 to it instead, so the document's relative URLs
resolve against its own directory (a `protocol.handle` redirect is followed like a network one,
measured). And a **navigation** to an unpinned route with no file extension (`/inbox/42`) serves
the entry, the history fallback every SPA host provides, so reloading a client-side route does
not 404; a subresource or `fetch()` for the same path is still denied, and so is a navigation to
a missing *file*. Telling a navigation apart takes Chromium's own navigation headers
(`Upgrade-Insecure-Requests` plus an `Accept` naming `text/html`): `protocol.handle` reports
every request with `mode: 'cors'`, an empty `destination` and no `Sec-Fetch-*` headers (measured,
Electron 44). A page can forge those headers on a `fetch()`, which only gets it the entry
document, a pinned asset it could request directly anyway.

**Why registering a handler is idempotent, not additive.** Electron's `protocol.handle` throws
`"The scheme has been registered"` on a second call for a scheme already handled on that session --
confirmed against `electron/electron`'s own source rather than assumed (`protocol_registry.cc`'s
`RegisterProtocol` uses `try_emplace`, which only inserts once). Since `partitionFor` keys a
session to exactly one canonical origin, a second registration on the same session can only mean
that origin was reinstalled within the same process run; `electron-serve.ts`'s `registerAppOrigin`
unhandles first so the session always answers with a handler built from the freshly re-verified
pin.

**Why a cross-origin request inside an app's own partition reaches `fetchThirdParty`, not an
automatic denial (A143).** `session.fromPartition(...).protocol.handle('https',
...)` intercepts the WHOLE scheme for that session, not merely requests to the app's own host, so
a page in its own partition fetching a third-party `https://` URL (a CDN font, an `<img>` pointing
elsewhere) reaches this same handler, and an app may reach a host it holds a granted
`https.connect` for. `serve.ts`'s `fetchThirdParty` authorises against the LIVE grant via
`checkConnectSecure`, the SAME function `orivon.net.connectSecure` itself calls, and, if
allowed, performs the real fetch through [`serve-reach.ts`](serve-reach.ts)'s `nodeReachDial`
(Node's own `https` module, chosen over Electron's `net.fetch` specifically so this path could be
proven end to end over a real TLS handshake in a real Electron launch; see that file's own
header). An ungranted host and a plain `http:` request (A163, a deliberate, narrower scope
decision, not a gap) get the same fail-closed `denyResponse` as every other refusal. `connect-src`,
`img-src`, `font-src` and `media-src` widen alongside it, from the same `https.connect` grant
(`connect-src.ts`'s `reachSourcesFor`): without that, the header would refuse the very requests
this decision exists to allow before they could reach the handler. "The third-party reach path",
below, covers what a granted request meets on its way through.

**Why [`serve-reach.ts`](serve-reach.ts) uses Node's own `https` module, not Electron's `net.fetch`
or a hand-rolled HTTP/1.1 client.** `test/e2e-fetch-routing.test.ts`'s own header records why an
unmodified Electron build cannot be made to trust a locally generated test certificate, which is
why that file proves its own byte round trip over plain HTTP rather than HTTPS. Node's own `https`
module takes a per-request `ca` override (`../broker/adapters/tls-adapter.ts`'s own established
seam, same shape, same "testing only" rule), so this mechanism can be proven end to end over a real
TLS handshake in a real Electron launch (`tests/serve-reach.test.ts`), a real advantage Electron's
own `net.fetch` does not have. A hand-rolled client (the shape `src/preload/fetch-route.ts` is
forced into by its own `contextBridge` serialisation constraint) was rejected because nothing here
needs that constraint: Rule 6 says prefer the mature, already-audited component once a hand-rolled
one is not actually required, and Node's own client already handles chunked encoding and keep-alive
correctly. Two further properties this choice buys for free: `https.request` has no concept of a
session or a cookie jar at all, so there is nothing to remember to set (contrast Chromium's
`fetch()`, which needs an explicit `credentials: 'omit'` for the identical guarantee); and it never
follows a redirect itself: a 3xx goes back to the page's loader, which follows it through this same
handler, so a granted host can never hand a request off to one nobody approved.

**Why `restorePinnedServing` runs at startup rather than only after a fresh `load()`.** `load()`
does now have a production caller (the discovery trigger, via `src/main/install/app-install.ts`), but a
fresh install is not the only way an app needs serving. Without a startup pass, "offline first-run keeps working
for pre-cached apps" (this document's own line, from `ADR-0007`) would be false in practice: an
app installed in one run would stop being servable from cache the moment the browser restarts,
since nothing else re-registers its handler. `subsystem.ts`'s `afterReady` calls
`electron-serve.ts`'s `restorePinnedServing` once, reading every origin `node-storage.ts`'s
`listPinnedOrigins` finds a self-consistent pin for, and registers each independently, so one
origin's corrupted pin or unreadable asset is logged and does not stop the rest, the same
per-item-failure stance `runAfterReady` (`main/registry.ts`) already takes for subsystems.

**When the cached bundle fails verification, nothing is served, and the next visit reinstalls
it.** A pin whose files no longer hash to it (a crash part-way through an install, a damaged
disk, a hand edit) used to get a handler that denied every request, forever: the app's page
could never load, so its hint never fired and nothing could ever repair the cache. Now
`electron-serve.ts`'s `registerServingFor` registers nothing for such an origin at startup and
hydrates nothing, so it loads as an ordinary website, with no grants live and no app-tab flag.
Its hint then runs `load()` as usual: the pin still names the bundle, the fetched bundle is
compared against it, and [`install.ts`](install.ts) rewrites exactly the files that no longer
match; serving, grants and registration come back through `onInstalled`, and the tab reloads
into the app. The one exception stays fail-closed: an origin already served from cache, or
holding a live grant, this session keeps a handler that denies everything, since its partition
carries authority and must never fall through to whatever the network serves next.

**A declined capability is asked about once, not on every visit.** `decideUpdate()` compares the
new manifest with what the origin holds; a capability the person declined at install, or revoked
since, is never held, so every visit used to read as "the app wants more" and raise the capability
prompt again. `index.ts` now also passes the pinned manifest's own declared set
(`previouslyDeclaredPatterns`), read back only when its bytes still hash to the pin's manifest
leaf: authority the person was already asked about counts as covered. That grants nothing -- the
declined capability stays ungranted -- and a request outside both sets still prompts.

**An app is checked for an update at most once an hour.** Every page load of an app reports its
hint, and each used to re-download the whole bundle. `createLoader`'s `updateCheckIntervalMs`
(`UPDATE_CHECK_INTERVAL_MS`, one hour, AI-recommended) answers `'up-to-date'` without fetching
while the last completed check for that origin is younger than that. The record is in memory, so
the first visit after every start still checks; a rejected check is not recorded, so a failure
is retried on the next visit.

**A restored app is a registered app from startup.** Serving alone is not enough: the app-tab
flag (`src/main/shell/tab-view.ts`'s `appTabArgsFor`) and `orivon.app.manifest()` both ask
whether the broker has a manifest for the origin, and a tab's flag is fixed when the tab is
built. So `registerServingFor` hands the verified pinned manifest to
`Broker.app.hydrateFromPinnedManifest`, which also registers it: a restored app's tab gets its
routed fetch and process shim from the first load, before any hint arrives. That registration
never raises the version floor, and the fresh manifest's own `registerApp`, when the page's hint
arrives, replaces it and re-validates the restored grants as before.

**Why the served bundle's CSP is read fresh per request, not computed once at handler
creation.** [`serve.ts`](serve.ts)'s whole-tree re-verification is a deliberate ONE-TIME cost
(the note above) because the pinned bytes cannot change without a new handler being built for
them. A grant is different: `broker/grant-ledger.ts`'s `grant()`/`revoke()` can change what
`connect-src.ts` should say for an origin whose handler is ALREADY registered, with no
re-registration event to hook. `electron-serve.ts`'s `grantedConnectPatternsFor` is therefore
called from inside the returned handler, once per request, not captured in the closure the way
the pin and manifest are, so a revoke narrows the very next request's CSP, and a fresh grant
widens it, without waiting for the app to be reinstalled or the browser to restart. **What this
still cannot fix, because nothing implementation-side can:** a document already loaded keeps
whatever CSP its own navigation response carried, until the next load. That is how CSP
delivery works in every browser, not a gap this design left open.

**Why every CSP directive reads the live grant ledger, even right after a restart (A158).**
`electron-serve.ts`'s `registerServingFor` hydrates `origin`'s persisted grants from its pinned,
hash-verified manifest (`verifiedManifestFor` below, `GrantLedger.hydrateFromPinnedManifest`)
BEFORE `registerAppOrigin` wires anything onto the session, so the ledger is already the true
answer by the time any header is computed. Both header functions share one
`liveGrantedPatternsFor` helper that simply reads `broker.app.grants`, with no disk fallback and
no special-casing.

A disk fallback would be unsafe for `connect-src` in particular: `connect-src` is the only gate a
`WebSocket` meets (`docs/open-questions.md` A42), since no `protocol.handle` ever sees one, so
reading disk there would widen a REAL authorisation from an unverified source (`A137`). Measured
in Electron 44 (`test/e2e-served-csp.test.ts`): from an https page, none of the source forms this
header emits (a bare `host:port`, `https://host:port`, `https:`) admits a `wss:` URL, so an
installed app cannot open a third-party WebSocket today. A manifest that is a leaf of a hash-pinned bundle is not the kind of "saved value"
`A137` forbids trusting; A158 has the full reasoning.

**Why `verifiedManifestFor` (`serve.ts`) exists alongside `createAppRequestHandler`, sharing one
`resolveVerifiedBundle` helper rather than each re-deriving the same verification.** A158's
early-hydration seam needs the EXACT, already-verified manifest `createAppRequestHandler` itself
derives: an output, not an input, which is why `serve.ts`'s own header calls out this one
exception to "no `Manifest` argument, ever". `registerServingFor` calls it, then hydrates
`GrantLedger` from the result, before building the handler at all, accepting a second, bounded
whole-tree re-verification per `registerServingFor` call (this directory's own accepted per-launch
cost, doubled rather than multiplied per request) instead of threading a pre-resolved manifest
through `createAppRequestHandler`'s public signature, which every test and `dev-serve.ts` already
depend on staying `storage`+`origin`-only.

**Why `isOriginServedFromCache` (`electron-serve.ts`) asks Electron's protocol-handler registry
instead of the broker.** S4-6's address-bar provenance signal needs to answer "is a request to
this origin, right now, actually being served from the pinned cache", and `Broker
.app.isRegisteredSync` cannot answer that: it means "a manifest is in the grant ledger," which
`registerApp` sets independently of `registerServingFor` actually intercepting the scheme
(`subsystem.ts`'s `onInstalled` calls both, but a future caller is not guaranteed to). Asking
Electron's own `session.protocol.isProtocolHandled` instead is the only way to avoid a false
positive: ADR-0007 is explicit that showing "local cache, pinned" for bytes that did not
actually come from it is precisely the false claim this feature exists to prevent.

**Why A199's cancellation hooks in the handler, not the dial or the grant ledger's own cascade**
(`docs/open-questions.md` A199/A200). `fetchThirdParty` (`serve.ts`) authorised a third-party
reach only ONCE, before dialling -- a person who revoked the grant, watched the row disappear
from the permissions UI, and then kept receiving bytes from that host had been shown something
untrue. Three places could have hooked the fix in:

- **The handler (`serve.ts`, chosen).** [`serve-reach-guard.ts`](serve-reach-guard.ts)'s
  `guardReachResponse` wraps the streamed `Response` body and re-calls the SAME `authoriseReach`
  the handler already calls once, on a short timer, for as long as the body is still being read.
  A revoke it catches cancels the underlying reader and errors the wrapped stream -- what a
  page's own `fetch()` then observes is a rejected read, never a byte count it could mistake for
  a complete file. This keeps the one thing that already knows about grants (the handler, the
  only caller of `authoriseReach`) the only thing that still has to.
- **The dial (`serve-reach.ts`, rejected).** That file's own header commits to staying free of
  broker policy and Electron entirely -- it is the one place in this directory doing real network
  I/O, kept small and auditable on purpose. Teaching it "is this still authorised" would mean
  either importing broker policy into it (duplicating a decision the handler already makes) or
  threading a live callback into it from the handler anyway, at which point the polling loop is
  still handler-driven, just relocated into a file with no other reason to know about grants.
- **The grant ledger's own cascade (`HandleTable.revoke`, rejected).** The most architecturally
  "pure" option -- zero-latency, push-based, the exact mechanism `net.connect`/`net.connectSecure`
  already get from `HandleTable.run`'s grant-scoped operation bucket. Reaching it for a reach
  request means either registering a proxied HTTP response as a `HandleTable` resource it was
  never shaped for (no app-visible `Handle`, and a lifetime measured in a streamed download rather
  than a quick dial -- a real risk of starving that origin's OTHER operations against
  `LIMITS.inFlightOperations` for as long as one large download is in flight), or adding a
  bespoke revoke-notification path to the broker's core revocation cascade -- a change to files
  the `broker` stream owns and was actively working in at the time this landed. A bounded poll
  costs latency (`REACH_REVOCATION_POLL_MS`, currently 200ms) for a benefit (true push) that does
  not change what the reading page observes qualitatively: it still sees a real failure, just up
  to one poll interval later.

**Why A200's allowance reuses `GrantLedger.socketAllowance` through a new `Broker.app
.socketAllowanceSync`, rather than re-deriving the clamp in the loader.** An app's simultaneous-
socket allowance is declared in its manifest, clamped to `LIMITS.concurrentSockets`, and enforced
for `net.connect`/`net.connectSecure`/`net.listen` via `HandleTable.acquire`'s `socketLimit` --
but `fetchThirdParty`'s reach path never consulted it, so an app could hold unlimited concurrent
third-party requests regardless of the number it declared and the person approved. The clamp
itself (`resource-limits.ts`'s `socketAllowance`) is two lines of arithmetic, cheap enough to be
tempting to copy -- but code-guidelines.md Rule 3 is explicit that the
NUMBER must be reused, not re-derived, so a future change to the clamp (or to what counts as
"declared") cannot silently drift between the two enforcement points. `Broker.app
.socketAllowanceSync` is a one-line, synchronous, never-throwing delegate to
`GrantLedger.socketAllowance` -- the same category as `hasGrantsSync`/`isRegisteredSync`, and the
same kind of loader-specific seam `hydrateFromPinnedManifest` already is (A158). The actual
IN-FLIGHT COUNT is new state, by necessity: a proxied reach request is never a `HandleTable`
resource (no app-visible `Handle`, no revocation cascade of its own), so `electron-serve.ts`'s
`reachSlotsFor` keeps one [`serve-reach-slots.ts`](serve-reach-slots.ts) pool per origin: a free
slot is checked-and-reserved as one synchronous step against that same number (the identical
discipline `GrantLedger.reserveFsBytes`'s own doc names for why a quota check and its reservation
must never straddle an `await`), and a request that finds none waits in the pool's queue.

**Why a reach request over the allowance waits in a queue, when T11b says limits reject rather than
queue.** T11b's rule (`handle-contracts.md`'s Limits section) is about the broker's own operations: an
unbounded queue of broker work on the UI thread is how one origin freezes every tab. A queued
reach request is none of that. It is a pending promise and a timer, per origin, bounded in length
(`REACH_SLOT_MAX_WAITERS`, 256) and in time (`REACH_SLOT_WAIT_MS`, 30 s); past either it is refused
exactly as before. Refusing at once, on the other hand, broke real pages: a browser queues an
over-limit request, and a page has no retry for an image or a script that answered 404. The queue
is FIFO, a newcomer never takes a slot ahead of it, and a request that waited is re-authorised
before it dials, so a grant revoked meanwhile is not used. Both numbers are provisional.

**What the served bundle's CSP admits, and why** ([`serve-csp.ts`](serve-csp.ts)). The header is
set on every served response (A110 rules out `onHeadersReceived`) and rebuilt from the live grants
per request.

- **`script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`.** The bundle's own code
  is pinned and hash-verified, `'unsafe-inline'` already grants the script power `'unsafe-eval'`
  adds, and the broker, not the CSP, is the security boundary. Libraries that compile code at run
  time (ajv, protobufjs, template compilers, BotGuard) and WebAssembly (a wasm crypto library)
  need these. A148 records what `'unsafe-inline'` gives up for content an app renders but did not
  author.
- **`data:` and `blob:` in `connect-src`, `img-src`, `font-src` and `media-src`; `worker-src
  'self' blob:`.** Neither scheme has any network reach: a page can only point one at bytes it
  already holds. MSE video plays from a `blob:` URL, captions and icons often arrive as `data:`,
  and bundlers start workers from `blob:` URLs.
- **`frame-src 'self' data: blob:`, and no third-party frame.** A `data:` or `blob:` frame is
  opaque-origin, gets no preload, and inherits this same policy (measured), so it can do nothing
  its parent cannot. Embedding a live third-party document is a bigger step than any subresource,
  and nothing asks for it.
- **`connect-src`: `'self'`, the local schemes, `tcp.connect`'s bare `host:port` sources, and
  `https.connect`'s scheme-qualified `https://host:port` sources.** The handler authorises a
  worker's fetch or a document's XHR against `https.connect`, so the header names that grant
  too. No `ws:`/`wss:` source is ever emitted from it.
- **A `*` host in `https.connect` emits `https:`** in the four reach directives. Every `https:`
  request that source admits reaches this app's own `protocol.handle` (it intercepts the whole
  scheme for the partition, workers included) and `fetchThirdParty` re-authorises it against the
  live grant, which still refuses loopback and private addresses: measured with a loopback server
  that a `*` grant's page could name in the header and that never saw a connection. What the
  handler cannot re-check is a WebSocket, and `https:` does not admit `wss:` (measured, above).
  `tcp.connect`'s `*` still contributes nothing to `connect-src` (A43).
- **No `form-action`.** It never falls back to `default-src`, so it is unrestricted. Restricting
  it to `'self'` would also refuse the redirects a form-post sign-in flow follows after the form
  leaves the app, and would bound nothing: top-level navigation is not governed by CSP at all
  (A42), so a page can send the same data with `location.href`.

**The third-party reach path, in order** (`serve.ts`'s `fetchThirdParty`). Every step is measured or
unit-tested; the two platform facts it rests on come from `test/e2e-served-csp.test.ts`.

1. **Redirect cap.** A 3xx this handler returns is followed by the page's own loader, back through
   this same handler, so each hop is authorised afresh, `redirect: 'manual'` yields an opaque
   redirect, `connect-src` is re-checked against the target, and `Authorization` is dropped on a
   cross-origin hop. That loader applies no redirect cap at all to a `protocol.handle` response
   (60 hops measured), so [`serve-reach-redirects.ts`](serve-reach-redirects.ts) counts hops per
   chain and answers the 21st with a network error, the Fetch standard's own limit. A chain is
   keyed by URL; one whose target URL is re-serialised differently restarts its count.
2. **Authorisation** against the live `https.connect` grant.
3. **A CORS preflight** to a granted host is answered without the network
   ([`serve-reach-cors.ts`](serve-reach-cors.ts)). Only a browser preflight carries
   `Access-Control-Request-Method`, so an app's own `OPTIONS` request still reaches the host.
4. **A socket-allowance slot**, waited for in the bounded queue above, and re-authorisation after
   any wait.
5. **The dial** ([`serve-reach.ts`](serve-reach.ts)), with an idle timeout
   (`REACH_IDLE_TIMEOUT_MS`, five minutes) that every byte resets, so a long-poll or an event
   stream lives as long as it keeps talking.
6. **A redirect goes back bodiless**, which frees its slot and upstream socket at once rather than
   whenever the loader gets round to the body.
7. **Anything else streams** through the revoke guard (A199), with CORS response headers for the
   app origin. Electron 44 does not enforce CORS on a `protocol.handle` response at all (measured:
   a cross-origin response with no `Access-Control-Allow-Origin` was readable, and a `PUT` sent no
   preflight), so today the headers only keep worker fetch and XHR working if it ever starts to.
