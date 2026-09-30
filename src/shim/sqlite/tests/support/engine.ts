// Loads the real SQLite engine once for a test file, as a bundle's
// ready module does before app code runs.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadSqliteEngine } from '../../engine.js'

const wasmPath = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')

export async function loadTestEngine (): Promise<void> {
  await loadSqliteEngine({ wasmBinary: readFileSync(wasmPath) })
}
