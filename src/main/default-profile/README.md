# `src/main/default-profile/`: what a new profile starts with

**What lives here.** `default-profile.ts` describes a new profile's starting content and reads its files:
the five bookmarks of the bar (`DEFAULT_BOOKMARKS`, `defaultBookmarks`, their icons as `data:` URLs), the
extensions to install (`bundledExtensions`, from `bundled-extensions.json`), the switch (`defaultProfileOn`)
and where the files are (`defaultProfileDir`). `default-profile-dir.ts` is that location for this run. The
files themselves are in [`../../../resources/default-profile/`](../../../resources/default-profile/).

**What it depends on.** [`../browsing/bookmark-types.ts`](../browsing/bookmark-types.ts) (a type). Nothing
else in the application.

**What it must never import.** The stores it seeds ([`../browsing/bookmarks.ts`](../browsing/bookmarks.ts),
[`../extensions/`](../extensions/)): each store is handed a function that returns the content, and
this directory never reaches into one.

**Owner stream.** `shell`.

**Electron dependence.** `default-profile.ts` is durable: it reads files and takes the paths and the
environment as arguments. Only `default-profile-dir.ts` is tied to Electron, for `app.isPackaged`.

## Design notes

**A store seeds itself only when its own file does not exist.** The bookmark store seeds in its "no file is a
first launch" branch; the extension subsystem seeds when `extensions/registry.json` is absent. A person who
empties the bar, or removes uBlock Origin, is never given them back, and a profile that predates this
directory is left as it is.

**`ORIVON_DEFAULT_PROFILE=off` skips both seeds.** The end-to-end suite sets it so a spec starts from a
blank profile; `npm run dev` leaves it on. The setting defaults (Web3 Score provider, Extensions button) are
not behind the switch: they are schema defaults, not seeds.

**A missing extension file is reported, never fatal.** The files come from
[`scripts/fetch-bundled-extensions.mjs`](../../../scripts/fetch-bundled-extensions.mjs), which a failed
download leaves undone; the browser then starts without them.
