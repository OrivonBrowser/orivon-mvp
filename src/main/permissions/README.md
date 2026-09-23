# `src/main/permissions/`: the grant list, and the per-site popover

**What lives here.** Two surfaces, each with its own controller so neither grows into a single
god-object.

The all-sites surface: `permissions.ts`, the grant list with revocation (d-0027, owner decision
9 — a grant lasts until revoked, and is visible in a list the user can revoke from). Revoke
only; there is no "forget this app entirely" here, that is `GrantLedger.forgetOrigin`.
`permissions-panel.ts` is its own in-window popup hanging off the toolbar cluster's tune icon.

The site-info surface, for the address pill's shield and key: `site-info.ts` (pure —
row-per-declared-capability, not row-per-grant, so a switch can show something the site asked
for and does not currently hold), `site-switches.ts` (`turnOffCapability`/`turnOnCapability`,
re-validated against the manifest at commit time — the same A153 idiom
`../consent/request-grant.ts` already uses), `site-info-controller.ts` (the one door to the
broker/loader for this surface, mirroring `permissions.ts`'s own controller),
`site-data-runner.ts` (the Cookies and site data page's I/O: disk sizes, cookie counts, a
best-effort `navigator.storage.estimate()` read through the tab's own isolated world), and
`site-info-panel.ts` (its own in-window popup, left-aligned).

Both popups share their `WebContentsView` lifecycle through `popover-view.ts` (sizing,
click-away dismissal, content-height resizing, a debounce against a toggle reopening what its
own close just dismissed).

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/),
[`../../broker/`](../../broker/) (`broker-contracts.ts`, `policy/origin.ts`,
`policy/request-grant.ts`, `policy/update.ts`'s `sameOwnPatterns`, `grants/ledger-storage.ts`
types), [`../../loader/`](../../loader/) (`manifest.ts`; `index.ts`'s `Loader`/`LoadResult`
types and `pinFor`; `electron-serve.ts`'s `isOriginServedFromCacheSync`/`pinCoverageFor`, real
implementations injected by `../shell/window.ts`, never imported by `site-info.ts`/`site-switches.ts`
themselves), [`../../trust/`](../../trust/) (`delivery-ladder.ts` types, via `../browsing/site-trust.ts`),
[`../consent/grant-prompt-render.ts`](../consent/grant-prompt-render.ts) and
[`../consent/request-grant.ts`](../consent/request-grant.ts) (`clearDeclinedCapability`/
`addDeclinedCapability`), [`../browsing/site-trust.ts`](../browsing/site-trust.ts), and, inside
`src/main/`, `../shell/renderer-entry.ts`, `../shell/tabs.ts` (type only), `../ipc/settings-ipc.ts`,
`../ipc/site-info-ipc.ts`, the top-level `channels.ts`/`registry.ts`.

**What it must never import.** Nothing bypasses either controller. Every renderer surface that
shows grants or switches — `src/renderer/settings/permissions-view.ts` and
`src/renderer/site-info/` — reaches the broker only through `permissions.ts` or
`site-info-controller.ts`, never directly; none is a `broker` import away from the trust
boundary those files already crossed once.

**Owner stream.** `shell`, queue item 4.4. Maintenance only.
