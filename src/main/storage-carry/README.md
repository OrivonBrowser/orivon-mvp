# `src/main/storage-carry/`: what an app stored before it moved sessions

**What lives here.** The one-time carry of an allowed app's browser storage from the partition it used to run in
(`persist:app-<hash>`, [`../../broker/grants/origin-hash.ts`](../../broker/grants/origin-hash.ts)'s `partitionFor`) into the
session websites run in, for an app that now runs there ([`../shell/app-session.ts`](../shell/app-session.ts)'s
`runsAsWebsite`, ADR-0108).

| File | Job |
|---|---|
| `install-storage-carry.ts` | The wiring: the subsystem, the hold on the app's first main-frame page at the web-request owner, the background carries after launch, the clearing of the website session, the record in the profile |
| `carry-gate.ts` | Pure: runs the carry of an origin once, holds every page of it until the carry has ended, queues the carries of the apps nobody has opened, and gives each origin one deadline |
| `carry-runner.ts` | One origin's carry over two `CarrySide`s (a cookie jar and a hidden page each): local storage, then databases, then cookies; all or nothing; never throws |
| `page-code.ts` | The script that runs in the two hidden pages: the IndexedDB and local storage reads and writes and the port to the other page, as one string of plain JavaScript installed under a name made from the carry's nonce |
| `hold-rule.ts` | Pure: which request the hold applies to (a main-frame page of a served origin, not the empty document) |
| `carry-pages.ts` | The Electron half: a hidden view no window holds, at the shell's empty document ([`../../loader/electron/carry-page.ts`](../../loader/electron/carry-page.ts)), the port handed to it, and a cookie jar over a session |
| `cookies.ts` | Pure: whether a cookie of the old partition is the app's own, and how it becomes a cookie to set |
| `marker.ts` | Pure, apart from reading and writing the file: which origins were carried, tried and failed, with the report |
| `old-data.ts` | What the old partition's folder shows was stored, read from disk without opening the session |
| `report.ts` | Pure: the counts and the named problems one carry produced, and the line that sums them |

The hidden page's preload is [`../../preload/storage-carry.ts`](../../preload/storage-carry.ts).

**What it depends on.** `electron` (`install-storage-carry.ts`, `carry-pages.ts`), [`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts)
(the hold), [`../shell/app-session.ts`](../shell/app-session.ts) (whether the app runs as a website) and
[`../shell/lock-navigation.ts`](../shell/lock-navigation.ts), [`../../loader/electron/`](../../loader/electron/) (the empty
document, which origins the shell serves and when that changes), [`../../broker/grants/origin-hash.ts`](../../broker/grants/origin-hash.ts) and
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts).

**What it must never import.** The broker's grants, the renderer, or the app loader's install path: it moves bytes of storage
and decides nothing about what an app may do.

**Owner stream.** `install`.

**Electron dependence.** Tied to Electron in `install-storage-carry.ts` and `carry-pages.ts`. The gate, the runner, the script
and the planning are pure and run in unit tests against `fake-indexeddb`.

## Design notes

**The data of the old partition replaces what the website session holds for the origin, and the carry is all or nothing.** When
the old partition holds nothing for the origin (no cookie of the app's own, no local storage item, no database) nothing changes. When it does,
the website session's local storage, databases, service workers and Cache Storage for the origin are cleared first, so that no
database or item of an earlier visit survives next to the app's, and no worker of that visit answers the app's page. Cookies are
written over the cookies of the same name, domain and path and go last. A carry that cannot finish clears what it wrote, closes the
hidden pages before it does, and ends as failed with the reason; one that succeeds twice leaves the same session behind.

**The target is the session a website at the origin runs in by its own entry.** That is the shared session, or the profile session of the
tunnel the origin has an entry for (`../route/site-routes.ts`'s `sitePartitionForOrigin`; the app runs there as a website does, ADR-0108), and the
hold is installed on every website session (`../sessions/website-sessions.ts`'s `forEachWebsiteSession`). An origin that keeps a
partition of its own is not carried: `due` asks `runsAsWebsite`, which `hasOwnPartition` negates. A tab's own tunnel choice puts the site in
another session; nothing is carried into that one.

**Every moved app is carried soon after launch, one at a time, and a page waits for its app's carry to end.** The background
carries begin `EAGER_DELAY_MS` after launch (*provisional*), so the start of the browser comes first, and walk the origins the
shell serves; an origin that does not run as a website yet is looked at again every 30 s for ten minutes, and again whenever the
set of served origins changes. A page of an app opened before its turn takes its place at the front of the queue. The page waits at the
web-request owner for the carry to end, however long it takes: a page that loaded while the carry was still writing would meet half of
it, and an app's own code would write beside it. One deadline covers an origin, `CARRY_DEADLINE_MS` (*provisional*, ten minutes; a
profile with a database of several gigabytes would settle it), however many pages wait; each call to a hidden page has a cap of its own
(`CALL_LIMIT_MS`). Past the deadline the carry stops, clears what it wrote and ends as failed, and the page loads. The carries cost
a start of the verifier host for apps that were not opened; that is the price of a person's first visit not waiting for a carry.

**A failed carry is tried again only while it cannot have been written over.** The record gets `failed` and the reason. At the next
start the carry runs again, up to `MAX_ATTEMPTS`, unless a page of the app was let through after the failure: from then on the
app may have written in the website session, and a carry replaces what that session holds, so the row is final. A record file that
exists and cannot be read stops every carry, for the same reason. The old partition stays on disk either way.

**The hold decides the kind of request itself.** The web-request owner registers one Electron listener per event with the union of
every handler's filter, and offers a handler every request whose URL its `matches` accepts, whatever type its own filter named. A hold
that waited on any request to a served origin made the shell's own reads of that origin wait too, and the verifier answered some
of them itself instead of handing them to the shell. `hold-rule.ts` takes the request type as an argument and the handler returns
every request that is not a main-frame page at once.

**The old data stays where it is.** The partition's folder is never deleted or cleared here. "App data" (`../privacy/clear-data.ts`) clears that
partition and the website session's data for the origin together; a carry that runs after it finds the old partition empty and changes
nothing, and a row already `carried` is never made again, so cleared data does not come back. "Cookies and site data" spares the origin of an
allowed site in the website sessions, so what the carry wrote stays.

**Two hidden pages, one empty document, one nonce each.** A page of the origin is the only way to reach its local storage and databases
without running the app's own code. Both sessions answer `/.well-known/orivon/storage-carry-<secret>` with an empty
document from one place, [`../../loader/electron/app-partitions.ts`](../../loader/electron/app-partitions.ts)'s
`registerAppOrigin`: the old partition through its protocol handler, the shared session through the verifier host's relay
of the very same handler. The secret is chosen at random per run, so the shell's own load is never mistaken for a request of
a page, and the hold lets only that path through. The document repeats a nonce chosen for this one page, and the shell takes a page as
its own when it shows that nonce, sits at the origin and no worker controls it. It does not count scripts: an extension may run a content
script in the page, as in any page of the origin, and it reaches the origin's storage as the app does. The script is installed
under a name made from the nonce and the carry refuses to run in a page that defined that name already. Cookies need no page: the
cookie jar of each session is read and written from the main process.

**Only the app's own cookies are carried.** The old partition also held the cookies of every site the app embedded or called. A cookie
is the app's own when it is host-only on the app's host, or a domain cookie whose domain is the host or a parent of it; the rest is
counted as left out and never set.

**A service worker is bypassed for the hidden page.** An app that registered a worker in its old partition has it answer a
navigation to its origin, and a worker that answers with the app's own page would run the app's code in the page the carry
reads from, which could open, upgrade or delete the very databases being copied. `openCarryPage` attaches the debugger to the
page, enables its Network domain and sets `Network.setBypassServiceWorker` before the document loads, as the developer tools'
"Bypass for network" does (the setting does nothing until the domain is enabled), and then refuses a page that a worker controls
or that does not show its nonce. The check is the second line: only the bypass keeps a page of an app that has a worker from being
refused. The debugger attaches after a first blank load, because a page that has not loaded anything has no target to answer.

**Records travel by structured clone over a port, not as text.** The shell makes a `MessageChannelMain`, hands one end to each hidden page
through the page's preload, and the reading page posts batches of records to the writing page. Structured clone keeps dates, typed
arrays, maps, sets, big integers, cycles, shared objects and keys that cannot be exported (still usable by the writing page and storable
in its database). A Blob or File of the other session cannot be stored in this one, so the writing page rebuilds each from its bytes, type
and name, once however many places hold it. Arguments of a call to a page are passed as `JSON.parse` of a string literal, so a key named `__proto__`
in them is data. Every call returns a JSON string, because `executeJavaScript` converts an object on its own and stops at the first value
it cannot.

**Databases are rebuilt, then filled in batches.** Each database is made in the target at its version with every store
(`keyPath`, `autoIncrement`) and every index (`keyPath`, `unique`, `multiEntry`) after the target's own database of that name is deleted,
then each store is read in batches cut by about 1.5 MB or 200 records and written in one transaction each, continued from the last
key. A record counts as written when its transaction completed; a transaction that aborts counts none of its records and fails the
database, which is then removed. A database with a record that could not be moved (a value larger than 96 MB, or one structured
clone refuses) is `partial`, never `carried`, and the problem names the record.

**What is not carried, and what the log says.** Service workers and Cache Storage (the app registers and fills them again),
the private file system (OPFS), session storage (it never outlives a tab), a value larger than 96 MB, a value structured clone refuses,
and a cookie that has expired or belongs to another site. Each is named in the main process log with a `[carry]` prefix, by kind and
place (a cookie's name and domain, a database, a store and a record's position), never by value; the log reaches `orivon://report`.
