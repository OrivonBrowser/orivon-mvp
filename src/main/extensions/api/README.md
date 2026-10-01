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

**Apps stay out of every answer.** `ctx.isAppOrigin(url)` is true for the origin of a registered
app; a data API leaves such URLs, tabs and storage out of its answers and events.
