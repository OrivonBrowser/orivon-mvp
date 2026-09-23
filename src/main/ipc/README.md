# `src/main/ipc/`: the chrome→main channels

**What lives here.** The four IPC surfaces the chrome view and its popups use to reach main:
`ipc.ts` (tab commands — new tab, close, navigate — plus the toolbar's own `siteSummaryFor`/
`openSettings`/`openSiteInfo`), `newtab-ipc.ts` (the dashboard's read-only bookmark access and
navigate-the-calling-tab command), `settings-ipc.ts` (the all-sites popup's list/revoke
commands, and the site list's list/reset), `site-info-ipc.ts` (the site-info popup's get/trust/data/apply/revokePickedPath/
clearBrowserData/reload/openAllSites commands, all fixed to the ONE origin the popup was opened
for — never a command field). Each registers its own `ipcMain.handle`, and each verifies
`event.senderFrame` against a known frame before doing anything — object identity against a
known frame is a stronger guard than a URL allowlist, and the source file headers say why, per
file.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (types),
[`../browsing/`](../browsing/) (bookmarks, delivery-provenance), [`../shell/tabs.ts`](../shell/tabs.ts)
(type only), [`../permissions/`](../permissions/) (`PermissionsController`, `SiteInfoController`,
`SiteInfo`, `site-data-runner.ts`'s exported functions), and the top-level `channels.ts`.

**What it must never import.** [`../../broker/`](../../broker/) directly. None of these four
files reach the broker themselves; every capability decision arrives already resolved, through
`TabManager`/`PermissionsController`/`SiteInfoController`/`BookmarkStore`, never by querying the
broker from an IPC handler.

**Owner stream.** `shell`, build step 1, **done**, except `settings-ipc.ts` and `site-info-ipc.ts`
(queue item 4.4). Maintenance only.
