# `src/main/install/`: a hinted manifest becomes a registered, consented app

**What lives here.** `app-install.ts`: the loader-to-broker glue (A60, A61) — builds the one
`LoadContext` `Loader.load()` needs from the broker, then hands whatever it returns to
`../consent/update-outcomes.ts`'s `driveLoadResult`. `app-install-subsystem.ts`: publishes
`ctx.installApp`, closing `app-install.ts` over this process's one `Broker`/`Loader` and every
real consent dialog. `manifest-hint.ts`: the discovery trigger's main-side half — turns a
reported `<link rel="orivon-manifest">` hint into a call to `installFromHint`.
`origin-queue.ts`: serialises concurrent `load()` calls for the same origin (A62).

**What it depends on.** [`../../broker/`](../../broker/) (`policy/origin.ts`, `policy/update.ts`,
`broker-contracts.ts` type, `transport/token-bucket.ts`),
[`../../loader/index.ts`](../../loader/index.ts) (type only),
[`../consent/`](../consent/) (`update-outcomes.ts`, `install-consent-prompt.ts`,
`update-outcomes-prompt.ts`), [`../dev/dev-app-origin.ts`](../dev/dev-app-origin.ts), the
top-level `channels.ts`/`registry.ts`, `node:async_hooks`.

**What it must never import.** `electron`, in `app-install.ts` and `origin-queue.ts` — the
suffix rule again: only `app-install-subsystem.ts` and `manifest-hint.ts` may. And neither of
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
