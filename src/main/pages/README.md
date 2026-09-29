# `src/main/pages/`: the shell's own pages

**What lives here.** How Settings, History, Profiles, Private and Extensions exist as pages in
tabs (`ADR-0041`). `internal-pages.ts` names them and reads an `orivon://<page>[/path]` address.
`route.ts` decides which file such a request may read, and `serve.ts` answers it (with the CSP)
from the built renderer or the dev server; both are pure. `internal-session.ts` is the one
in-memory session that serves the scheme, and registers it before the app is ready. `internal-registry.ts`
records which webContents the shell opened as which page, `internal-tab.ts` keeps such a tab on its page,
and `internal-ipc.ts` is the single channel pages speak on, checked per call, `pages-domain.ts` lets one page take the person to another,
`app-domain.ts` starts the browser again for a setting read at start, and `telemetry-domain.ts` is the usage statistics choice. The other
domains live beside what they serve (`../settings/`, `../history/`, `../launch/`, `../permissions/`, `../verifier/`, `../self-update/`, `../privacy/`, `../shortcuts/`, `../extensions/`). `pages-subsystem.ts` and
`start-internal-pages.ts` bring it up.

**What it depends on.** `electron`; [`../settings/`](../settings/) (the settings domain);
[`../browsing/omnibox.ts`](../browsing/omnibox.ts) (`sanitizeDirectUrl`, for what a page may open in an
ordinary tab); [`../shell/shell-services.ts`](../shell/shell-services.ts) (type only) and the top-level
`channels.ts` and `registry.ts`.

**What it must never import.** [`../../renderer/`](../../renderer/) code (the repo-wide rule), and
[`../shell/tabs.ts`](../shell/tabs.ts): `TabManager` calls this directory, never the reverse.

**Owner stream.** `shell`.

## Design notes

**The routing files are pure on purpose.** `route.ts` is the only place a request's path becomes a path
on disk, so it refuses by default and is tested against traversal in every spelling the URL parser
and percent-encoding allow: a page is one of a fixed few, a file is a plain file under `assets/` of a
listed type, and the dev server's `/@fs/` (which reads any file it can see) is never proxied.

**A page is reached at many paths, and its assets are not.** `orivon://settings/privacy` is the
Settings page at a place inside it, so any path outside `assets/` returns the page, and `serve.ts`
pins `<base href="/">` into it: the built page's relative asset URLs then resolve the same at any depth.

**Authorisation compares the frame's address to what the shell recorded, not to what the page says.**
A webContents is an internal page because `TabManager.openInternal` registered it; `authorizeCall`
then requires that its top frame is still at that page's host. A page that has navigated elsewhere, to
another internal page included, is refused, so a page cannot borrow a sibling's domains.

**Internal views are closed, not parked.** A view leaving an app's partition is parked for the tab's
return; an internal page is opened again from the shell, and a parked view would keep the internal
session alive under a tab showing a website.

**[`orphaned-app-partitions.ts`](orphaned-app-partitions.ts): a session `clearData()` call, not a
filesystem delete.** The alternative is removing `<userData>/Partitions/<hash>` directly, before any
`Session` object for it exists; rejected because that layout is an Electron implementation detail,
not a documented contract, and the codebase already has a proven, public mechanism for exactly this
(`../privacy/clear-data.ts`'s own "Clear app data", which calls the identical `session.fromPartition(
partitionFor(origin)).clearData()` for a cache-served app) -- reusing it costs nothing a raw delete
would save and avoids trusting an on-disk shape that could change under a future Electron upgrade.
The partition is left behind, empty, rather than deleted, for the same reason: Electron creates it
again the moment anything asks for that partition string, so removing the (now-empty) directory buys
nothing. Runs once, ever, per profile (one boolean marker, not one per origin) because no origin can
gain a NEW orphaned partition after this ships -- a grant no longer creates one at all.
