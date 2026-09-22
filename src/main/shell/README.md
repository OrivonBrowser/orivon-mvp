# `src/main/shell/`: the window, and the views inside it

**What lives here.** `window.ts` composes the frameless `BaseWindow`: a chrome view on top,
whichever tab's `WebContentsView` below. `tabs.ts` owns the tab collection and what gets pushed
to the chrome UI; `tab-view.ts` and `tab-types.ts` are its pure halves. `renderer-entry.ts`
resolves electron-vite's dev-server/file-URL split for both this and
[`../permissions/permissions-panel.ts`](../permissions/permissions-panel.ts).

**What it depends on.** `electron`; [`../../broker/`](../../broker/) (`policy/origin.ts`,
`grants/origin-hash.ts`, `broker-contracts.ts` types); [`../../loader/electron-serve.ts`](../../loader/electron-serve.ts)
(type only); and, inside `src/main/`, [`../browsing/`](../browsing/) (bookmarks, favicon,
omnibox, delivery-provenance), [`../ipc/`](../ipc/), [`../permissions/`](../permissions/), plus
the top-level `channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule).
Locally: [`tab-view.ts`](tab-view.ts) and [`tab-types.ts`](tab-types.ts) must never import
[`tabs.ts`](tabs.ts) — they were split OUT of it precisely so the pure parts have no
`TabManager` state to depend on, and an import the other way would recreate the coupling the
split exists to remove.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only.

## Design notes

**[`tabs.ts`](tabs.ts) is split three ways: constructing and partitioning a view, managing the
collection of tabs, and the shapes pushed to the chrome UI.** A tab's partition is computed on
every path that can change its origin, not only in `createTab()`: typing a URL or the
dashboard's navigate command goes through `TabManager.navigate()`, which swaps in a fresh
`WebContentsView` (`repartitionView()`) whenever the target's origin differs from the tab's
current partition. Electron fixes a partition at construction, so a live tab can only change
session by replacing its view outright, preserving the tab's id, position and active state. The
pure parts live apart so `tabs.ts` stays under Rule 2's 500 lines: `tab-view.ts` (view
construction and origin→partition derivation, no `TabManager` state) and `tab-types.ts` (the
wire-format interfaces, no logic at all), both re-exported from `tabs.ts`. **Trap:** a
deliberately swapped-out old view's own `'destroyed'` listener must be stripped *before*
`close()` is called, or the teardown calls `forgetTab()` on a tab that is not closing;
`tests/tabs.test.ts` exercises this directly with a fake `webContents` that emits `'destroyed'`
synchronously from `close()`, the same way real Electron destruction can.

**[`tabs.ts`](tabs.ts): what `TabManager`'s `ctx: SubsystemContext` is for, and why one half
of it is unused.** `ctx.broker` is read by every `makeTabView` call site (`appTabArgsFor`,
ADR-0017) to decide the `fetch()`-routing flag. It stays `Broker | undefined`, so a run where
the broker subsystem is absent simply never sets the flag, the same fallback shape
`partitionForTarget` already has. `ctx.loader` is threaded through but `TabManager` reads it
nowhere: the discovery trigger ([`../install/manifest-hint.ts`](../install/manifest-hint.ts))
installs through the published `ctx.installApp` instead. Anything that does read `ctx.loader`
must treat it as possibly absent: `loaderSubsystem` is not `critical`, unlike the broker.

**[`tabs.ts`](tabs.ts): every navigation that reaches a new origin repartitions the tab: a
typed URL, a redirect, a clicked link, a form submission or a script navigation (A108/A109).**
`wireView()`'s `did-navigate` handler calls `repartitionView()`, the same swap `navigate()` uses,
whenever the *committed* URL's origin differs from the tab's current partition.
`tab-view.ts`'s `partitionChanged` is the one comparison both paths use, so they can never
compute it two different ways.

**The residual: an early read in the old partition.** `did-navigate` fires only once a
navigation has already committed, and by then the new origin's page has already rendered once
inside the OLD partition and may already have read from it. This swap corrects the partition
going forward; it does not undo an early read. The stronger shape, `will-navigate`/`will-redirect`
with `preventDefault()` and a re-entry through the partition-aware path, catches it before commit,
but costs a fresh view and a lost navigation-history entry on every ordinary cross-origin link
click, not only a redirect. That earlier interception is an open question (A109), not built.

**Trap: the dashboard tab.** The
dashboard's own dev-mode URL is a real `http(s)` address, so treating its OWN first `did-navigate`
the same as an ordinary tab's would see partition `undefined` -> a real partition as an "origin
change" and repartition the dashboard into an app partition on its very first load. The handler
excludes `record.isDashboardTab` explicitly rather than relying on `partitionChanged` alone to
catch this case.
