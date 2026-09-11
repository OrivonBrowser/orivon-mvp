// The real, node:fs-backed LedgerStorage -- ledger-storage.ts's own header
// explains why this is synchronous rather than following LoaderStorage's
// async, node:fs/promises pattern.

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { originHash } from './origin-hash.js'
import type { LedgerStorage, PersistedGrant } from './ledger-storage.js'
import type { Manifest } from '../../contracts/index.js'

/**
 * Never valid semver (no digits, no dots) -- returned for anything that
 * exists on disk but is not a clean `{ versionFloor: string }`. GrantLedger
 * detects this via compareVersions returning null and fails every future
 * update closed rather than silently treating it as '0.0.0' (T19).
 */
const CORRUPT_FLOOR_SENTINEL = 'unreadable-or-corrupt-version-floor'

/** Shared by the version floor and the rollback-acknowledgement flag (d-0017) -- one directory per origin under `grants/`, one file per piece of state. */
function originGrantsDir (userDataPath: string, origin: string): string {
  return join(userDataPath, 'grants', originHash(origin))
}

function floorPath (userDataPath: string, origin: string): string {
  return join(originGrantsDir(userDataPath, origin), 'version-floor.json')
}

function rollbackAckPath (userDataPath: string, origin: string): string {
  return join(originGrantsDir(userDataPath, origin), 'rollback-ack.json')
}

function grantsPath (userDataPath: string, origin: string): string {
  return join(originGrantsDir(userDataPath, origin), 'grants.json')
}

function manifestPath (userDataPath: string, origin: string): string {
  return join(originGrantsDir(userDataPath, origin), 'manifest.json')
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

function isAcknowledgedVersionShape (value: unknown): value is { acknowledgedVersion: string } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { acknowledgedVersion?: unknown }).acknowledgedVersion === 'string'
}

function isPersistedGrant (value: unknown): value is PersistedGrant {
  return typeof value === 'object' && value !== null &&
    Array.isArray((value as { patterns?: unknown }).patterns) &&
    (value as { patterns: unknown[] }).patterns.every((p) => typeof p === 'string') &&
    typeof (value as { grantedAt?: unknown }).grantedAt === 'number'
}

/** A plain object (not an array, not null) whose every own value is a well-formed `PersistedGrant`. Keys are not checked here -- they are untrusted `CapabilityKind` candidates, and `grant-persistence.ts` is what validates them. */
function isGrantsShape (value: unknown): value is Record<string, PersistedGrant> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every(isPersistedGrant)
}

/**
 * The current file shape: the origin alongside its own grants, so the set of
 * origins can be enumerated from a directory whose NAME is a one-way hash
 * (`LedgerStorage.listPersistedOrigins`). Owner decision: shape (b) of the
 * two considered -- the origin inside each record rather than a separate
 * hash-to-origin index file, because an index is a second thing that can
 * drift out of sync, and losing it re-creates the very bug this fixes.
 *
 * Discriminating this from the OLD bare-record shape needs no version tag:
 * `isGrantsShape` requires every value to be a PersistedGrant, and `origin`
 * is a string, so the two are mutually exclusive by construction.
 */
interface GrantsFile {
  readonly origin: string
  readonly grants: Record<string, PersistedGrant>
}

function isGrantsFileShape (value: unknown): value is GrantsFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { origin?: unknown, grants?: unknown }
  return typeof candidate.origin === 'string' && isGrantsShape(candidate.grants)
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
      mkdirSync(originGrantsDir(userDataPath, origin), { recursive: true })
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
    },

    readAcknowledgedRollbackVersion: (origin) => {
      let text: string
      try {
        text = readFileSync(rollbackAckPath(userDataPath, origin), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        // Any other read failure (permissions, a mid-write crash) must fail
        // closed -- LedgerStorage.readAcknowledgedRollbackVersion's own doc
        // explains why collapsing to `undefined` (== "never acknowledged")
        // is the safe direction here, unlike the version floor's sentinel.
        return undefined
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return undefined
      }
      return isAcknowledgedVersionShape(parsed) ? parsed.acknowledgedVersion : undefined
    },
    writeAcknowledgedRollbackVersion: (origin, version) => {
      mkdirSync(originGrantsDir(userDataPath, origin), { recursive: true })
      writeFileAtomic(rollbackAckPath(userDataPath, origin), JSON.stringify({ acknowledgedVersion: version }))
    },
    deleteAcknowledgedRollbackVersion: (origin) => {
      try {
        unlinkSync(rollbackAckPath(userDataPath, origin))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },

    readGrants: (origin) => {
      let text: string
      try {
        text = readFileSync(grantsPath(userDataPath, origin), 'utf8')
      } catch {
        // ENOENT and any other read failure both collapse here -- unlike the
        // floor, "nothing to restore" is the SAFE direction for grants (see
        // LedgerStorage.readGrants's own doc).
        return undefined
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return undefined
      }
      // The origin field is NOT consulted here, on purpose. This function was
      // handed the origin it is reading for and already derived the path from
      // it, so the stored name adds nothing a caller could act on -- only
      // listPersistedOrigins, which starts from a directory instead, needs it,
      // and that is where the re-hash check lives.
      if (isGrantsFileShape(parsed)) return parsed.grants
      // A file written before the origin field existed. Still honoured, so an
      // upgrade does not silently drop grants a user really made; it simply
      // cannot be enumerated until something rewrites it in the new shape.
      return isGrantsShape(parsed) ? parsed : undefined
    },
    writeGrants: (origin, grants) => {
      mkdirSync(originGrantsDir(userDataPath, origin), { recursive: true })
      const file: GrantsFile = { origin, grants }
      writeFileAtomic(grantsPath(userDataPath, origin), JSON.stringify(file))
    },
    deleteGrants: (origin) => {
      try {
        unlinkSync(grantsPath(userDataPath, origin))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },

    readManifest: (origin) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(manifestPath(userDataPath, origin), 'utf8'))
      } catch {
        return undefined
      }
      // Shape-checked only as far as "an object with the fields the caller
      // reads". It is NOT re-validated as a trustworthy declaration here and
      // must not be treated as one: GrantLedger.registerApp re-validates every
      // grant against whichever manifest it is handed, so a tampered file can
      // at worst put a wrong NAME in a list, never widen an authority.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const candidate = parsed as { name?: unknown, version?: unknown }
      if (typeof candidate.name !== 'string' || typeof candidate.version !== 'string') return undefined
      return parsed as Manifest
    },
    writeManifest: (origin, manifest) => {
      mkdirSync(originGrantsDir(userDataPath, origin), { recursive: true })
      writeFileAtomic(manifestPath(userDataPath, origin), JSON.stringify(manifest))
    },
    deleteManifest: (origin) => {
      try {
        unlinkSync(manifestPath(userDataPath, origin))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },

    listPersistedOrigins: () => {
      let entries: string[]
      try {
        entries = readdirSync(join(userDataPath, 'grants'))
      } catch {
        // Nothing persisted yet, or the store is unreadable. Both are "no
        // origins to show", never a throw -- a settings page that cannot
        // render is worse than one that renders empty.
        return []
      }
      const origins: string[] = []
      for (const entry of entries) {
        let parsed: unknown
        try {
          parsed = JSON.parse(readFileSync(join(userDataPath, 'grants', entry, 'grants.json'), 'utf8'))
        } catch {
          continue
        }
        if (!isGrantsFileShape(parsed)) continue
        // THE CHECK THAT MAKES THE STORED ORIGIN SAFE TO REPORT. The name in
        // the file is the only place an origin survives a one-way hash, so it
        // has to earn being believed: it is reported only if it re-hashes to
        // the directory it was found in. A hand-edited or planted file
        // claiming some other origin names a directory it cannot produce --
        // that would need a sha256 preimage -- so it is skipped entirely
        // rather than listed.
        if (originHash(parsed.origin) !== entry) continue
        origins.push(parsed.origin)
      }
      return origins
    }
  }
}
