# `src/main/history/`: the pages that were visited

**What lives here.** The record of pages a person has reached, kept on this computer. `history-store.ts`
is the interface (and the store that keeps nothing), `sqlite-history-store.ts` keeps it in one file,
`open-history.ts` opens that file and falls back to the null store when it cannot be used,
`history-service.ts` applies the person's two settings (whether to remember, and for how long),
`attach-history.ts` and `install-history.ts` write down each page a tab reaches, and
`history-domain.ts` is what the History page may ask.

**What it depends on.** `node:sqlite` (Node's own, so no native package: Rule 8); `electron` (the
recorder, on `WebContents`); [`../settings/`](../settings/) (the two settings);
[`../storage/`](../storage/) (the debounced write); [`../../protocols/builtin.ts`](../../protocols/builtin.ts)
(a protocol page is kept under the address the person sees); [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts)
(the shape of a page's domain); [`../shell/window-registry.ts`](../shell/window-registry.ts) (type only).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts): the recorder finds tabs through the
window registry. [`../../renderer/`](../../renderer/) code.

**Owner stream.** `shell`.

**Electron dependence.** The store, the service and the domain do not depend on Electron and would outlive
a change of the engine beneath it. The recorder (`attach-history.ts`, `install-history.ts`) is tied to it.

## Design notes

**Behind an interface because `node:sqlite` is experimental.** Node ships it unflagged from 22.13 and marks
it experimental; the rest of the shell speaks to `HistoryStore`, so replacing the file format is a change to
one class. Tests load it under Vitest on the host's Node, which is why `engines` starts at 22.13.

**A visit is a row, and so is a page.** Each time a page is reached adds a row to `visits`, and the page
keeps a count and its last time. Forgetting a range of time then removes the visits in it and the pages that
have none left, and a page visited on both sides of the range stays, with a count that is right.

**Writes wait half a second.** A page that redirects twice is one transaction. Reading flushes what is waiting
first, so a list is never behind, and quitting flushes it (`DebouncedWriter.flushAll`).

**A page cannot make the list grow without bound.** A change of address inside a page is kept at most once a
second per tab, and past 100,000 pages the ones visited longest ago go. A write that fails (a full disk, a damaged
page) is reported and dropped rather than raised: it happens inside event handlers, where a throw ends the browser.

**Forgetting overwrites.** `secure_delete` is on, and clearing or removing a range empties the write-ahead log (and
clearing rewrites the file), so an address a person cleared is not left readable in it. That is not a claim about
what the disk itself keeps.

**Search of three characters or more probes an FTS5 trigram index**, an external-content table over
`pages(title, url)` kept in step by triggers on `pages` -- including the bulk `UPDATE`/`DELETE` `removeRange` runs,
since SQLite fires the same row-level triggers for those. A sparse term (most searches) is read through that
index; a dense one, at or above `searchDensityLimit` matches -- a common substring like `https://` -- falls back
to the plain `LIKE` scan instead, which walks the last-visit index and can stop after one page rather than
gathering every match first. A search under three characters, too short for a trigram to resolve, always takes
that `LIKE` path. `[...search].length` decides which side of that threshold a search falls on -- Unicode
characters, not UTF-16 code units, so a two-character emoji-plus-letter query is not miscounted as three.

**LIKE is the one definition of "matches"; FTS5 is only an accelerator for it.** MATCH folds Unicode case,
where LIKE folds only ASCII, so the two would otherwise disagree on a search like `'école'` against a title
holding `École`. The FTS path's query ANDs the same `LIKE` condition onto the rows MATCH narrows to, so a
search returns the same rows whichever path answered it. Every statement `list`, `count` and the rest run more
than once is prepared once, in the constructor, and reused. The index is built by `PRAGMA user_version`'s
v1-to-v2 migration, which `rebuild`s it from every row already in `pages` -- measured at 1.9s for a full
100,000-page history.

**FTS5's own `secure-delete` is on**, set once in that same migration and persisting across every later reopen:
without it, forgetting a page's ordinary FTS5 delete only tombstones its posting, leaving the trigrams it once
held in already-allocated index pages that `secure_delete`/VACUUM on `pages` itself cannot reach. With it,
`remove`, `removeRange`, `trim` and `clear` all erase the posting at delete time, at a real cost:
`removeRange` of 10,000 of 100,000 rows measured at roughly 3.2-3.5s with it on, against about 0.26s without --
paid on an explicit "forget" action, never on the read or write path a person waits on.

**A file that cannot be used is left alone.** If the database is damaged or from a newer version, history is off
for that run and Settings says why; the file is neither deleted nor replaced, so nothing a person could recover is
destroyed by a bad start.

**What is a visit.** A top-level navigation that committed, of an `http`, `https`, `ipfs` or `ipns` address, in a
tab that is not the new-tab page or one of the shell's own, and whose response was not an error. A `.eth` name
and an `ipfs://` page are kept under the address the person sees, not the address that serves them.

**Older than the retention is removed at start.** And again whenever the choice changes. The default of 90 days is
provisional (`open-questions.md`).
