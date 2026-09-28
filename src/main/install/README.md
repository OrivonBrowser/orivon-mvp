# `src/main/install/`: a hinted manifest becomes a registered, consented app

**What lives here.** `manifest-hint.ts` turns a page's `<link rel="orivon-manifest">` hint into
an install. `app-install.ts` is the loader-to-broker glue (A60, A61), and
`app-install-subsystem.ts` publishes it as `ctx.installApp`. `origin-queue.ts` serialises
concurrent `load()` calls for one origin (A62). `grant-without-install.ts` grants an origin the
install path refuses (loopback in every build; an orivon-ports `.eth` name in developer mode)
without fetching, pinning or serving a bundle, and `granted-origin-csp.ts` gives such an origin's
documents an installed app's CSP, through one handler `app-install-subsystem.ts` registers on the
default session's `webRequest` owner.

**Tied to Electron.** `app-install-subsystem.ts` and `manifest-hint.ts` import `electron`; the
other four -- `granted-origin-csp.ts` included -- must not.

**What it depends on.** [`../../broker/`](../../broker/) (`broker-contracts.ts` type,
`policy/origin.ts`, `policy/update.ts`, `policy/manifest-patterns.ts`, `grants/origin-hash.ts`,
`transport/token-bucket.ts`), [`../../loader/`](../../loader/) (`index.ts` type,
`manifest/manifest.ts`, `electron/serve.ts`'s `liveCspHeaderFor` and
`isOriginServedFromCacheSync`), [`../consent/`](../consent/) (`install-consent*`,
`update-outcomes*`), [`../dev/`](../dev/) (`dev-mode.ts`, `score-levels.ts`),
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts),
[`../../contracts/`](../../contracts/), the top-level `channels.ts`/`registry.ts`,
`node:async_hooks`.

**What it must never import.** `electron`, outside the two files named above. No file here
constructs its own `Broker` or `Loader`: read `ctx.broker`/`ctx.loader` from `registry.ts`.

**Owner stream.** `loader`. Maintenance only.

## Design notes

**[`app-install.ts`](app-install.ts): consent resolves before `installFromHint` does, not before
the page's scripts run.** The hint is reported once the page is already running, so on a first
visit an app's early capability call can get `'denied'` while the dialog is up (A146, accepted).
That first load also runs outside the app tab (no routed fetch, no process shim), because a
tab's flag and partition are fixed when it is built. So [`manifest-hint.ts`](manifest-hint.ts)
reloads the reporting tab once after consent, only when this install newly registered the origin
(`newlyRegistered`); a repeat visit or a startup restore is never reloaded, so it cannot loop
(A234, `d-0053`).

**[`app-install-subsystem.ts`](app-install-subsystem.ts) is the one wiring of
`installFromHint`.** Two call sites building their own deps could drift, one forgetting
`consent`, and every app would silently install with nothing granted.

**[`grant-without-install.ts`](grant-without-install.ts): a loopback origin is asked, not
refused,** so a local server gets the prompt a published app shows (`d-0118`). Its header lists
the bounds: loopback only, manifest from the sender frame's origin, session-only grants, and a
re-hint that would widen a held grant is refused.

**[`granted-origin-csp.ts`](granted-origin-csp.ts): such an origin gets the installed CSP**
(`d-0050`), because a port that works on its own server and breaks once installed was never
tested against what it ships into. It is appended to the server's own policy, on documents only,
so a worker from that server carries none and is more permissive than an installed one. A
hot-reload WebSocket on the page's own host and port passes `connect-src 'self'` (measured in
Electron 44); one on another port is refused (A241).

**[`granted-origin-csp.ts`](granted-origin-csp.ts): one handler for every such origin, not one
registration per grant.** `defaultSessionGrantedOriginCsp` decides the document's origin from the
response itself (`documentOriginOf`) and checks that origin's live grant and cache-served status
fresh on every response, so a grant, a revoke or an origin starting to be served from the pinned
cache all reach the very next load with nothing to re-register.
[`app-install-subsystem.ts`](app-install-subsystem.ts) registers it once, at startup, on
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts)'s default-session owner,
last among that session's `onHeadersReceived` handlers so Orivon's own policy is applied after
anything else. A cache-served origin is excluded even when it also holds a grant: its CSP is set
inside the `protocol.handle` response instead, which this handler never sees (A110).
