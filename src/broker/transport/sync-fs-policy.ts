// The production SyncFsPolicy (./sync-fs.ts). The confinement half reuses
// ../policy/paths.ts's `confinePath` directly -- the exact function
// ../index.ts's own `confineForOrigin` calls -- so a traversal or symlink
// escape is refused by the SAME check on both the sync and async paths,
// never a second copy that could drift from it (code-guidelines.md Rule 3).
// The grant-presence half comes from ./sync-fs-grants.ts's mirror, injected
// as `hasFsGrant` rather than read from ../index.ts's own ledger, which has
// no exported hook this lane may add -- see ./sync-fs.ts's header.
//
// The raw read is node:fs's own `readFileSync`: genuinely synchronous disk
// I/O, which ../broker-contracts.ts's `BrokerFs` (the async `fs.readFile`
// `deps.fs` adapter) has no equivalent for, and which this lane may not add
// one for either (`../adapters/` is the same excluded lane as `../index.ts`).
// Confinement already proves `resolved` is inside this origin's root and
// free of `..`/symlink escapes; this call is the one remaining step,
// matching ../index.ts's own `deps.fs.readFile(resolved)` line for line.

import { readFileSync as nodeReadFileSync } from 'node:fs'
import { CONFINEMENT_ERROR_CODE, confinePath } from '../policy/paths.js'
import { fail } from '../errors.js'
import type { SyncFsPolicy } from './sync-fs.js'

export interface SyncFsPolicyDeps {
  readonly hasFsGrant: (origin: string) => boolean
  /** Same two `BrokerFs` members ../index.ts's `confineForOrigin` calls -- reused, not reimplemented. */
  readonly rootFor: (origin: string) => string
  readonly realpathSync: (path: string) => string
}

export function createSyncFsPolicy (deps: SyncFsPolicyDeps): SyncFsPolicy {
  return {
    confine (origin, path) {
      if (!deps.hasFsGrant(origin)) throw fail('denied', 'fs is not granted to this origin')
      const root = deps.rootFor(origin)
      const confined = confinePath(root, path, deps.realpathSync)
      if (!confined.ok) throw fail(CONFINEMENT_ERROR_CODE, "the path is outside this app's files directory")
      return confined.resolved
    },
    readFileSync: (resolvedPath) => nodeReadFileSync(resolvedPath)
  }
}
