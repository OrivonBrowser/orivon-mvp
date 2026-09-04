// The real, node:fs-backed LedgerStorage -- ledger-storage.ts's own header
// explains why this is synchronous rather than following LoaderStorage's
// async, node:fs/promises pattern.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { originHash } from './origin-hash.js'
import type { LedgerStorage } from './ledger-storage.js'

/**
 * Never valid semver (no digits, no dots) -- returned for anything that
 * exists on disk but is not a clean `{ versionFloor: string }`. GrantLedger
 * detects this via compareVersions returning null and fails every future
 * update closed rather than silently treating it as '0.0.0' (T19).
 */
const CORRUPT_FLOOR_SENTINEL = 'unreadable-or-corrupt-version-floor'

function floorDir (userDataPath: string, origin: string): string {
  return join(userDataPath, 'grants', originHash(origin))
}

function floorPath (userDataPath: string, origin: string): string {
  return join(floorDir(userDataPath, origin), 'version-floor.json')
}

/**
 * Writes `text` to `path` atomically: a temp file in the SAME directory
 * (`renameSync` across filesystems is not atomic, and is sometimes refused
 * outright), fsynced before the rename so the bytes are actually on disk and
 * not just buffered when the rename lands, then renamed over `path`, then
 * the containing directory fsynced so the entry naming those bytes is
 * durable too (`fsyncDirectory` below).
 * POSIX `rename` replaces its target as one atomic operation -- there is no
 * window where a reader sees a partially-written file, only the old
 * complete one or the new complete one.
 *
 * A bare `writeFileSync(path, text)` has no such guarantee: a process that
 * dies mid-write can leave `path` truncated. `readVersionFloor`'s own
 * corrupt-sentinel path makes that permanent -- `isAtOrAboveFloor`
 * (`policy/update.ts`) fails every future update from the affected origin
 * closed once it sees an unparseable floor, with no writer that ever lowers
 * one back out of that state. A write that can only ever land whole, or not
 * at all, is what keeps an ordinary crash from being mistaken for tampering.
 */
function writeFileAtomic (path: string, text: string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDirectory(dirname(path))
}

/**
 * Flushes the DIRECTORY ENTRY the rename above just created. Syncing the
 * file's contents is only half of it: on ext4, XFS and others the entry
 * naming those contents is metadata with its own write-back, so a crash
 * between the rename and the next commit can leave the new file's bytes on
 * disk with nothing pointing at them.
 *
 * BEST EFFORT, deliberately. Windows has no equivalent -- opening a
 * directory as a file fails outright -- and some filesystems refuse fsync on
 * a directory handle. The rename itself has already succeeded by this point,
 * so the only thing lost is durability across a crash in the next few
 * seconds; failing the whole write over that would trade a real, common
 * outcome for a rare one.
 */
function fsyncDirectory (dir: string): void {
  let fd: number
  try {
    fd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // See above: nothing to recover, the data is already renamed into place.
  } finally {
    closeSync(fd)
  }
}

function isVersionFloorShape (value: unknown): value is { versionFloor: string } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { versionFloor?: unknown }).versionFloor === 'string'
}

export function nodeLedgerStorage (userDataPath: string): LedgerStorage {
  return {
    readVersionFloor: (origin) => {
      let text: string
      try {
        text = readFileSync(floorPath(userDataPath, origin), 'utf8')
      } catch (error) {
        // ENOENT alone means "never persisted" -- the one case GrantLedger
        // may treat as having nothing to hydrate. Any OTHER read failure
        // (permissions, a mid-write crash) must not collapse into that same
        // undefined, for the reason ledger-storage.ts's own doc explains.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        return CORRUPT_FLOOR_SENTINEL
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return CORRUPT_FLOOR_SENTINEL
      }
      return isVersionFloorShape(parsed) ? parsed.versionFloor : CORRUPT_FLOOR_SENTINEL
    },
    writeVersionFloor: (origin, versionFloor) => {
      mkdirSync(floorDir(userDataPath, origin), { recursive: true })
      writeFileAtomic(floorPath(userDataPath, origin), JSON.stringify({ versionFloor }))
    },
    deleteVersionFloor: (origin) => {
      try {
        unlinkSync(floorPath(userDataPath, origin))
      } catch (error) {
        // Already gone (never persisted, or forgotten twice) is success, not
        // a failure -- GrantLedger.forgetOrigin's own no-op contract.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
