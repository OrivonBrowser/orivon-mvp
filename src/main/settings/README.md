# `src/main/settings/`: what the person has chosen

**What lives here.** `schema.ts` is every setting in one table: its default and what a value has to
be to be accepted (an option from a list, a boolean, an integer in bounds, text of a limited length
that passes a check). `settings-store.ts` holds the person's choices for this profile in memory and
in `<userData>/settings.json`, tells listeners about each change, and validates everything it is
given. `settings-appliers.ts` is what a change does to the rest of the browser for the settings
whose effect is not read on demand (today the theme).

**What it depends on.** [`../browsing/search-engines.ts`](../browsing/search-engines.ts) (the
custom search template's check), [`../storage/`](../storage/) (the debounced write) and
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts)
(`writeFileAtomic`). No `electron` import: the theme applier is handed the object it sets.

**What it must never import.** [`../shell/`](../shell/): the shell reads settings, never the reverse.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**Only a choice that differs from the default is written.** A default that improves later then
reaches everyone who never touched it, and "changed from default" is a fact of the file rather than a
comparison against a copy of the defaults the page would have to carry.
The Web3 Score provider is such a default, an address (`DEFAULT_SCORE_PROVIDER`): a profile that
has none saved reads it; clearing the setting saves the empty value, which asks nobody.

**Every value is validated where it enters, and again where it is read from disk.** The Settings page
is trusted UI, but the store does not take its word: an unknown key or a value the schema refuses is
returned as a failure and changes nothing. A file edited by hand, or written by another version, has
its refused entries dropped with one warning and keeps the rest, because a browser that will not
start over its own settings file is worse than one that forgot a choice.

**The page is told the schema, not given a copy.** `describeSettings()` returns each setting's
kind, default and options with no function in it, so it crosses IPC as data. The page cannot offer
a value the store would refuse, and adding a setting is one entry in one table.
