# `src/main/pages/`: the shell's own pages

**What lives here.** How Settings, History, Profiles and Private exist as pages in tabs
(`ADR-0041`). `internal-pages.ts` names them and reads an `orivon://<page>[/path]` address.
`route.ts` decides which file such a request may read, and `serve.ts` answers it (with the CSP)
from the built renderer or the dev server; both are pure. `internal-session.ts` is the one
in-memory session that serves the scheme, and registers it before the app is ready. `internal-registry.ts`
records which webContents the shell opened as which page, `internal-tab.ts` keeps such a tab on its page,
and `internal-ipc.ts` is the single channel pages speak on, checked per call, `pages-domain.ts` lets one page take the person to another,
`app-domain.ts` starts the browser again for a setting read at start, and `telemetry-domain.ts` is the usage statistics choice. The other
domains live beside what they serve (`../settings/`, `../history/`, `../launch/`, `../permissions/`, `../verifier/`, `../self-update/`, `../privacy/`, `../shortcuts/`). `pages-subsystem.ts` and
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
listed type, and the dev server's `/@fs/` (which reads any file it can see) is proxied only when the
path, resolved, sits inside one of the roots `internal-session.ts` passes in -- the project's own
`src/` and `node_modules/`, given already resolved to their real paths since a symlinked
`node_modules` (this project's own parallel-worktree pattern) would otherwise never textually match
what Vite itself reports.

**A page is reached at many paths, and its assets are not.** `orivon://settings/privacy` is the
Settings page at a place inside it, so any path outside `assets/` returns the page, and `serve.ts`
pins a `<base>` into it so the page's relative asset URLs resolve the same at any depth: `/`, the
built page's own root, once built; in development, `/pages/<page>/`, since the page's own HTML there
is unbundled and its relative references (`./main.ts`, `./style.css`) are relative to that folder on
the dev server, not the served root.

**Authorisation compares the frame's address to what the shell recorded, not to what the page says.**
A webContents is an internal page because `TabManager.openInternal` registered it; `authorizeCall`
then requires that its top frame is still at that page's host. A page that has navigated elsewhere, to
another internal page included, is refused, so a page cannot borrow a sibling's domains.

**Internal views are closed, not parked.** A view leaving an app's partition is parked for the tab's
return; an internal page is opened again from the shell, and a parked view would keep the internal
session alive under a tab showing a website.
