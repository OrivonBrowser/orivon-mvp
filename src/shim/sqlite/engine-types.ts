// The part of `@sqlite.org/sqlite-wasm`'s API this module leans on, typed by
// hand: the package's own declarations are looser than what the engine does
// (a pointer argument typed as a result code, a 64-bit offset typed as a
// number). tests/engine-surface.test.ts checks each name here against the
// real engine, so a package upgrade that drops one fails there.

type Pointer = number
type Method = (...args: never[]) => number

/** SQLite's own function of the C API, as the package's `capi` exposes it. */
export interface SqliteCapi {
  readonly SQLITE_CANTOPEN: number
  readonly SQLITE_ERROR: number
  readonly SQLITE_IOERR: number
  readonly SQLITE_IOERR_ACCESS: number
  readonly SQLITE_IOERR_CLOSE: number
  readonly SQLITE_IOERR_DELETE: number
  readonly SQLITE_IOERR_DELETE_NOENT: number
  readonly SQLITE_IOERR_FSTAT: number
  readonly SQLITE_IOERR_FSYNC: number
  readonly SQLITE_IOERR_READ: number
  readonly SQLITE_IOERR_SHORT_READ: number
  readonly SQLITE_IOERR_TRUNCATE: number
  readonly SQLITE_IOERR_WRITE: number
  readonly SQLITE_NOTFOUND: number
  readonly SQLITE_OPEN_CREATE: number
  readonly SQLITE_OPEN_DELETEONCLOSE: number
  readonly SQLITE_OPEN_EXCLUSIVE: number
  readonly SQLITE_OPEN_READWRITE: number
  readonly SQLITE_WASM_DEALLOC: Pointer
  readonly sqlite3_io_methods: new () => SqliteStruct
  readonly sqlite3_vfs: new (pointer?: Pointer) => SqliteStruct
  readonly sqlite3_file: (new (pointer: Pointer) => SqliteStruct & { $pMethods: Pointer }) & { readonly structInfo: { readonly sizeof: number } }
  sqlite3_libversion (): string
  sqlite3_vfs_find (name: string | null): Pointer
  sqlite3_open_v2 (filename: string, out: Pointer, flags: number, vfs: string | null): number
  sqlite3_close_v2 (db: Pointer): number
  sqlite3_errmsg (db: Pointer): string
  sqlite3_errstr (code: number): string
  sqlite3_js_rc_str (code: number): string | undefined
  sqlite3_extended_errcode (db: Pointer): number
  sqlite3_exec (db: Pointer, sql: string, callback: number, argument: number, error: number): number
  sqlite3_db_config (db: Pointer, operation: number, enabled: number, out: number): number
  sqlite3_busy_timeout (db: Pointer, milliseconds: number): number
  sqlite3_get_autocommit (db: Pointer): number
  sqlite3_db_filename (db: Pointer, name: string): string | null
  sqlite3_changes64 (db: Pointer): number | bigint
  sqlite3_last_insert_rowid (db: Pointer): number | bigint
  sqlite3_prepare_v2 (db: Pointer, sql: string, length: number, out: Pointer, tail: number): number
  sqlite3_sql (statement: Pointer): string
  sqlite3_stmt_readonly (statement: Pointer): number
  sqlite3_expanded_sql (statement: Pointer): string
  sqlite3_bind_parameter_count (statement: Pointer): number
  sqlite3_bind_parameter_index (statement: Pointer, name: string): number
  sqlite3_bind_parameter_name (statement: Pointer, index: number): string | null
  sqlite3_column_count (statement: Pointer): number
  sqlite3_column_name (statement: Pointer, index: number): string
  sqlite3_column_origin_name (statement: Pointer, index: number): string | null
  sqlite3_column_database_name (statement: Pointer, index: number): string | null
  sqlite3_column_table_name (statement: Pointer, index: number): string | null
  sqlite3_column_decltype (statement: Pointer, index: number): string | null
}

/** A struct binding (`sqlite3_vfs`, `sqlite3_io_methods`, `sqlite3_file`): `$field` reads and writes a member. */
export interface SqliteStruct {
  readonly pointer: Pointer
  [member: string]: unknown
  dispose (): void
}

/** The engine's own exports: the C functions, called with raw pointers and 64-bit integers as `bigint`. */
export interface SqliteExports {
  sqlite3_step (statement: Pointer): number
  sqlite3_reset (statement: Pointer): number
  sqlite3_clear_bindings (statement: Pointer): number
  sqlite3_finalize (statement: Pointer): number
  sqlite3_bind_null (statement: Pointer, index: number): number
  sqlite3_bind_double (statement: Pointer, index: number, value: number): number
  sqlite3_bind_int64 (statement: Pointer, index: number, value: bigint): number
  sqlite3_bind_zeroblob (statement: Pointer, index: number, length: number): number
  sqlite3_bind_text (statement: Pointer, index: number, text: Pointer, length: number, destructor: Pointer): number
  sqlite3_bind_blob (statement: Pointer, index: number, bytes: Pointer, length: number, destructor: Pointer): number
  sqlite3_column_type (statement: Pointer, index: number): number
  sqlite3_column_int64 (statement: Pointer, index: number): bigint
  sqlite3_column_double (statement: Pointer, index: number): number
  sqlite3_column_text (statement: Pointer, index: number): Pointer
  sqlite3_column_blob (statement: Pointer, index: number): Pointer
  sqlite3_column_bytes (statement: Pointer, index: number): number
}

export interface SqliteWasm {
  readonly exports: SqliteExports
  alloc (bytes: number): Pointer
  allocPtr (): Pointer
  dealloc (pointer: Pointer): void
  peekPtr (pointer: Pointer): Pointer
  peek8 (pointer: Pointer): number
  poke32 (pointer: Pointer, value: number): void
  poke64 (pointer: Pointer, value: bigint): void
  poke (pointer: Pointer, value: number | bigint, type: 'double' | 'i64'): void
  heap8u (): Uint8Array
  cstrToJs (pointer: Pointer): string
  cstrncpy (destination: Pointer, source: Pointer, length: number): number
  scopedAllocPush (): unknown
  scopedAllocPop (scope: unknown): void
  scopedAllocCString (text: string, returnLength: true): [Pointer, number]
}

export interface SqliteVfsInstall {
  readonly io?: { readonly struct: SqliteStruct, readonly methods: Record<string, Method | ((...args: never[]) => number)> }
  readonly vfs?: { readonly struct: SqliteStruct, readonly name: string, readonly methods: Record<string, (...args: never[]) => number> }
}

export interface Sqlite3 {
  readonly capi: SqliteCapi
  readonly wasm: SqliteWasm
  readonly vfs: { installVfs (options: SqliteVfsInstall): unknown }
}
