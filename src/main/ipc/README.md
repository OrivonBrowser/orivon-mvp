# `src/main/ipc/`: the chrome→main channels

**What lives here.** The three IPC surfaces the chrome view and its panels use to reach main:
`ipc.ts` (tab commands — new tab, close, navigate), `newtab-ipc.ts` (the dashboard's read-only
bookmark access and navigate-the-calling-tab command), `settings-ipc.ts` (the permissions panel's
list/revoke commands). Each registers its own `ipcMain.handle`, and each verifies
`event.senderFrame` against a known frame before doing anything — object identity against a
known frame is a stronger guard than a URL allowlist, and the source file headers say why, per
file.

**What it depends on.** `electron`, [`../../contracts/`](../../contracts/) (types),
[`../browsing/`](../browsing/) (bookmarks, delivery-provenance), [`../shell/tabs.ts`](../shell/tabs.ts)
(type only), [`../permissions/`](../permissions/), and the top-level `channels.ts`.

**What it must never import.** [`../../broker/`](../../broker/) directly. None of these three
files reach the broker themselves; every capability decision arrives already resolved, through
`TabManager`/`PermissionsController`/`BookmarkStore`, never by querying the broker from an IPC
handler.

**Owner stream.** `shell`, build step 1, **done**, except `settings-ipc.ts` (queue item 4.4).
Maintenance only.
