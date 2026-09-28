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
//
// SIZE-CAPPED (R5-03): this blocks the main thread with no timeout, so an
// uncapped read on a large file freezes every window, tab and origin, not
// only the caller. ADR-0016 says this path is for startup config, not bulk
// data, so `statSync` runs first and refuses past MAX_SYNC_READ_BYTES --
// faithful to that intent, not a retreat from it. The threshold is a
// placeholder pending owner decision d-D (caps become manifest
// declarations the user sees, per A80) -- see docs/open-questions.md.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync as nodeReadFileSync } from 'node:fs'
import { leafSymlinkError } from '../adapters/node-fs-adapter.js'
import { fail } from '../errors.js'
import type { Broker } from '../broker-contracts.js'
import type { SyncFsPolicy } from './sync-fs.js'

/** A placeholder value, not the owner's chosen number -- see this file's header. */
const MAX_SYNC_READ_BYTES = 2 * 1024 * 1024

/** Undefined on Windows -- same platform gap node-fs-adapter.ts's own `NOFOLLOW` documents. */
const NOFOLLOW: number | undefined = fsConstants.O_NOFOLLOW

/**
 * Opens `path` read-only without following a leaf symlink, mirroring
 * `../adapters/node-fs-adapter.ts`'s own `openNoFollow` -- same POSIX
 * `O_NOFOLLOW`/Windows `lstat`-first split, same `leafSymlinkError` shape,
 * necessarily a second, SYNCHRONOUS implementation (this whole file exists
 * because `orivon.fs.readFileSync`'s caller cannot await a Promise,
 * ADR-0016) rather than a shared one. Closes the same TOCTOU
 * `policy/paths.ts`'s own doc comment describes: `confineSync` proves the
 * leaf safe at that instant; only this open, not a second path check, can
 * prove it still is by the time the bytes are read.
 */
function openLeafNoFollowSync (path: string): number {
  if (NOFOLLOW !== undefined) return openSync(path, fsConstants.O_RDONLY | NOFOLLOW)
  let leaf
  try {
    leaf = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Does not exist -- nothing to follow; let the real open below raise
    // its own ENOENT, the same shape a missing file always fails with.
    return openSync(path, fsConstants.O_RDONLY)
  }
  if (leaf.isSymbolicLink()) throw leafSymlinkError(path)
  return openSync(path, fsConstants.O_RDONLY)
}

export function createSyncFsPolicy (
  broker: Pick<Broker, 'fs'>,
  maxReadBytes: number = MAX_SYNC_READ_BYTES
): SyncFsPolicy {
  return {
    confine: (origin, path) => broker.fs.confineSync(origin, path),
    readFileSync: (resolvedPath) => {
      const fd = openLeafNoFollowSync(resolvedPath)
      try {
        // fstat on the OPEN fd, not statSync(resolvedPath) -- a second
        // path-taking call would re-open the TOCTOU window openLeafNoFollowSync
        // just closed. stat before read, not read-then-measure, still holds:
        // the main process must never block on bytes it is about to refuse.
        const { size } = fstatSync(fd)
        if (size > maxReadBytes) {
          throw fail('limit', 'the file exceeds the synchronous read size cap')
        }
        // A copy, not a view into node:fs's pool-backed Buffer -- see
        // ../adapters/README.md's Design notes for why this one memcpy is
        // load-bearing here too. readFileSync(fd) reads via the descriptor
        // already proven safe, never re-resolving `resolvedPath`.
        return new Uint8Array(nodeReadFileSync(fd))
      } finally {
        closeSync(fd)
      }
    }
  }
}
