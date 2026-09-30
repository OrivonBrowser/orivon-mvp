# `src/shim/sqlite/`: Node's `node:sqlite`

**What lives here.** The `sqlite` module target ([`../module-map.ts`](../module-map.ts), a
`prefixOnly` row: only `node:sqlite` resolves here, the bare name is another npm package):
`DatabaseSync` and `StatementSync` over the SQLite WebAssembly build,
[`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm), pinned to one
exact version ([`shim-dependency-review.md`](../../../docs/planning/shim-dependency-review.md) §Later
additions says why this package). Durable: WebAssembly and the synchronous file calls, no Electron API.

| File | Holds |
|---|---|
| `engine.ts`, `ready.ts` | Loading the engine once; the module a bundle imports first |
| `engine-types.ts` | The part of the package's API used, typed by hand |
| `vfs.ts`, `files.ts`, `buffered-file.ts` | The SQLite VFS over the app's files, and the calls it makes |
| `database.ts`, `statement.ts` | `DatabaseSync`, `StatementSync` |
| `errors.ts`, `constants.ts`, `index.ts` | Node's error shapes, `sqlite.constants`, the module |

**What it depends on.** [`../errors.ts`](../errors.ts), [`../node-errors.ts`](../node-errors.ts),
[`../fs/paths.ts`](../fs/paths.ts) and [`../fs/sync-orivon.ts`](../fs/sync-orivon.ts) (the same
confinement and synchronous channel `fs.openSync` uses), [`../virtual-root.ts`](../virtual-root.ts),
[`../polyfills/module-proxy.ts`](../polyfills/module-proxy.ts). **What it must never import.**
`electron`, or [`../../broker/`](../../broker/).

**Owner stream.** `shim`.

## What an app must do

- **Import `sqlite/ready.ts` before the module that opens a database.** The engine starts
  asynchronously, and `new DatabaseSync()` cannot wait. `ready.ts` is one top-level `await`, so the
  bundle is an ES module (a fork's bundle is imported as one) and the entry imports it first:
  `import '<shim>/sqlite/ready.js'`, then the code that requires `node:sqlite`. The module's own
  `require('node:sqlite')` may then be CommonJS: `index.ts` never imports `ready.ts`, since a bundler
  refuses a `require()` of anything that contains a top-level `await`. Before the engine has loaded, `new
  DatabaseSync()` refuses by name and says this.
- **Ship `sqlite3.wasm` beside the bundle** (it is `@sqlite.org/sqlite-wasm/sqlite3.wasm`), or call
  `loadSqliteEngine({ wasmBinary })` from a ready module of the app's own.
- **Bundle the package with the `browser` or `import` condition.** Its `node` condition names a build
  that only Node can run; the unit suite aliases the browser build for the same reason.

## What works, and where

**`:memory:` (and an empty name) work everywhere**, on the page too, and make no file call: the engine's
own in-memory storage. **A database file works only in a forked child or `worker_threads.Worker` of a
cross-origin isolated app**, over the synchronous file calls ([`ADR-0016`](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)'s
amendment); anywhere else `new DatabaseSync('<path>')` throws a named `OrivonShimError` saying so. A path is
one of the app's files, relative or under `/orivon/app`. As in Node, the directory must exist.

**Built:** `DatabaseSync` (`open`, `close`, `exec`, `prepare`, `isOpen`, `isTransaction`, `location`,
`enableDefensive`, `Symbol.dispose`; options `open`, `readOnly`, `enableForeignKeyConstraints`,
`enableDoubleQuotedStringLiterals`, `timeout`, `readBigInts`, `returnArrays`, `allowBareNamedParameters`,
`allowUnknownNamedParameters`, `defensive`), `StatementSync` (`run`, `get`, `all`, `iterate`, `columns`,
`sourceSQL`, `expandedSQL`, and the four setters), `constants`. Values, errors, named and anonymous
parameters, and integer range checks are Node's, compared against Node's own `node:sqlite` in
[`tests/statements.test.ts`](tests/statements.test.ts).

**Refused by name, `'not-built'`:** `function`, `aggregate`, `createSession`, `applyChangeset`,
`createTagStore`, `loadExtension`, `enableLoadExtension`, the `allowExtension` option, `backup`,
`Session`.

**Different from Node:** no locking and no WAL (`pragma journal_mode = wal` stays `delete`), so one
connection uses a file at a time; `location()` returns the path as given, not resolved against a
directory; a name is never a `file:` URI; the engine's defaults are its own (8 KiB pages, a 16 MiB page cache, and
temporary tables and sorts in memory unless `pragma temp_store = file`).

## Design notes

**The engine cannot be brought up synchronously; the ready module is the route that works.** The
package's start-up is an `async` function: its WebAssembly instantiation, its bootstrap and its
post-initialisation all sit behind `await`, so even an `instantiateWasm` hook that instantiates with
`new WebAssembly.Instance` still returns a Promise before the API exists
([`tests/engine-surface.test.ts`](tests/engine-surface.test.ts) measures this and fails if a release
changes it, at which point `ready.ts` can go). A top-level `await` in a module the bundle imports first
finishes the start-up before app code runs. An explicit preload step in the fork runtime was not needed.

**The VFS is `unix-none`'s locking with a rollback journal.** `xLock` and `xUnlock` succeed and
`xCheckReservedLock` answers "no": nothing else writes a file this connection uses. The journal is a real file
beside the database, so a crash leaves a hot journal that the next open plays back; the tests replay a crash at
every file call of a large commit and check the result is the old state or the new one. A file SQLite may create is opened `wx+` and
falls back to `r+`; a temporary file (a `VACUUM` copy or a sort that spills, under `pragma temp_store = file`) is a file in `os.tmpdir()`, removed on
close.

**Three things cut round trips**, each safe only because one connection uses a file:
[`buffered-file.ts`](buffered-file.ts) merges writes that continue where the last ended (SQLite writes a journal
record as three small writes) and flushes before any read, size, truncate, sync or close, and where a transaction
ends (SQLite unlocks the file, or announces the commit's second phase when it keeps its lock), so a commit is in
the file when it returns even with `pragma synchronous = off`. Its bytes stay pending until a write has
succeeded, and a failed flush is reported as a write error. It asks a file's size once;
and `vfs.ts` remembers what `xAccess` said about a path (a journal and a WAL are asked after before every
read transaction) while some file is open, forgetting it when the last one closes.

**Cost, in synchronous file calls** (each is a round trip to the page; [`tests/cost.test.ts`](tests/cost.test.ts)
holds the numbers):

| Statement | Calls |
|---|---|
| One committed `INSERT` (autocommit, default settings) | 13: 2 reads, open journal, 5 writes, 3 syncs, close, remove |
| The same, `pragma locking_mode = exclusive` (steady state) | 10: 1 read, 5 writes, 4 syncs |
| A `SELECT` on a warm cache | 1 read (SQLite's check that the file did not change) |
| Opening an existing database | 4 |

A transaction of many statements pays the journal once, so batch inserts in `BEGIN` ... `COMMIT`.
`locking_mode = exclusive` skips the change check and is safe only when no second connection ever opens the file.

**The package's own `sqlite3_bind_text` wrapper is not used**: in this release it throws for every string (it
reads an undefined variable), so [`statement.ts`](statement.ts) allocates and binds through the engine's raw exports.
The same file binds a JavaScript number as REAL and a `bigint` as INTEGER, as Node does.

**A statement and a database are closed when they are collected**, through a `FinalizationRegistry` over state held
apart from the object, so an app that prepares a statement per call (a chat store inserts one per message)
does not leak engine memory. Closing a database finalizes its statements, and one used afterwards says so with
Node's `ERR_INVALID_STATE`.
