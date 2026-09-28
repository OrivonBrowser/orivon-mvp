# `src/loader/electron/`: the Electron-specific machinery

**What lives here.** `fetch.ts` (`Fetch` over Electron `net`, with the redirect rule),
`resolve.ts` (DNS through `net.resolveHost`) and `serve.ts` (registers `protocol.handle` and
`restorePinnedServing`).

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/),
[`../cache/`](../cache/), [`../serve/`](../serve/), [`../reach/`](../reach/) and
[`../fetch/`](../fetch/) (the `verifier-origin.ts` exception, `fetch/budget.ts`'s type).

**What it must never import.** [`../../shim/`](../../shim/), as the parent README says. This is
the one folder in this directory that imports `electron`, and all of it is tied to Electron.

## Design notes

Why re-registering a handler is idempotent, why `restorePinnedServing` runs at startup, and why
the CSP is read from the live grant ledger on every request (so a revoke narrows the very next
response, and nothing reads grants from disk, A158) are documented in [`serve.ts`](serve.ts), on
`registerAppOrigin`, `restorePinnedServing` and `liveGrantedPatternsFor`.

**When the cached bundle fails verification, nothing is served, and the next visit reinstalls
it.** A handler that denied every request would stop the page loading, so its hint would never
fire and nothing could repair the cache. So `registerServingFor` registers and hydrates nothing,
the origin loads as an ordinary website, its hint runs `load()`, and
[`../cache/install.ts`](../cache/install.ts) rewrites exactly the files that no longer match. The
one exception stays fail-closed: an origin already served from cache, or holding a live grant,
this session keeps a handler that denies everything, since its partition carries authority and
must never fall through to whatever the network serves next.

**A restored app is a registered app from startup.** The app-tab flag
(`src/main/shell/tab-view.ts`'s `appTabArgsFor`) and `orivon.app.manifest()` ask whether the
broker has a manifest for the origin, and a tab's flag is fixed when the tab is built. So
`registerServingFor` hands the verified pinned manifest to
`Broker.app.hydrateFromPinnedManifest`, which also registers it, before any handler exists. That
registration never raises the version floor; the page's hint later replaces it through
`registerApp`, which re-validates the restored grants.

**Why `isOriginServedFromCache` asks Electron's protocol-handler registry instead of the
broker.** `Broker.app.isRegisteredSync` means "a manifest is in the grant ledger", which
`registerApp` sets independently of the scheme actually being intercepted. Showing "local cache,
pinned" for bytes that did not come from it is the false claim ADR-0007 exists to prevent.
