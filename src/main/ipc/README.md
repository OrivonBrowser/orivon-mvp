# `src/main/ipc/`: the chrome-to-main channels

**What lives here.** The IPC surfaces the chrome view and its popups use to reach main:
`ipc.ts` (tab and toolbar commands, and what a menu, a split or a tab drag ask of the window; `act` carries a chrome module's own call to `shell/chrome-actions.ts`),
`newtab-ipc.ts` (the dashboard's bookmarks and navigation), `permissions-ipc.ts` (the all-sites
popup) and `site-info-ipc.ts` (the site-info popup, fixed to the one origin it was opened for, never a command
field). All but `newtab-ipc.ts` register on the `ipc` of the view they serve, so the handler goes with
the view and each window has its own; `newtab-ipc.ts` serves every dashboard tab in every window and
registers on `ipcMain` once per process. Each verifies `event.senderFrame` against a known frame
before doing anything, because a webContents' handlers hear every frame in it; `ipc.ts`,
`newtab-ipc.ts`, `permissions-ipc.ts` and `site-info-ipc.ts` all also check that
frame's committed URL against the one address the view was built to show, since a `WebFrameMain`
reference kept past a navigation Electron re-points elsewhere would otherwise still pass identity
alone.

**Tied to Electron.** All four files.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (types),
[`../browsing/`](../browsing/) (bookmarks, `site-trust.ts`'s `web3Score`),
[`../shell/tabs.ts`](../shell/tabs.ts) and [`../shell/window-registry.ts`](../shell/window-registry.ts)
(types only), [`../permissions/`](../permissions/) (the two controllers and `site-data-runner.ts`),
the top-level `channels.ts`.

**What it must never import.** [`../../broker/`](../../broker/). Every capability decision
arrives already resolved through `TabManager`, `PermissionsController`, `SiteInfoController` or
`BookmarkStore`.

**Owner stream.** `shell`. Maintenance only.
