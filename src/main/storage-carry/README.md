# `src/main/storage-carry/`: what an app stored before it moved sessions

**What lives here.** The one-time carry of an allowed app's browser storage from the partition it used to run in
(`persist:app-<hash>`, [`../../broker/grants/origin-hash.ts`](../../broker/grants/origin-hash.ts)'s `partitionFor`) into the
session websites run in, for an app that now runs there ([`../shell/app-session.ts`](../shell/app-session.ts)'s
`runsAsWebsite`, ADR-0108).

| File | Job |
|---|---|
| `install-storage-carry.ts` | The wiring: the subsystem, the hold on the app's first main-frame page at the web-request owner, the record in the profile |
| `carry-gate.ts` | Pure: starts the carry at the first page of an origin, holds every page of it until the carry ends or a bound passes |
| `carry-runner.ts` | One origin's carry over two `CarrySide`s (a cookie jar and a hidden page each): cookies, then local storage, then databases; never throws |
| `page-code.ts` | The script that runs in the two hidden pages: the value encoding and the IndexedDB, local storage and cookie-free reads and writes, as one string of plain JavaScript |
| `carry-pages.ts` | The Electron half: a hidden view no window holds, at the shell's empty document ([`../../loader/electron/carry-page.ts`](../../loader/electron/carry-page.ts)), and a cookie jar over a session |
| `cookies.ts` | Pure: a cookie of the old partition as a cookie to set, and whether the target holds it |
| `marker.ts` | Pure, apart from reading and writing the file: which origins were carried, tried and failed, with the report |
| `old-data.ts` | What the old partition's folder shows was stored, read from disk without opening the session |
| `report.ts` | Pure: the counts and the named problems one carry produced, and the line that sums them |

**What it depends on.** `electron` (`install-storage-carry.ts`, `carry-pages.ts`), [`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts)
(the hold), [`../shell/app-session.ts`](../shell/app-session.ts) (whether the app runs as a website) and
[`../shell/lock-navigation.ts`](../shell/lock-navigation.ts), [`../../loader/electron/`](../../loader/electron/) (the empty
document and which origins the shell serves), [`../../broker/grants/origin-hash.ts`](../../broker/grants/origin-hash.ts) and
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts).

**What it must never import.** The broker's grants, the renderer, or the app loader's install path: it moves bytes of storage
and decides nothing about what an app may do.

**Owner stream.** `install`.

**Electron dependence.** Tied to Electron in `install-storage-carry.ts` and `carry-pages.ts`. The gate, the runner, the encoding
and the planning are pure and run in unit tests against `fake-indexeddb`.

## Design notes

**The carry starts at the first main-frame page of the origin, not at launch.** An app nobody opens costs nothing, and the
verifier host the carry needs (the write goes through the relay, below) is the one the page needs. The page waits at the
web-request owner for the carry to end, up to `CARRY_HOLD_MS`; the carry goes on after that, and because it replaces nothing
(next note) a page that has already made its own cookie, item or database loses nothing and the carry reports what it
left alone. The alternative, carrying every moved origin at start, would wake the verifier host for apps that stay closed.

**Nothing in the website session is replaced.** A cookie, a local storage item or a database that the target holds is kept,
so a carry that is cut short, or that runs after the app has loaded once, is safe to run again. That is why a carry whose
pages could not be reached (`failed` in the record) is tried again at the next start, up to `MAX_ATTEMPTS`, while one that
ran to the end is never repeated. A database is made whole or removed: a failure mid-way drops the half-made copy, since
an existing database is skipped on the next try.

**The old data stays where it is.** The partition's folder is never deleted or cleared here.

**Two hidden pages, one empty document.** A page of the origin is the only way to reach its local storage and databases
without running the app's own code. Both sessions answer `/.well-known/orivon/storage-carry-<secret>` with an empty
document from one place, [`../../loader/electron/app-partitions.ts`](../../loader/electron/app-partitions.ts)'s
`registerAppOrigin`: the old partition through its protocol handler, the shared session through the verifier host's relay
of the very same handler. The secret is chosen at random per run, so the shell's own load is never mistaken for a request of
a page, and the hold lets only that path through. Cookies need no page: the cookie jar of each session is read and written
from the main process.

**A service worker is bypassed for the hidden page.** An app that registered a worker in its old partition has it answer a
navigation to its origin, and a worker that answers with the app's own page would run the app's code in the page the carry
reads from, which could open, upgrade or delete the very databases being copied. `openCarryPage` attaches the debugger to the
page, enables its Network domain and sets `Network.setBypassServiceWorker` before the document loads, as the developer tools'
"Bypass for network" does (the setting does nothing until the domain is enabled), and then refuses a page that a worker controls
or that holds a script. The check is the second line: only the bypass keeps a page of an app that has a worker from being
refused. The debugger attaches after a first blank load, because a page that has not loaded anything has no target to answer.

**Every call returns text.** `executeJavaScript` converts what it returns, and stops at the first value it cannot (a Blob
inside a Map). The script returns JSON strings, and a value that JSON cannot say is tagged (`$t`): dates, binary, Blobs
and Files (as bytes, type and name), maps, sets, regular expressions, errors, big integers, NaN, the infinities, negative
zero and extractable keys. A plain object with a key of its own named `$t` is wrapped, so it is never taken for a tagged value.

**Databases are rebuilt, then filled in batches.** Each database is made in the target at its version with every store
(`keyPath`, `autoIncrement`) and every index (`keyPath`, `unique`, `multiEntry`), then each store is read in batches cut by
about 1.5 MB or 200 records, written in one transaction each, and continued from the last key. A transaction cannot wait on
a Blob's bytes, so a batch is read first and encoded after.

**What is not carried, and what the log says.** Service workers and Cache Storage (the app registers and fills them again),
the private file system (OPFS), session storage (it never outlives a tab), a record that holds a value a structured clone
cannot be rebuilt from (a key that is not extractable, a value that contains itself), a value larger than 96 MB, and a
cookie that has expired. Each is named in the main process log with a `[carry]` prefix, by kind and place (a cookie's name and
domain, a database, a store and a record's position), never by value.
