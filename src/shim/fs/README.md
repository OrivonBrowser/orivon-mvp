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

**Every `fs` `*Sync` export except `readFileSync`/`existsSync` works only in a Worker of a
cross-origin isolated app** ([`ADR-0016`](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s
amendment), over the Worker's synchronous twin (`../worker/README.md`'s own note) --
[`core-sync.ts`](core-sync.ts) is the synchronous twin of [`core.ts`](core.ts)'s `do*()` functions,
sharing confinement ([`paths.ts`](paths.ts)), root special-casing ([`root.ts`](root.ts)) and stats
conversion ([`stats.ts`](stats.ts)) with them; only the "await or not" itself cannot be shared, so
each function is written twice, once per execution model. `openSync`/`readSync`/`writeSync`/
`fstatSync`/`closeSync` keep their own fd table, separate from `fs.open`'s
([`handle.ts`](handle.ts)'s `openByFdSync` doc comment says why). `realpathSync` stays a permanent
refusal everywhere: there is no async `realpath` in this shim for it to share a core with.
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
