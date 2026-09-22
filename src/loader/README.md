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

**`fetchBundle` cannot depend on `response.url`, because real Electron's
`net.fetch` reports it as the empty string on every ordinary response, not only a redirected one**
(measured, `docs/open-questions.md` A59/A141). The same-origin and canonical-path checks in
`fetch-bundle.ts` trust the url they *requested* (`manifestUrl`, `assetUrl`) instead, which is
provably safe only because [`electron-fetch.ts`](electron-fetch.ts)'s `redirect: 'error'` makes a
followed redirect response impossible to receive in the first place. That is a hard requirement
on any `Fetch` implementation (see that type's own doc comment,
[`fetch-budget.ts`](fetch-budget.ts)), not only the real one.

Two more checks are unreachable through the public API for the same reason: `fetch-bundle.ts`'s
entry-leaf check (`ADR-0009` amendment #2), because `entryPath` and the asset loop's own canonical path are the
identical computation for the entry's own asset, so they cannot disagree without a bug in that
computation itself, which no test can manufacture without reintroducing the bug; and
`bundleTree()`'s own case-folding collision check, which has direct coverage in
[`bundle-hash.test.ts`](../broker/policy/tests/bundle-hash.test.ts) instead. Both stay as defence
in depth against their own computations ever drifting apart.

**The real adapter (`electronFetch`/`netFetch`) is tested for real, not only through a stub
`Fetch`.** [`test/e2e-loader-adapter.test.ts`](../../test/e2e-loader-adapter.test.ts) drives the
real `net.fetch` (and, for the one case its own address guard
allows, the real `electronFetch`) inside a real Electron process against a real local server,
including a real redirecting response, so the `redirect: 'error'` guarantee this section depends
on is proven rather than assumed.

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

**Why a fresh install does not prune.** `install()` skips `pruneAssets` on the TOFU path: no
earlier pin exists for that origin, so there is nothing a previous bundle could have left behind,
and the walk would only re-read every file the write loop just wrote: one `realpath` per
declared asset, up to `MAX_BUNDLE_ENTRIES` of them. The one state this gives up on is an origin
whose `code/` tree survived while its pin record did not (a crash between the two writes): those
files are not swept by the re-install that follows, but the re-install does write a pin, so the
next update prunes them.

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

**Why `/` maps to `manifest.entry` and nothing else does.** A pinned bundle is a fixed, hashed
asset map, not a filesystem with directory listings; `isValidCanonicalPath` already refuses
every path ending in `/` except the bare root (a trailing empty segment fails `isSafeDecodedPath`),
so there is no directory-index fallback to design for beyond that one case. `serve.ts`'s
`resolveRequestPath` special-cases exactly `url.pathname === '/'`; every other request, directory-
ish or not, is answered by an exact pinned-path lookup or denied.

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
header). Everything else, whether an ungranted host, a plain `http:` request (A163, a deliberate,
narrower scope decision, not a gap), or a redirect from the granted host, still gets the same
fail-closed `denyResponse` this handler has always answered with. `img-src`/`font-src`/`media-src`
widen alongside it, from the same `https.connect` grant (`connect-src.ts`'s `appReachCspHeaderValue`)
-- without that, `default-src 'self'`'s fallback would keep refusing the very requests this
decision exists to allow, before they could ever reach the handler.

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
auto-follows a redirect: a 3xx from the granted host is handed back to the page as an ordinary 3xx
response, so a granted host can never hand a request off to one nobody approved.

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

A disk fallback would be unsafe for `connect-src` in particular: `connect-src` is the sole gate
for `WebSocket` (`docs/open-questions.md` A42), which has no live handler behind it to catch a
wrong guess, so reading disk there would widen a REAL authorisation from an unverified source
(`A137`). A manifest that is a leaf of a hash-pinned bundle is not the kind of "saved value"
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
`reachSlotsFor` keeps a small per-origin counter, checked-and-reserved as one synchronous step
against that same number -- the identical discipline `GrantLedger.reserveFsBytes`'s own doc
names for why a quota check and its reservation must never straddle an `await`.
