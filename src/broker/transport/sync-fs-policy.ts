// The production SyncFsPolicy (./sync-fs.ts). Both halves are ../index.ts's
// own `Broker.fs.confineSync` -- the SAME grant check and path confinement
// `fs.readFile`/`writeFile` use (`confineForOrigin`), exposed synchronously
// for exactly this caller -- so a missing grant or a traversal/symlink
// escape is refused by the ONE check, never a second implementation of it
// (code-guidelines.md Rule 3). Earlier revisions of this lane mirrored the
// grant check separately (`sync-fs-grants.ts`, since removed) because
// `../index.ts` was owned by a concurrent, unmerged lane at the time; that
// constraint expired when `stream/broker-37-secure-connect` merged, and
// `confineSync` is the real thing that mirror stood in for.
//
// The raw read is node:fs's own `readFileSync`: genuinely synchronous disk
// I/O, which `../broker-contracts.ts`'s `BrokerFs` (the async `fs.readFile`
// `deps.fs` adapter) has no equivalent for. Confinement already proves the
// resolved path is inside this origin's root and free of `..`/symlink
// escapes; this call is the one remaining step, matching ../index.ts's own
// `deps.fs.readFile(resolved)` line for line.

import { readFileSync as nodeReadFileSync } from 'node:fs'
import type { Broker } from '../broker-contracts.js'
import type { SyncFsPolicy } from './sync-fs.js'

export function createSyncFsPolicy (broker: Pick<Broker, 'fs'>): SyncFsPolicy {
  return {
    confine: (origin, path) => broker.fs.confineSync(origin, path),
    readFileSync: (resolvedPath) => {
      // A copy, not a view into node:fs's pool-backed Buffer -- see
      // ../adapters/README.md's Design notes for why this one memcpy is
      // load-bearing here too.
      return new Uint8Array(nodeReadFileSync(resolvedPath))
    }
  }
}
