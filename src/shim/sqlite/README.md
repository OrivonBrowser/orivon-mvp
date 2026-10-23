# `src/shim/sqlite/`: Node's `node:sqlite`

**What lives here.** The `sqlite` module target ([`../module-map.ts`](../module-map.ts), a
`prefixOnly` row: only `node:sqlite` resolves here, the bare name is another npm package):
`DatabaseSync` and `StatementSync` over the SQLite WebAssembly build,
[`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm), pinned to one
exact version ([`shim-dependency-review.md`](../../../docs/planning/shim-dependency-review.md) section Later
additions says why this package). Durable: WebAssembly and the synchronous file calls, no Electron API.

| File | Holds |
|---|---|
| `engine.ts`, `ready.ts` | Loading the engine once; the module a bundle imports first |
| `engine-types.ts` | The part of the package's API used, typed by hand |
| `vfs.ts`, `files.ts`, `buffered-file.ts` | The SQLite VFS over the app's files, and the calls it makes |
| `database.ts`, `statement.ts` | `DatabaseSync`, `StatementSync` |
| `errors.ts`, `constants.ts`, `index.ts` | Node's error shapes, `sqlite.constants`, the module |
| `functions.ts` | Scalar SQL functions written in JavaScript: how values cross, and how an exception fails the call |
| `better-sqlite3.ts`, `better-sqlite3-statement.ts`, `better-sqlite3-binding.ts`, `better-sqlite3-errors.ts`, `better-sqlite3-backup.ts` | The `better-sqlite3` API over `DatabaseSync`: `Database`, `Statement`, how arguments bind, `SqliteError`, `backup` |

**What it depends on.** [`../errors.ts`](../errors.ts), [`../node-errors.ts`](../node-errors.ts),
[`../fs/paths.ts`](../fs/paths.ts) and [`../fs/sync-orivon.ts`](../fs/sync-orivon.ts) (the same
confinement and synchronous channel `fs.openSync` uses), [`../virtual-root.ts`](../virtual-root.ts),
[`../polyfills/module-proxy.ts`](../polyfills/module-proxy.ts), and `buffer` (what `serialize` returns). **What it must never import.**
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

## `better-sqlite3`

Code written for the npm package `better-sqlite3` (synchronous, v9 to v12) runs on
[`better-sqlite3.ts`](better-sqlite3.ts), which wraps `DatabaseSync` and `StatementSync`. **A bundle
points the name `better-sqlite3` at that file.** [`../bundler/`](../bundler/README.md)'s plugin does
it for a port; another build aliases `better-sqlite3` to the file itself, and for a CommonJS
`require('better-sqlite3')` exports the default. Everything in section What an app must do applies: the
engine is loaded first, and a database file works only in a forked child or thread of an isolated app.

**Built:** `new Database(filename, options)` and `Database(filename, options)` (options `readonly`,
`fileMustExist`, `timeout`, `verbose`, `nativeBinding`, the last ignored); `name`, `open`,
`inTransaction`, `readonly`, `memory`; `prepare`, `exec` (returns the database), `pragma` (rows, or
`{ simple: true }`; a pragma that sets a value works), `transaction` (`BEGIN` and `COMMIT`, `ROLLBACK`
on a throw, a savepoint when nested, the `.deferred`, `.immediate` and `.exclusive` variants),
`close`, `defaultSafeIntegers`, `unsafeMode` (a no-op), `function`, `backup`, `serialize` and a `Buffer` as the first argument (below). `Statement`: `run`, `get`, `all`, `iterate`,
`pluck`, `raw`, `expand`, `columns`, `bind`, `safeIntegers`, `source`, `reader`, `readonly`, `database`.
`Database.SqliteError` is thrown for an engine failure, with `code` the extended result code's name
(`SQLITE_CONSTRAINT_UNIQUE`).

`db.function(name, [options], fn)` registers a scalar function with `better-sqlite3`'s options `deterministic`,
`varargs`, `directOnly` and `safeIntegers`, and its checks and messages. An INTEGER reaches `fn` as a number (a
bigint under `safeIntegers`, or `defaultSafeIntegers` when the option is absent, read at each call), REAL as a
number, TEXT as a string, BLOB as a `Uint8Array`, NULL as `null`. `fn` returns a number (stored as REAL), a bigint
(INTEGER), a string, a `Uint8Array` (BLOB), `null` or `undefined` (NULL); anything else is a `TypeError`. An
exception in `fn` fails the statement that called it, and the call that ran the statement (`run`, `get`, `all`,
`iterate`, `exec`) throws that exception itself. `db.backup(destination, [options])` returns a Promise that
resolves with `{ totalPages, remainingPages: 0 }` (`totalPages` is the page count of the database copied) once a copy of the committed database is in `destination`,
a file of the app's files whose directory exists; the option `attached` names the database to copy and `progress`
is called once, when the copy is made and before it replaces the destination.

`new Database(buffer, [options])` takes the bytes of a database file (a `Buffer`, or any `Uint8Array`) and opens a
private database in the engine's memory that holds a copy of them: readable and writable, growing as needed, never
written to a file, and unchanged in the buffer given. `db.name` is `':memory:'` and `db.memory` is `true`. With the
option `readonly` the database refuses every write with `SQLITE_READONLY`. Bytes that are not a database open without
complaint, and the first statement fails with `file is not a database` (`SQLITE_NOTADB`), as it does for a file; an
empty buffer is an empty database. The copy is freed when the database closes. `db.serialize([options])` returns the
bytes of the database as its file would hold them, in a `Buffer`, and the
option `attached` names an attached database; the two are inverses, and a database from a path serializes to the bytes
of its file. A database from bytes takes `function` and `backup` like any other, so `await db.backup(path)` writes it to
a file of the app's files.

**Refused by name, `'not-built'`:** `aggregate`, `table`, `loadExtension`.

**Different from `better-sqlite3`:** a plain `Uint8Array` opens as a database, where the package accepts a `Buffer` only; `serialize` of a database that is not there is a `SqliteError` (`unknown database <name>`); `serialize` inside a function the database is running is `This database connection is busy executing a query`; `backup` cannot run inside a transaction or while a statement is half-read, and copies in one step, so `progress` is called once, before the copy replaces the destination; a function that closes the database or runs the statement it is in the middle of gets `This database connection is busy executing a query`; a function receives a BLOB as a
`Uint8Array`, as a row does; `verbose` receives each statement's SQL with its parameters
filled in, after the statement ran; `prepare` does not refuse a string of several statements (the
first is prepared); a missing directory is the engine's `SQLITE_CANTOPEN`, not a `TypeError`; a
statement used while an iterator is open is not refused; the limits of section What works, and where apply.

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

`function(name, [options], fn)` takes Node's options `useBigIntArguments`, `varargs`, `deterministic` and
`directOnly`, and Node's values and errors, compared against Node's own `node:sqlite` in
[`tests/functions.test.ts`](tests/functions.test.ts).

**Refused by name, `'not-built'`:** `aggregate`, `createSession`, `applyChangeset`,
`createTagStore`, `loadExtension`, `enableLoadExtension`, the `allowExtension` option, the module's `backup`,
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

**`better-sqlite3` is reached by a bundler's alias, and not by a row of [`module-map.ts`](../module-map.ts).**
That table is the Node builtins: `module.builtinModules`, `isBuiltin`, a run-time `require` of a builtin and
the frozen list of Node's exports are all read from it, and a row for an npm package would make each of them
call that package a builtin. The bundler plugin names the package in a table of its own
(`PACKAGE_REPLACEMENTS` in [`../bundler/esbuild-plugin.ts`](../bundler/esbuild-plugin.ts)), so a port's
`import Database from 'better-sqlite3'` and `require('better-sqlite3')` both reach the adapter, and a
build of another tool writes one alias.

**The adapter shapes every row and binds every value itself**, because `better-sqlite3` and `node:sqlite` differ
where an app would notice. The inner statement always reads integers as bigints and rows as arrays; the adapter
returns a number for an integer beyond 2^53 with the precision loss `better-sqlite3` has, and a bigint only
under `safeIntegers`. A JavaScript integer that fits 32 bits binds as INTEGER and every other number as REAL
(`node:sqlite` binds every number as REAL, which changes `typeof(?)` and a `LIMIT ?` over an untyped value), a
boolean is a `TypeError`, and `undefined` is NULL. A parameter is found by its declared name, read through
`statementTraits` in [`statement.ts`](statement.ts): a bare `?` takes the next positional value, `?NNN` the
value at that number, and `@name`, `:name` and `$name` the object's bare key, with `better-sqlite3`'s
`RangeError` for too few, too many or a missing one. A `PRAGMA` statement counts as returning data even when
it has no columns, so `pragma('user_version = 3')` returns `[]` as it does there.

**The package's own `sqlite3_bind_text` wrapper is not used**: in this release it throws for every string (it
reads an undefined variable), so [`statement.ts`](statement.ts) allocates and binds through the engine's raw exports.
The same file binds a JavaScript number as REAL and a `bigint` as INTEGER, as Node does.

**A statement and a database are closed when they are collected**, through a `FinalizationRegistry` over state held
apart from the object, so an app that prepares a statement per call (a chat store inserts one per message)
does not leak engine memory. Closing a database finalizes its statements, and one used afterwards says so with
Node's `ERR_INVALID_STATE`.

**A function is registered through the package's `sqlite3_create_function_v2`, with no change to the engine.** The
package's WebAssembly already exports it, the `sqlite3_value_*` readers and the `sqlite3_result_*` writers, and
installs a JavaScript callback in the module's function table, removing it when SQLite destroys the function.
[`functions.ts`](functions.ts) calls the raw exports, as `statement.ts` does for binding, so a value's mapping is
ours and not the package's. A callback must never throw into WebAssembly, so it catches the exception, keeps it on
the connection and fails the SQL call with a generic error; the statement call that sees that failure
(`failureOf` in [`statement.ts`](statement.ts)) throws the kept exception instead of the engine's error, which is
what Node and `better-sqlite3` do. Node and `better-sqlite3` differ in what they do with a result SQLite cannot
store (a SQL error, a `TypeError`) and in how an INTEGER argument arrives, so the two entry points pass `functions.ts`
their own rule for each. An empty buffer is an empty BLOB in both: Node stores NULL or an empty BLOB for it, depending on
where the engine put the buffer.

**`backup` writes a copy beside the destination and renames it over, because the engine has no online backup API.**
The package's build exports none of `sqlite3_backup_init`, `_step` and `_finish`. For a database in a file the copy is
`VACUUM INTO`, which gives the guarantee a database the app holds open needs: a consistent snapshot of what was
committed when it ran, written through the VFS of the open database, so a destination outside the app's files is
refused as any other path is. A database in memory, which that VFS does not serve, is written from the engine's export
of it. The copy goes to a file beside `destination` and is renamed over it, so a failure leaves `destination` as it
was and a reader never sees half a file. It differs from SQLite's backup in three ways: it does not start inside a
transaction, it runs to the end in one step with no chance for other work between pages, and a file's copy is compacted
(free pages are not carried over) while keeping the page size, `user_version` and `application_id`. It refuses a
destination that is any database the connection has open (the main one and every attached one), or the journal of one.

**A database from bytes is `sqlite3_deserialize` into the `main` schema of an in-memory connection, and `serialize` is
the export that `backup` already used for a database in memory.** The bytes are copied into memory the engine allocates
with `sqlite3_malloc` and the engine owns that copy (`SQLITE_DESERIALIZE_FREEONCLOSE`: it frees it when the connection
closes, and also when it refuses it), so nothing outlives the database and the caller's buffer is neither kept nor
written through. A writable database is `RESIZEABLE`, so it can grow past the bytes it was given; a `readonly` one is
`READONLY` instead. The engine's in-memory storage is the only place the database lives: opening from bytes calls no
file function of the app's files, which [`tests/better-sqlite3-image.test.ts`](tests/better-sqlite3-image.test.ts)
checks by recording every call. SQLite does not validate the bytes when it takes them, which is why a non-database
fails at the first statement. The package's export carries the 64-bit sizes as numbers, so an image beyond 2^53 bytes
cannot be named; the engine's own limit on a database in memory (1 GiB) is reached first.
