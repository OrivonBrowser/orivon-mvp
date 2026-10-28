# `src/main/settings/`: what the person has chosen

**What lives here.** `schema.ts` is every setting in one table: its default and what a value has to
be to be accepted (an option from a list, a boolean, an integer in bounds, text of a limited length
that passes a check). `settings-store.ts` holds the person's choices for this profile in memory and
in `<userData>/settings.json`, tells listeners about each change, and validates everything it is
given. `settings-file.ts` is what the file's text holds once validated, and `readSettingBeforeReady`, which
reads one value ahead of everything for a setting Chromium takes at start (Global Privacy Control; the store
keeps the values it started with, `valuesAtStart`, so the page can say a restart is waiting). A file that is there and cannot be used (unreadable, or of a version this build does not read) is read as the whole browser being on the tunnel (`everywhereBeforeReady`, and the store holds `network.tunnel.everywhere` on, keeps a copy of the file beside it and says so through `fileUnreadable`), since what the person chose about the tunnel is not known; a missing file means the defaults. `settings-appliers.ts` is what a change does to the rest of the browser for the settings
whose effect is not read on demand (today the theme).

**What it depends on.** [`../browsing/search-engines.ts`](../browsing/search-engines.ts) (the
custom search template's check), [`../storage/`](../storage/) (the debounced write) and
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts)
(`writeFileAtomic`). `proxy-checks.ts` reads the `host:port` of the SOCKS5 proxy a routed app uses. `rpc-checks.ts` holds the checks of the Ethereum server settings and asks [`../../protocols/verifier-host/light-client/server-address.ts`](../../protocols/verifier-host/light-client/server-address.ts) what an address may be: pure code, the one the Settings page asks too. A text setting may hold a key (the Ethereum server addresses do): it is never reported (a report states switches and choices only), and `NYM_HELD_SETTINGS` empties it for a private window held to Nym. No `electron` import: the theme applier is handed the object it sets.

**What it must never import.** [`../shell/`](../shell/): the shell reads settings, never the reverse.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**A process can be held to values.** `SettingsStore` takes an optional map of settings the process is held to (`NYM_HELD_SETTINGS`, for a private
window opened with Nym): `get` answers them whatever the file says, `set`, `reset` and `resetAll` leave them alone (`set` and `reset` answer
`locked`), and the Settings page asks which they are (`held`) to show them as they are, fixed. `forceSettingsFile` writes such values into a
settings file through the version and checks the store reads with, keeping the other choices.

**A file's version carries a choice it could not hold.** `network.route.kind` (Nym, or the SOCKS5 address) did not exist when
version 1 settings files were written, and a choice left at its default is never written. So a version 1 file with an address
and no choice is a person who set up their own server: it reads as `socks5`, and the store writes version 2, where an
address with no choice is a person who chose Nym. A build that reads only version 1 ignores a version 2 file whole.

**A new setting leaves the file version alone when its absence already means its default.** `network.nym.privacy` is read as Balanced from a file that has no entry, so no file needs rewriting and the version stays 2; only a choice that must be told from a missing one (the `network.route.kind` case above) needs a new version. A build that does not know a key drops it when it reads the file.

**Only a choice that differs from the default is written.** A default that improves later then
reaches everyone who never touched it, and "changed from default" is a fact of the file rather than a
comparison against a copy of the defaults the page would have to carry.
The Web3 Score provider is such a default, an address (`DEFAULT_SCORE_PROVIDER`): a profile that
has none saved reads it; clearing the setting saves the empty value, which asks nobody.
The Extensions button's `always` is a default of the same kind: a profile that never chose shows the button, one that chose `auto` or `never` keeps that.

**Every value is validated where it enters, and again where it is read from disk.** The Settings page
is trusted UI, but the store does not take its word: an unknown key or a value the schema refuses is
returned as a failure and changes nothing. A file edited by hand, or written by another version, has
its refused entries dropped with one warning and keeps the rest, because a browser that will not
start over its own settings file is worse than one that forgot a choice.

**The page is told the schema, not given a copy.** `describeSettings()` returns each setting's
kind, default and options with no function in it, so it crosses IPC as data. The page cannot offer
a value the store would refuse, and adding a setting is one entry in one table.
