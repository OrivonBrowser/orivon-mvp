# `src/shim/fs/`: Node's `fs` over `orivon.fs`

**What lives here.** `fs.ts` (the module: callback-style `fs`), `core.ts` (the shared async core
both `fs.ts` and `promises.ts` build on, so the two surfaces cannot drift), `promises.ts`
(`fs.promises`), `handle.ts` (`fs.open`/`fs.promises.open`, a local cursor reconstructing Node's
implicit `position: null` on top of `orivon.fs.open`'s deliberately explicit-position-only
`FileHandle`), `paths.ts` (virtual-root confinement -- the app-relative Node path becomes the
`orivon.fs` call), `root.ts` (answering every call on the app's own root locally, since
`orivon.fs` refuses it), `stats.ts`, `streams.ts` (`fs.createReadStream`/`createWriteStream`),
`constants.ts` and `unsupported.ts`.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../encoding.ts`](../encoding.ts), [`../unimplemented.ts`](../unimplemented.ts) and
[`../virtual-root.ts`](../virtual-root.ts) (`paths.ts`'s confinement).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/) -- see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**`fs.createReadStream`/`fs.createWriteStream` run over the local per-open cursor, not A184's
broker `readable()`/`writable()`.** **AI recommendation, not owner-reviewed.** `@seald-io/nedb`'s
`lib/storage.js` captures both at module load and its persistence layer calls them on every
database load and every compaction, so they could not stay refused the way `FileHandle`'s own
instance `createReadStream`/`createWriteStream` still are (A184). `streams.ts` builds them as
real `stream.Readable`/`Writable` subclasses over `handle.ts`'s positional `read`/`write`, which
are page-reachable today: one 64 KiB chunk per round trip. The cost is N round trips instead of
one continuous WHATWG transfer, and a fixed chunk size instead of the broker's own credit window.
For nedb's small line-oriented files that should not matter. Once A184 makes
`readable()`/`writable()` reachable from the page, this file can be rewritten over them with no
app-facing change. **Still open:** whether this is the permanent shape or a placeholder. Both
streams destroy themselves at end/finish and after a failed write, which releases the handle and
emits `'close'`, as Node's `autoDestroy` does: readable-stream 3 defaults `autoDestroy` off, and
turning it on for a Writable there swallows the failed write's `'error'` event.

**`fs.access`'s `mode` is not distinguished: every mode checks existence only.** **AI
recommendation, not owner-reviewed.** Node fails `access(path, mode)` when the process lacks the
permission `mode` names. `orivon.fs` has no POSIX permission model at all (the same reason
`chmod`/`chown` refuse as `'not-applicable'`), so `core.ts`'s `doAccess` answers `F_OK`, `R_OK`,
`W_OK` and `X_OK` alike with one `stat()`. A confined or grant-denied path already fails that the
way a real permission check would. nedb, the only caller today, passes `F_OK` alone. **Still
open:** what a future dependency asking `W_OK` to mean something narrower should get, which
`orivon.fs`'s contract currently gives this file nothing to answer with.

**A path resolving to the app's own ROOT is answered locally, never sent to orivon.fs.** **AI
recommendation, not owner-reviewed.** The broker's own confinement policy
(`../../broker/policy/paths.ts`) refuses ANY requested path that resolves to the root itself
(`deny('is-root')`), unconditionally, regardless of grant -- by design, not a gap: `orivon.fs`
confines every call to somewhere STRICTLY INSIDE the root. But the root always exists (the broker
creates it), exactly the way a process's cwd always exists in real Node, and a ported dependency
routinely asks for it: `@seald-io/nedb`'s `lib/storage.js` computes `path.dirname('settings.db')`
(`'.'`) for its parent-directory `mkdir`, and fsyncs that same `'.'` after every crash-safe
rename. [`root.ts`](root.ts) answers every call on the root in the shim: `stat`/`access` succeed
with a directory (size and mtime 0: the broker has no metadata to give for the one path it
refuses); `mkdir(root, {recursive:true})` is a no-op success and fails `EEXIST` without it;
`readFile`/`writeFile`/`appendFile` fail `EISDIR`; `rm`/`unlink`/`rename` fail `EACCES`, since
nothing may remove or move the app's files. `fs.open(root, 'r')` returns a local directory handle
whose `sync()`/`datasync()`/`close()` succeed and whose `read()`/`write()`/`truncate()` fail
`EISDIR`/`EBADF`/`EINVAL` respectively -- checked against real Node on Linux, not assumed
(`stat()` on that handle SUCCEEDS). Any other open flag on the root fails `EISDIR`, matching
Node's own refusal to open a directory for writing.

**`readdir` of the root is the one root call the shim cannot answer.** Listing it needs the
broker, which refuses the root itself, and the shim has no listing of its own. It fails `EACCES`
with a message naming the gap rather than returning a fabricated empty list. Closing it is a
broker policy change (a read-only listing of the root), not a shim one. A folder inside the root
lists normally.

**A directory fsync of the root is therefore a NO-OP, not a real fsync of anything.**
`orivon.fs` exposes no handle on the root at all, so there is nothing this shim can actually ask
the OS to flush on the app's behalf -- a rename's directory entry is only as durable as the
broker's own `rename()` call already makes it, no more. nedb's own crash-safety model (documented
in `persistence.js`) already tolerates a platform where opening a directory for fsync fails
outright (its own EISDIR handling), so this no-op costs it nothing further than that platform
already costs it; nothing here promises a stronger durability guarantee than the broker's rename
itself provides.
