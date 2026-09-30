// The SQLite WebAssembly engine, brought up once and held for the synchronous
// `node:sqlite` surface. The engine's own start-up is asynchronous, so it is
// awaited here (ready.ts) before any app code runs; README.md says why.

import init from '@sqlite.org/sqlite-wasm'
import { refuseShim } from '../errors.js'
import type { Sqlite3 } from './engine-types.js'

export type { Sqlite3 }

export interface LoadSqliteEngineOptions {
  /** The engine's `sqlite3.wasm`. Left out, the package fetches it from beside the module that imports it. */
  readonly wasmBinary?: Uint8Array | ArrayBuffer
}

/** Every storage backend the package would otherwise try to install, all of which need browser features an Orivon app does not use here. */
const DISABLED_PACKAGE_VFS = { opfs: true, 'opfs-vfs': true, 'opfs-sahpool': true, 'opfs-wl': true, kvvfs: true }

let engine: Sqlite3 | undefined
let loading: Promise<Sqlite3> | undefined

/** The loaded engine. Throws by name when nothing awaited `loadSqliteEngine()` first: `DatabaseSync` is synchronous, so it cannot wait for it. */
export function sqliteEngine (): Sqlite3 {
  if (engine === undefined) {
    throw refuseShim('sqlite.DatabaseSync', 'not-built',
      'the SQLite engine has not finished loading. It starts asynchronously, so a bundle must import ' +
      "the shim's sqlite/ready module (or await loadSqliteEngine()) before the code that opens a database runs")
  }
  return engine
}

export function isSqliteEngineLoaded (): boolean {
  return engine !== undefined
}

/** Loads the engine once; later calls return the same promise. */
export function loadSqliteEngine (options: LoadSqliteEngineOptions = {}): Promise<Sqlite3> {
  loading ??= (async () => {
    const holder = globalThis as unknown as { sqlite3ApiConfig?: unknown }
    // The package reads this global once while it bootstraps, then deletes it.
    holder.sqlite3ApiConfig = { disable: { vfs: DISABLED_PACKAGE_VFS } }
    const moduleArg = options.wasmBinary === undefined ? {} : { wasmBinary: options.wasmBinary }
    const loaded = await (init as unknown as (arg: object) => Promise<Sqlite3>)(moduleArg)
    engine = loaded
    return loaded
  })()
  return loading
}
