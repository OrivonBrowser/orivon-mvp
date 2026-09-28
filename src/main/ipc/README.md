# `src/main/ipc/`: the chrome-to-main channels

**What lives here.** The four IPC surfaces the chrome view and its popups use to reach main:
`ipc.ts` (tab and toolbar commands), `newtab-ipc.ts` (the dashboard's bookmarks and navigation),
`settings-ipc.ts` (the all-sites popup) and `site-info-ipc.ts` (the site-info popup, fixed to
the one origin it was opened for, never a command field). Each verifies `event.senderFrame`
against a known frame before doing anything; each file's header says why identity beats a URL
allowlist.

**Tied to Electron.** All four files.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (types),
[`../browsing/`](../browsing/) (bookmarks, `site-trust.ts`'s `web3Score`),
[`../shell/tabs.ts`](../shell/tabs.ts) (type only), [`../permissions/`](../permissions/) (the two
controllers and `site-data-runner.ts`), the top-level `channels.ts`.

**What it must never import.** [`../../broker/`](../../broker/). Every capability decision
arrives already resolved through `TabManager`, `PermissionsController`, `SiteInfoController` or
`BookmarkStore`.

**Owner stream.** `shell`. Maintenance only.
