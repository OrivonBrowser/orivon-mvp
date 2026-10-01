# `src/shim/fs/`: Node's `fs` over `orivon.fs`

**What lives here.** Callback `fs`, `fs.promises`, `FileHandle` and the `fs` streams, all over
one shared async core (`core.ts`) so the two surfaces cannot drift. `handle.ts` rebuilds Node's
implicit file position, which `orivon.fs` deliberately lacks.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../encoding.ts`](../encoding.ts), [`../unimplemented.ts`](../unimplemented.ts),
[`../virtual-root.ts`](../virtual-root.ts) (`paths.ts`'s confinement), and
[`../worker/sync-channel.ts`](../worker/sync-channel.ts)'s `SYNCHRONOUS` symbol
(`sync-orivon.ts`, the one thing every `*Sync` export needs from `worker/` -- the reverse never
happens, `worker/` does not import `fs/`).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**A synchronous call the broker's per-origin limiter refuses is asked again** (`sync-orivon.ts`'s
`guardedSync`): it backs off from 25 ms up to 200 ms for at most 40 attempts, then throws the error. The
limiter refuses before anything runs, so asking again cannot repeat an effect, and a synchronous caller
cannot wait and ask again itself -- a program that starts with a burst of file calls would otherwise fail
the first call past the bucket. `existsSync`'s own probe asks again the same way, so a refused stat is never read
as a missing file.

**Every `fs` `*Sync` export, including `realpathSync`, works only in a Worker of a
cross-origin isolated app** ([`ADR-0016`](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s
amendment), except `readFileSync`/`existsSync`, which work everywhere -- over the Worker's
synchronous twin (`../worker/README.md`'s own note) -- [`core-sync.ts`](core-sync.ts) is the
synchronous twin of [`core.ts`](core.ts)'s `do*()` functions, sharing confinement
([`paths.ts`](paths.ts)), root special-casing ([`root.ts`](root.ts)) and stats conversion
([`stats.ts`](stats.ts)) with them; only the "await or not" itself cannot be shared, so each
function is written twice, once per execution model. `realpathSync`/`realpath`/`fs.promises.realpath`
answer entirely locally, over a `stat` to confirm existence: `orivon.fs` never reports a symlink as
its own kind (`core-sync.ts`'s `doRealpathSync` doc comment), so the real path of anything this
shim can stat is just its own normalised absolute path under the virtual root.
`openSync`/`readSync`/`writeSync`/`fstatSync`/`closeSync` keep their own fd table, separate from
`fs.open`'s: not because the broker could not address the same handle either way (it can,
`worker/orivon-server.ts` keeps one generic handle table regardless of which side asked for it),
but because the two client-side wrappers this shim builds over it never expose a synchronous and
an asynchronous face of the SAME handle (`handle.ts`'s `openByFdSync` doc comment has the detail).
An fd real only in the other family fails `EBADF`, naming which family actually holds it, rather
than reading as though it had never been opened at all.
Elsewhere -- the page, or a Worker with no `SharedArrayBuffer` -- every one of these calls throws
the same named refusal it always has ([`unsupported.ts`](unsupported.ts)).

**`fs.createReadStream`/`fs.createWriteStream` run over the local cursor, not the broker's
`readable()`/`writable()`.** Provisional, AI recommendation: those are not page-reachable (A184),
and `@seald-io/nedb` calls both on every load and compaction (`streams.ts`). The cost is one
64 KiB round trip per chunk instead of one WHATWG transfer. **Open:** whether this is permanent;
once A184 makes the broker streams reachable, `streams.ts` can move onto them with no app-facing
change.

**`fs.access`'s mode.** Provisional, AI recommendation: every mode checks existence only, since
`orivon.fs` has no permission model (`core.ts`'s `doAccess`). **Open:** what a dependency asking
`W_OK` to mean something narrower should get; the `orivon.fs` contract gives nothing to answer with.

**The app's root is answered locally.** Provisional, AI recommendation: the broker refuses the root
itself (`deny('is-root')`) by design, yet dependencies ask for it (`nedb` creates and fsyncs `'.'`),
so [`root.ts`](root.ts) answers every call on it with Node's errors, checked against real Node on
Linux. `readdir` of the root is the one call it cannot answer and fails `EACCES`; closing that is
a broker policy change (a read-only listing of the root), not a shim one. A directory fsync of the
root is a no-op: a rename is only as durable as the broker's own `rename()` makes it.

**`fs.Stats` carries Node's whole field set**, because libraries read it whole (`etag` checks
for `ctime` and `ino`, and `express.static` throws without them). `orivon.fs` reports size, kind
and mtime, so every other field is a fixed answer: `ino` is a 53-bit FNV-style hash of the
confined path (stable for one path, different across paths); `dev` 1, `nlink` 1, `uid` and `gid`
0, `rdev` 0; `mode` is a regular file `0o600` or a directory `0o700` (the app's files are private to the app, and a server that warns about a world-readable file finds none); `blksize` 4096 and
`blocks` counts 512-byte units of whole 4096-byte blocks; `atime`, `ctime` and `birthtime`
follow `mtime`. The `is*` device predicates are false.

**The `chmod` family succeeds after an existence check** ([`permissions.ts`](permissions.ts)):
`chmod`, `chmodSync`, `lchmod`, `lchmodSync`, `fchmod`, `fchmodSync`, `fs.promises.chmod`,
`fs.promises.lchmod` and `FileHandle#chmod`. The mode is validated as Node does and then not
stored, because the confined fs has no mode to keep (`stat` reports the fixed one above); a
missing path fails `ENOENT` and an unknown descriptor `EBADF`. `chmodSync` checks with
`existsSync`, so it works on a page as well as in a Worker, and reads a path it may not open as
missing. `chown` and its variants still refuse as *not-applicable*: no uid or gid exists to set.

**`fs.watch` hears only the writes made through this shim** ([`watch.ts`](watch.ts),
[`notices.ts`](notices.ts)). `orivon.fs` has no change feed, so every mutating call here
(`core.ts`, `core-sync.ts`, `handle.ts`, and the streams over it) announces the confined path
it changed: directly to the watchers of its own context, and on a per-app `BroadcastChannel`
to every other context of the same app (a channel never crosses an origin). A watcher filters by
path: a watched file sees its own name; a watched directory sees its direct children by name, or
every descendant by relative path with `recursive`. Created, removed, renamed and made things are
`'rename'`; a content write is `'change'`. **What it does not see:** a write made outside the
shim, a write by another app, and a change made before the watcher existed. `fs.watch` on a
missing path throws `ENOENT`, checked with `existsSync`'s semantics (a path the app may not open
reads as missing).

A write that creates its file reads `'rename'` then `'change'`, as inotify's create and modify do;
telling it from a rewrite costs a `stat`, which a writer pays only while some context is known to
be watching. Contexts learn that from a count each posts on the same channel and repeats every ten
seconds while it holds a watcher; a count not repeated for thirty seconds lapses, so a context that died
without saying so is forgotten. A context's first announcement, made before it has heard from the
others, reads `'change'` alone. Once a context has had one beat's time to hear from every watcher and
none is known, it stops posting its notices; a watcher that subscribes later announces itself and the
posting resumes. A persistent
watcher (the default) keeps a forked child alive until `close()` or `unref()`, as it keeps a Node
process; `persistent: false` does not. `fs.promises.watch` is an async iterator over the same
events, and `signal` closes either form. `watchFile` and `unwatchFile` refuse by name: they poll,
which would see writes from outside the shim too, and no consumer has asked. Provisional: whether
`orivon.fs` should carry a real change feed, which would settle the outside-the-shim gap.
