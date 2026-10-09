# `src/main/install/`: a hinted manifest becomes a registered, consented app

**What lives here.** `manifest-hint.ts` turns a page's `<link rel="orivon-manifest">` hint into
an install, or into a first visit (`first-visit.ts`, `first-visit-decisions.ts`, `hint-host.ts`, `revoke-all-grants.ts`). `app-install.ts` is the loader-to-broker glue (A60, A61), and
`app-install-subsystem.ts` publishes it as `ctx.installApp`. `origin-queue.ts` serialises
concurrent `load()` calls for one origin (A62). `grant-without-install.ts` grants an origin the
install path refuses (loopback in every build; an orivon-ports `.eth` name in developer mode)
without fetching, pinning or serving a bundle, and `granted-origin-csp.ts` gives such an origin's
documents an installed app's CSP, through one handler `app-install-subsystem.ts` registers on the
default session's `webRequest` owner. `local-file-grant.ts` does the same for a file opened from this computer: its manifest
is read only from under the document's folder, the file is registered against it, and a Yes to the question that needs two
presses records the file (`../local-files/`) and grants all it declares (`ADR-0060`).

`app-updates.ts` is what happens to an installed app whose name moved (`ADR-0056`): it judges an
`update-available` verified or not (`../../trust/app-update-trust.ts`), asks through `../consent/`,
applies the offered root on Yes or a confirmed Trust & Force, and reloads every tab on the origin.
`update-watch.ts` looks again, every 30 minutes, at each origin with an open app tab, and
`dialog-caller.ts` is how a question finds the tab that raised it.

**Tied to Electron.** `app-install-subsystem.ts` and `manifest-hint.ts` import `electron`; the
others -- `granted-origin-csp.ts` included -- must not.

**What it depends on.** [`../../broker/`](../../broker/) (`broker-contracts.ts` type,
`policy/origin.ts`, `policy/update.ts`, `policy/manifest-patterns.ts`, `grants/origin-hash.ts`,
`transport/token-bucket.ts`), [`../../loader/`](../../loader/) (`index.ts` type,
`manifest/manifest.ts`, `electron/serve.ts`'s `liveCspHeaderFor` and
`isOriginServedFromCacheSync`), [`../app-setup/`](../app-setup/) (`TabScreens`, a type), [`../../trust/ddoc.ts`](../../trust/ddoc.ts) (`ddocVerdict`), [`../consent/`](../consent/) (`install-consent*`,
`update-outcomes*`), [`../dev/`](../dev/) (`dev-mode.ts`, `eth-resolver.ts`'s name pattern, `score-levels.ts`),
[`../extensions/site-reach-runner.ts`](../extensions/site-reach-runner.ts)'s
`extensionNamesForOrigin` (the extensions disclosure, `docs/planning/extensions-exploration.md`, wired into
the install-consent prompts here the same way `../consent/README.md` describes),
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts),
[`../../contracts/`](../../contracts/), the top-level `channels.ts`/`registry.ts`,
`node:async_hooks`.

**What it must never import.** `electron`, outside the two files named above. No file here
constructs its own `Broker` or `Loader`: read `ctx.broker`/`ctx.loader` from `registry.ts`.

**Owner stream.** `loader`. Maintenance only.

## Design notes

**[`first-visit.ts`](first-visit.ts) is the order of a first visit, and [`app-install.ts`](app-install.ts) is every visit after it
(`ADR-0075`).** An origin Orivon has never held (no registration, pin or saved version, and not refused) is asked about as soon as its
manifest is read, with the tree its site declares read beside the question; on Allow it is served, registered, granted and entered at once, and
its whole bundle is downloaded, judged against the declared tree and pinned afterwards in the background (`letIn`). The loader's `readManifest`,
`readDeclaration` and `serveLive` are the reads and the serving, `fetchForInstall` and `installFetched` the background install. Bad data from
anywhere (a served file, the background download) takes the origin away whole through one function, once: the tabs are covered
(`../app-setup/block-tabs.ts`), `Broker.forgetOrigin` removes the grants, the registration and the version floor, and the handler goes. While the
background download runs the origin reads as `settling` and holds its queue, so a page's own hint installs nothing beside it. What was allowed is kept (`rememberConsent`) until the pin lands: `resume` serves it again at start, checked, and a name or site that has moved is followed to its current version (`first-visit-keeper.ts`'s `fresh` and `switchTo`), never blocked.
`installFromHint` keeps the update, re-consent and rollback paths of an app Orivon already holds. A first visit that began from a page's hint
(`hint-host.ts`, the `https` apps, and the fallback for a first page that could not be held) runs after the page's scripts have run up to
`DOMContentLoaded`: it stops the page when it has read an app's manifest, and enters through the address bar's own path. The verifier-served
origins are held earlier, in [`../app-setup/`](../app-setup/README.md), so nothing runs. A refused origin (`visitKind` `declined`, the record in
`declined-apps.ts`, written by a pressed Deny only) is ignored by the hint listener. Nothing is granted before the answer is yes
(`../consent/install-consent-ask.ts`); `revoke-all-grants.ts` takes back what an earlier version left to a blocked origin.

**[`app-install-subsystem.ts`](app-install-subsystem.ts) is the one wiring of
`installFromHint`.** Two call sites building their own deps could drift, one forgetting
`consent`, and every app would silently install with nothing granted.

**[`grant-without-install.ts`](grant-without-install.ts): a loopback origin is asked, not
refused,** so a local server gets the prompt a published app shows (`d-0118`). Its header lists
the bounds: loopback only, manifest from the sender frame's origin, session-only grants, and a
re-hint that would widen a held grant is refused.

**[`granted-origin-csp.ts`](granted-origin-csp.ts): such an origin gets the installed CSP**
(`d-0050`), because a port that works on its own server and breaks once installed was never
tested against what it ships into. It is appended to the server's own policy, on documents and
on a worker's own script (a `script` response, provisionally, as the filter's own doc says); the
isolation headers stay on documents, since COOP/COEP on the wrong response can break a working
page. A
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
anything else. A cache-served origin's network-delivered document, committed in the default session
before its tab moves to the app's partition, gets this policy too; its pinned copy, served through
`protocol.handle`, never reaches this handler and carries its CSP from `csp.ts` (A110).
