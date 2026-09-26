# `src/loader/electron/`: the Electron-specific machinery

**What lives here.** `fetch.ts` (`Fetch` over Electron `net`, with the redirect rule),
`resolve.ts` (DNS through `net.resolveHost`) and `serve.ts` (registers `protocol.handle` and
`restorePinnedServing`).

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/),
[`../cache/`](../cache/), [`../serve/`](../serve/), [`../reach/`](../reach/) and
[`../fetch/`](../fetch/) (the `eth-origin.ts` exception, `fetch/budget.ts`'s type).

**What it must never import.** [`../../shim/`](../../shim/) -- see the parent README's "What it
must never import". This is the one folder in this directory that imports `electron` at all.

**Owner stream.** `loader`, build step 4.

## Design notes

**Why registering a handler is idempotent, not additive.** Electron's `protocol.handle` throws
`"The scheme has been registered"` on a second call for a scheme already handled on that session --
confirmed against `electron/electron`'s own source rather than assumed (`protocol_registry.cc`'s
`RegisterProtocol` uses `try_emplace`, which only inserts once). Since `partitionFor` keys a
session to exactly one canonical origin, a second registration on the same session can only mean
that origin was reinstalled within the same process run; [`serve.ts`](serve.ts)'s
`registerAppOrigin` unhandles first so the session always answers with a handler built from the
freshly re-verified pin.

**Why `restorePinnedServing` runs at startup rather than only after a fresh `load()`.** `load()`
does now have a production caller (the discovery trigger, via `src/main/install/app-install.ts`),
but a fresh install is not the only way an app needs serving. Without a startup pass, "offline
first-run keeps working for pre-cached apps" (`ADR-0007`'s own line) would be false in practice:
an app installed in one run would stop being servable from cache the moment the browser restarts,
since nothing else re-registers its handler. `../subsystem.ts`'s `afterReady` calls
[`serve.ts`](serve.ts)'s `restorePinnedServing` once, reading every origin `../cache/node-storage.ts`'s
`listPinnedOrigins` finds a self-consistent pin for, and registers each independently, so one
origin's corrupted pin or unreadable asset is logged and does not stop the rest, the same
per-item-failure stance `runAfterReady` (`main/registry.ts`) already takes for subsystems.

**When the cached bundle fails verification, nothing is served, and the next visit reinstalls
it.** A pin whose files no longer hash to it (a crash part-way through an install, a damaged
disk, a hand edit) must not get a handler that denies every request: the app's page could never
load, so its hint would never fire and nothing could repair the cache. So
[`serve.ts`](serve.ts)'s `registerServingFor` registers nothing for such an origin at startup and
hydrates nothing, so it loads as an ordinary website, with no grants live and no app-tab flag.
Its hint then runs `load()` as usual: the pin still names the bundle, the fetched bundle is
compared against it, and [`../cache/install.ts`](../cache/install.ts) rewrites exactly the files
that no longer match; serving, grants and registration come back through `onInstalled`, and the
tab reloads into the app. The one exception stays fail-closed: an origin already served from
cache, or holding a live grant, this session keeps a handler that denies everything, since its
partition carries authority and must never fall through to whatever the network serves next.

**A restored app is a registered app from startup.** Serving alone is not enough: the app-tab
flag (`src/main/shell/tab-view.ts`'s `appTabArgsFor`) and `orivon.app.manifest()` both ask
whether the broker has a manifest for the origin, and a tab's flag is fixed when the tab is
built. So `registerServingFor` hands the verified pinned manifest to
`Broker.app.hydrateFromPinnedManifest`, which also registers it: a restored app's tab gets its
routed fetch and process shim from the first load, before any hint arrives. That registration
never raises the version floor, and the fresh manifest's own `registerApp`, when the page's hint
arrives, replaces it and re-validates the restored grants as before.

**Why the served bundle's CSP is read fresh per request, not computed once at handler
creation.** [`../serve/serve.ts`](../serve/serve.ts)'s whole-tree re-verification is a deliberate
ONE-TIME cost ([`../serve/README.md`](../serve/README.md)) because the pinned bytes cannot change
without a new handler being built for them. A grant is different: `broker/grant-ledger.ts`'s
`grant()`/`revoke()` can change what `connect-src.ts` should say for an origin whose handler is
ALREADY registered, with no re-registration event to hook. [`serve.ts`](serve.ts)'s
`grantedConnectPatternsFor` is therefore called from inside the returned handler, once per
request, not captured in the closure the way the pin and manifest are, so a revoke narrows the
very next request's CSP, and a fresh grant widens it, without waiting for the app to be
reinstalled or the browser to restart. **What this still cannot fix, because nothing
implementation-side can:** a document already loaded keeps whatever CSP its own navigation
response carried, until the next load. That is how CSP delivery works in every browser, not a gap
this design left open.

**Why every CSP directive reads the live grant ledger, even right after a restart (A158).**
[`serve.ts`](serve.ts)'s `registerServingFor` hydrates `origin`'s persisted grants from its
pinned, hash-verified manifest (`../serve/serve.ts`'s `verifiedManifestFor`,
`GrantLedger.hydrateFromPinnedManifest`) BEFORE `registerAppOrigin` wires anything onto the
session, so the ledger is already the true answer by the time any header is computed. Both header
functions share one `liveGrantedPatternsFor` helper that simply reads `broker.app.grants`, with
no disk fallback and no special-casing.

A disk fallback would be unsafe for `connect-src` in particular: `connect-src` is the only gate a
`WebSocket` meets (`docs/open-questions.md` A42), since no `protocol.handle` ever sees one, so
reading disk there would widen a REAL authorisation from an unverified source (`A137`). Measured
in Electron 44 (`test/e2e-served-csp.test.ts`): from an https page, none of the source forms this
header emits (a bare `host:port`, `https://host:port`, `https:`) admits a `wss:` URL, so a
native WebSocket cannot reach a third-party host from an installed app; the page's own top-level
WebSocket to a granted host is routed over `orivon.net` instead
([`../../preload/README.md`](../../preload/README.md)), where the broker, not CSP, bounds it. A
manifest that is a leaf of a hash-pinned bundle is not the kind of "saved value" `A137` forbids
trusting; A158 has the full reasoning.

**Why `isOriginServedFromCache` (`serve.ts`) asks Electron's protocol-handler registry
instead of the broker.** S4-6's address-bar provenance signal needs to answer "is a request to
this origin, right now, actually being served from the pinned cache", and `Broker
.app.isRegisteredSync` cannot answer that: it means "a manifest is in the grant ledger," which
`registerApp` sets independently of `registerServingFor` actually intercepting the scheme
(`../subsystem.ts`'s `onInstalled` calls both, but a future caller is not guaranteed to). Asking
Electron's own `session.protocol.isProtocolHandled` instead is the only way to avoid a false
positive: ADR-0007 is explicit that showing "local cache, pinned" for bytes that did not
actually come from it is precisely the false claim this feature exists to prevent.
