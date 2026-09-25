# `src/main/install/`: a hinted manifest becomes a registered, consented app

**What lives here.** `app-install.ts`: the loader-to-broker glue (A60, A61) — builds the one
`LoadContext` `Loader.load()` needs from the broker, then hands whatever it returns to
`../consent/update-outcomes.ts`'s `driveLoadResult`. `app-install-subsystem.ts`: publishes
`ctx.installApp`, closing `app-install.ts` over this process's one `Broker`/`Loader` and every
real consent dialog. `manifest-hint.ts`: the discovery trigger's main-side half — turns a
reported `<link rel="orivon-manifest">` hint into a call to `installFromHint`.
`origin-queue.ts`: serialises concurrent `load()` calls for the same origin (A62).
`grant-without-install.ts`: the path for an origin the install path refuses. A loopback origin in
every build, and an orivon-ports `.eth` name in developer mode, has its manifest read, is
registered, and is asked for consent, with nothing fetched as a bundle, hashed, pinned or served
from cache. `granted-origin-csp.ts`: gives such an origin's documents the Content-Security-Policy
an installed app is served with.

**What it depends on.** [`../../broker/`](../../broker/) (`policy/origin.ts`, `policy/update.ts`,
`policy/manifest-patterns.ts`, `grants/origin-hash.ts`, `broker-contracts.ts` type,
`transport/token-bucket.ts`), [`../../loader/`](../../loader/) (`index.ts` type only,
`manifest.ts`, `electron-serve.ts`'s `liveCspHeaderFor`), [`../consent/`](../consent/)
(`update-outcomes.ts`, `install-consent.ts`, `install-consent-prompt.ts`,
`update-outcomes-prompt.ts`), [`../dev/dev-mode.ts`](../dev/dev-mode.ts), the top-level
`channels.ts`/`registry.ts`, `node:async_hooks`.

**What it must never import.** `electron`, in `app-install.ts`, `origin-queue.ts` and
`grant-without-install.ts` — the suffix rule again: only `app-install-subsystem.ts`,
`manifest-hint.ts` and `granted-origin-csp.ts` may. And neither of
those two may construct a second `Broker` or `Loader` of their own; both must read
`ctx.broker`/`ctx.loader` as published by `registry.ts`, the same rule every subsystem carries,
stated here because `app-install-subsystem.ts` is the one file in this directory that closes
over both at once.

**Owner stream.** `loader`, build step 4, S4-2/S4-4. Maintenance only.

## Design notes

**[`app-install.ts`](app-install.ts): what "before the app's own scripts run" actually means
here, stated precisely because the two readings differ.** `requestInstallConsent` is awaited
inside `installFromHint`'s own `'installed'` branch, so the dialog is fully resolved (shown,
answered, every accepted capability granted) before `installFromHint`'s promise ever resolves.
That is the strongest guarantee available here: nothing downstream of this function's return can
observe an unconsented app. **It is NOT "before this page's scripts execute", and the difference
matters more than it first looks**; see `open-questions.md` A146.

The production caller is [`manifest-hint.ts`](manifest-hint.ts), the discovery trigger.
It fires when the page's own delivered HTML is parsed, which means **the page is already running
by the time consent is asked.** An app's first-visit script can therefore call a capability while
the dialog is still on screen, and get `'denied'`, which is precisely the race asking before the
app's code runs is meant to remove. On every later visit there is no race at all: the grant is
already held, so the app starts with a decided answer. The gap is first visit only.

That first load also runs from the network, in an ordinary tab: the app-tab flag and the
partition are fixed when a tab is built, before the origin was registered, so it has no routed
fetch and no process shim either. **One automatic reload closes both.** `installFromHint` marks
an `'installed'` result `newlyRegistered` when this install is what registered the origin with
the broker this session, and [`manifest-hint.ts`](manifest-hint.ts) reloads the tab that reported
the hint exactly then, after consent has been answered. The reloaded tab is rebuilt in the app's
partition with its flag, runs from the pinned cache, and starts with a decided grant. A repeat
visit, or an app restored at startup (already registered from its pinned manifest), is never
reloaded, so the reload cannot loop.

What stays open is only that first, pre-reload load itself: holding the page before its scripts
run would be a change to how a tab navigates rather than anything this directory can do (A146).

**[`app-install-subsystem.ts`](app-install-subsystem.ts): publishes `ctx.installApp`, the one
install entry point.** It closes over the broker, the loader and the real consent dialog
together, and [`manifest-hint.ts`](manifest-hint.ts) consumes it rather than building its own
`AppInstallDeps`. One definition of how `installFromHint` is wired for real means two call sites
cannot drift, with one passing `consent` and the other forgetting it, which would silently degrade
to "every app installs with nothing granted" with no error anywhere.

**[`grant-without-install.ts`](grant-without-install.ts): why a loopback origin is asked, not
refused.** An app served from this machine asks for its permissions like any other page, in every
build, so a person running a local server gets the same prompt a published app shows. The install
path cannot serve it: `../../loader/install-origin.ts` refuses a non-https, non-public origin
before any manifest is read, and pinning a bundle from one would protect nothing. What bounds it:

- **Loopback only**, as `isLoopbackHost` in `../../broker/policy/origin.ts` defines it: a loopback
  literal, or a `localhost` name, which Chromium resolves to loopback without DNS.
- **The manifest comes from the origin the page was loaded from**, the sender frame's, never from
  a URL the page names, so a page cannot aim the shell's request at another local service.
- **Nothing proves the address was typed.** A page that links to a loopback URL leads to the same
  prompt; the person answering it is the gate.
- **Session-only.** A loopback grant is never written to disk (T13c, `isPersistableOrigin`).
- **A re-hint cannot widen a held grant.** If the manifest now asks for more on a capability
  already held, the hint is refused rather than re-prompted, because an all-or-nothing accept
  would re-grant it under a row the prompt labels as already allowed.

**[`granted-origin-csp.ts`](granted-origin-csp.ts): why an origin granted without installing gets
the installed CSP at all.** A port that runs cleanly on its own server and breaks once installed
is a port that was never tested against the environment it ships into; the installed path's CSP
is the difference most likely to cause that. So such an origin's documents carry the policy
`../../loader/serve-csp.ts` builds, from the same live grants, read per response. It is added
through `session.webRequest.onHeadersReceived` on the origin's own app partition, because the
origin is served by its own server rather than through `protocol.handle` (A110 concerns only the
latter).

- **Documents only** (`mainFrame`, `subFrame`) from that exact origin. A worker script from the
  server carries no added policy, which makes such a worker more permissive than an installed
  one, never less.
- **Appended, never replacing.** The server's own CSP stays in the response beside it. The
  browser enforces every policy it receives, so a port is held to both.
- **One listener per session.** Electron keeps one `onHeadersReceived` listener per session;
  nothing else in `src/` listens on an app partition, and installing again for the same origin
  replaces the listener rather than stacking a second one.
- **No `ws:` source for hot reload.** A dev server's hot-reload WebSocket on the page's own host
  and port is admitted by `connect-src 'self'` (measured in Electron 44,
  `test/e2e-websocket-routing.test.ts`); one on another port is refused (open-questions A241).
