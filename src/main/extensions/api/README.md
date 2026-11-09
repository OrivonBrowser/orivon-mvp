# `src/main/extensions/api/`: main-side handlers for Orivon's `chrome.*` namespaces

**What lives here.** The registry of extension API modules (`api-registry.ts`), the context each
receives (`api-types.ts`, built by `api-context.ts`) and `install-apis.ts`, which installs the
permission check and runs every module once from `extensionsSubsystem.afterReady`, before the
first extension loads. Tied to Electron.

**What it depends on.** `../extension-host.ts` (the shell's services), `../extension-permission-check.ts`,
`../extension-host-access.ts`, `../extension-event-filter.ts`, `../extension-prefs.ts`, the
vendored library through `orivon:crx-extensions` and `orivon:crx-extensions-router`, and
[`../../../broker/policy/origin.ts`](../../../broker/policy/origin.ts).

**What it must never import.** `electron` from a module under this directory: a module reaches
tabs, windows, the session and the shell only through its `ExtensionApiContext`, so its unit test
supplies a fake one.

## Design notes

**One module per namespace.** A module is `{ name, permission?, install(ctx) }`, listed in
`api-registry.ts` one per line, alphabetical. `ctx.handle` registers on the library's own router,
so `senderMatchesClaimedExtensionId` applies to it: only the extension's own `chrome-extension://`
frames and worker reach a handler, never a web page, a content script or another extension.

**The module's permission is the default of each handler and each event.** A handler refused by
the router never runs; an event `<name>.<x>` reaches a listener only when `ctx.held` says it holds
the permission (`extension-event-filter.ts`'s `EVENT_GATES` adds per-event rules).

**A site that holds Orivon permissions is a website to a data API.** A tab, an address or a history
page is answered for or left out by the same rules whoever's it is: a tab in the default session
and not an Orivon page is a tab, and no module asks whether an origin holds grants.

**`chrome.sidePanel`** is registered by [`../side-panel-runner.ts`](../side-panel-runner.ts) (`sidePanelApi`, listed in
`api-registry.ts`): its context call builds the driver that runs the panel, so the module needs no `electron` value of
its own.

**The library namespaces.** `bookmarks-api.ts`, `history-api.ts` (with `topSites`) and
`search-api.ts` sit over the shell's stores through `ctx.shell()`, and the pure parts are apart:
`bookmarks-shape.ts` (Chrome's ids and nodes: root `0`, bar `1`, other `2`, the reading list never
visible), `bookmarks-diff.ts` (the store's change event carries no detail, so a snapshot is kept
and compared on each change), `bookmarks-quota.ts` (Chrome's write quota) and `history-shape.ts`
(items, the search window, the events derived from the newest 200 pages). `ctx.onShell` is how a
module that watches a store waits for the first window. A page of a site that holds permissions is
in the history answers and events like any other, and an extension may add or delete it by address
like any other.
