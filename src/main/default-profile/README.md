# `src/main/default-profile/`: what a new profile starts with

**What lives here.** `default-profile.ts` describes a new profile's starting content and reads its files:
the five bookmarks of the bar (`DEFAULT_BOOKMARKS`, `defaultBookmarks`, their icons as `data:` URLs), the
extensions to install (`bundledExtensions`, from `bundled-extensions.json`), the switch (`defaultProfileOn`),
whether a profile folder is new (`isNewProfile`) and where the files are (`defaultProfileDir`). `profile-start.ts`
decides once, at boot, whether this start begins from the default profile, and answers the stores. `default-profile-dir.ts` is that location for this run. The
files themselves are in [`../../../resources/default-profile/`](../../../resources/default-profile/).

**What it depends on.** [`../browsing/bookmark-types.ts`](../browsing/bookmark-types.ts) (a type). Nothing
else in the application.

**What it must never import.** The stores it seeds ([`../browsing/bookmarks.ts`](../browsing/bookmarks.ts),
[`../extensions/`](../extensions/)): each store is handed a function that returns the content, and
this directory never reaches into one.

**Owner stream.** `shell`.

**Electron dependence.** `default-profile.ts` and `profile-start.ts` are durable: they read files and take the paths and the
environment as arguments. Only `default-profile-dir.ts` is tied to Electron, for `app.isPackaged`.

## Design notes

**Only a profile Orivon has never run on is seeded.** At boot, before any store opens a file, `decideDefaultProfile`
checks the profile folder for `history.db` (every ordinary launch creates it), `bookmarks.json` and
`extensions/registry.json`; none of them means new. `settings.json` does not count, because it can be written
before the first run. The bookmark store and the extension subsystem ask `startsFromDefaultProfile()` instead of
looking at their own file, since a store's file is written only by its first change: an existing profile that never
bookmarked anything or never installed an extension is not new, and a damaged registry file still counts as a
file. A person who empties the bar, or removes uBlock Origin, is never given them back.

**`ORIVON_DEFAULT_PROFILE=off` skips both seeds.** The end-to-end suite sets it so a spec starts from a
blank profile; `npm run dev` leaves it on. The setting defaults (Web3 Score provider, Extensions button) are
not behind the switch: they are schema defaults, not seeds.

**A missing extension file is reported, never fatal.** The files come from
[`scripts/fetch-bundled-extensions.mjs`](../../../scripts/fetch-bundled-extensions.mjs), which a failed
download leaves undone; the browser then starts without them.
