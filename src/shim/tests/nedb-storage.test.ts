// Proves the shim's fs surface (node-fs.ts + fs.promises + the fs.create*
// streams) is enough to run @seald-io/nedb's REAL, UNMODIFIED Node storage
// layer -- the first confirmed caller this branch builds for. Everything
// else nedb needs (path, stream, events, util, crypto, its own
// @seald-io/binary-search-tree dependency) is real Node; only `fs` is this
// repository's concern here.
//
// NOT vi.mock('fs', ...) -- CONFIRMED EMPIRICALLY, NOT ASSUMED. nedb lives
// outside this project's root (a sibling checkout, never an npm dependency
// of this repo -- the task's own instruction), and `import()`ing an absolute
// path outside the Vite root hands the file to NODE'S OWN loader, not
// vite-node's transform/mock graph -- a probe (`require('fs')` inside a
// throwaway external .cjs file) proved vi.mock('fs', ...) has no effect on
// it regardless of `server.deps.inline`. `node:module`'s `Module._load` is
// the one hook that still sees that require() call, because it is Node's
// OWN interception point, not Vite's -- restored in `finally`, so it cannot
// leak into another test file.
//
// `describe.skipIf` below makes the sibling checkout's absence an explicit,
// visible skip rather than a failure, e.g. in CI where it does not exist.

import Module from 'node:module'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { createRealDiskFs, isInside } from './support/real-disk-fs.js'

const NEDB_ROOT = '/home/jhon/git/freetube-src/node_modules/@seald-io/nedb'
const NEDB_DATASTORE = `${NEDB_ROOT}/lib/datastore.js`

// require.resolve, not node:fs's existsSync -- this repo's own fs.existsSync
// is a real, permanent ADR-0016 refusal, and depending on the shim to
// answer "does the sibling checkout exist" would be circular. This goes
// through Node's own module resolution, unaffected by anything below.
const nedbRequire = createRequire(import.meta.url)
function nedbAvailable (): boolean {
  try {
    nedbRequire.resolve(NEDB_DATASTORE)
    return true
  } catch {
    return false
  }
}

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }
interface NedbDatastore {
  loadDatabaseAsync: () => Promise<void>
  insertAsync: (doc: Record<string, unknown>) => Promise<Record<string, unknown>>
  updateAsync: (query: unknown, update: unknown, opts: unknown) => Promise<unknown>
  compactDatafileAsync: () => Promise<void>
  findAsync: (query: unknown) => PromiseLike<Array<Record<string, unknown>>>
}
type DatastoreCtor = new (opts: { filename: string, autoload: boolean }) => NedbDatastore

/** `Module` typed loosely on purpose -- `_load` is a real, long-stable Node internal with no public .d.ts of its own. */
type ModuleWithLoad = typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown }

/**
 * Runs `run` with every `require('fs')`/`require('node:fs')` reached from
 * ANY CommonJS module -- this repo's own or nedb's -- answered by the
 * shim's own node-fs.ts, restoring Node's real loader afterward regardless
 * of how `run` exits. Scoped to this one call, never left installed.
 */
async function withShimAsRequiredFs<T> (run: () => Promise<T>): Promise<T> {
  const shim = await import('../node-fs.js')
  // Same shape as a real `module.exports` -- Module._load's return value IS
  // what a caller's `require(...)` receives directly, no ESM/CJS interop
  // layer in between, so every member node-fs.ts's default export has must
  // be a top-level property here too.
  const fsModuleExports = { ...shim.default, default: shim.default }
  const ModuleCtor = Module as ModuleWithLoad
  const originalLoad = ModuleCtor._load
  ModuleCtor._load = function (request, parent, isMain) {
    if (request === 'fs' || request === 'node:fs') return fsModuleExports
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return await run()
  } finally {
    ModuleCtor._load = originalLoad
  }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
})

describe.skipIf(!nedbAvailable())(
  "@seald-io/nedb's Node storage layer, unmodified, running over orivon.fs",
  () => {
    it('inserts, updates, persists, reloads from the file, and compacts -- producing real on-disk NDJSON', async () => {
      const disk = await createRealDiskFs()
      ;(globalThis as GlobalWithOrivon).orivon = disk.orivon
      try {
        await withShimAsRequiredFs(async () => {
          const { default: Datastore } = await import(NEDB_DATASTORE) as { default: DatastoreCtor }

          // A RELATIVE filename, exactly like nedb's real desktop callers
          // pass (settings.db) -- requirement 5's own case. No leading
          // slash, no directory prefix: this must land inside the app's own
          // fs root purely because real-disk-fs.ts's `root` join resolves
          // it there (the same shape the real broker's own confinement
          // gives), not because this test asked for anywhere specific.
          const db = new Datastore({ filename: 'settings.db', autoload: false })
          await db.loadDatabaseAsync()

          await db.insertAsync({ setting: 'theme', value: 'dark' })
          await db.insertAsync({ setting: 'volume', value: 50 })
          await db.updateAsync({ setting: 'theme' }, { $set: { value: 'light' } }, {})

          // Before compaction: nedb's append-only format means the update
          // above is a THIRD line, not an in-place edit of the first.
          const beforeCompaction = (await disk.readRealFile('settings.db')).split('\n').filter((line) => line !== '')
          expect(beforeCompaction).toHaveLength(3)

          await db.compactDatafileAsync()

          const afterCompaction = (await disk.readRealFile('settings.db')).split('\n').filter((line) => line !== '')
          expect(afterCompaction).toHaveLength(2)
          const compactedDocs = afterCompaction.map((line) => JSON.parse(line) as Record<string, unknown>)
          expect(compactedDocs).toContainEqual(expect.objectContaining({ setting: 'theme', value: 'light' }))
          expect(compactedDocs).toContainEqual(expect.objectContaining({ setting: 'volume', value: 50 }))

          // A relative path really did land inside THIS app's own root, not
          // system-wide or at whatever `process.cwd()` happens to be.
          expect(isInside(disk.root, join(disk.root, 'settings.db'))).toBe(true)
          expect(await disk.existsOnDisk('settings.db')).toBe(true)

          // Reload from the file into a FRESH Datastore instance -- proves
          // the bytes round-tripped through the real file, not this
          // instance's own in-memory cache.
          const reloaded = new Datastore({ filename: 'settings.db', autoload: false })
          await reloaded.loadDatabaseAsync()
          const reloadedDocs = await reloaded.findAsync({})
          expect(reloadedDocs).toHaveLength(2)
          expect(reloadedDocs).toContainEqual(expect.objectContaining({ setting: 'theme', value: 'light' }))
          expect(reloadedDocs).toContainEqual(expect.objectContaining({ setting: 'volume', value: 50 }))
        })
      } finally {
        await disk.cleanup()
      }
    })
  }
)
