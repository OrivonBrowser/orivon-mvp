// The `sqlite` module target (module-map.ts, `node:sqlite` only): Node's
// synchronous SQLite over the engine in engine.ts.

import { refuseShim } from '../errors.js'
import { nodeModule } from '../polyfills/module-proxy.js'
import { constants } from './constants.js'
import { DatabaseSync } from './database.js'
import { StatementSync } from './statement.js'

export { DatabaseSync, StatementSync, constants }
export { loadSqliteEngine } from './engine.js'
export type { DatabaseSyncOptions } from './database.js'

export function backup (): never {
  throw refuseShim('sqlite.backup', 'not-built', 'sqlite.backup is not built: the engine is built without the online backup API. See src/shim/sqlite/README.md')
}

// A bundler's CommonJS require() reads the namespace, so the members this shim lacks are named there too (generated/).
export * from './generated/sqlite.js'

export default nodeModule('sqlite', { DatabaseSync, StatementSync, constants, backup })
