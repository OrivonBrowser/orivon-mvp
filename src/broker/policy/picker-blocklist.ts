// Confines the OTHER direction from ./paths.ts's confinePath: not "does a
// requested path escape a picked root", but "should the picker refuse this
// root at all". `orivon.fs.userSelected`'s contract (capability-api.ts):
// a folder or file pick that is Orivon's own data, a filesystem root, the
// account's home folder, or a short fixed list of system directories is
// never a valid pick -- not because an app would
// later escape it (confinePath still answers that question, unchanged),
// but because the folder ITSELF holds state the picker's "read, change and
// delete everything here" warning was never written to cover: another
// app's grants, the identity seed, or the operating system.
//
// EACH GROUP GETS THE RELATION THAT MAKES SENSE FOR IT, because "nested
// inside" means something different for each one:
//   - Orivon's own data roots: refuse the pick whichever way the overlap
//     runs. An ancestor of userData reaches into it from outside; a path
//     INSIDE userData -- say one app's own confined files directory,
//     picked directly -- is already another app's tree, not the person's.
//   - the home folder: refuse picking it, or a folder that CONTAINS it
//     (every sibling account's home along with it) -- but not an ordinary
//     subfolder (~/Downloads), which is the picker's whole reason to exist.
//   - a filesystem root: nothing is its ancestor and everything on that
//     drive is its descendant, so only equality is a meaningful refusal; an
//     "under the root" rule would refuse every pick there is.
//   - the fixed system list (~/.ssh, /etc, ...): refuse the item itself or
//     anything inside it. An ancestor of one is already refused above.

import { posix, win32 } from 'node:path'
import type { PlatformPath } from 'node:path'

/** What `pickerBlockReason` checks `picked` against -- built fresh for each pick by whatever wiring can learn about this machine (`../capabilities/user-selected.ts`'s own `createPickGuardCheck`), never here: this module stays free of `node:os`/`node:fs`, matching every other file in this directory (README.md). */
export interface PickerGuardRoots {
  /** Every directory Orivon itself keeps state in directly: this session's own data root, and the default profile's own directory (which holds every other profile -- `dataRoots`'s own ancestor check below covers a profile created after this guard was built without needing to name it). */
  readonly dataRoots: readonly string[]
  /** The account's home folder, or `undefined` where it could not be determined. */
  readonly home: string | undefined
  /** A short, fixed list of system directories (`~/.ssh`, `/etc`, `C:\Windows`, ...) -- whichever of them apply on this platform. */
  readonly systemDirectories: readonly string[]
  /**
   * Where private-session directories live, matched by name rather than by a snapshot of which
   * ones currently exist -- a session started after this guard's roots were last computed is
   * refused exactly like one already running. Absent only where a caller has no such directory
   * to speak of (a test with no private-session concept).
   */
  readonly privateSessions?: {
    /** The directory every private session sits directly under (`os.tmpdir()`). */
    readonly tempDir: string
    /** True for a directory name shaped like a private session's own (`../../main/launch/private-session.ts`'s `isPrivateDirName`). */
    readonly isPrivateDirName: (name: string) => boolean
  }
}

/** Windows paths use `win32`, matching `../policy/paths.ts`'s own `flavourFor` -- taken from the path's own shape, never `process.platform`, so the same input has the same verdict on every platform this runs on. */
function flavourFor (path: string): PlatformPath {
  return /^[a-zA-Z]:/.test(path) || /^[\\/]{2}/.test(path) ? win32 : posix
}

/** Resolved through `realpath`, or `path` itself when nothing exists there yet -- a guard entry that names no real directory overlaps nothing a pick could reach. */
function resolved (path: string, realpath: (p: string) => string): string {
  try {
    return realpath(path)
  } catch {
    return path
  }
}

/**
 * True if `child` is `parent` itself or strictly inside it. `../policy/
 * paths.ts`'s own `escapes` check, inverted, and applied to two arbitrary
 * canonical directories rather than a confinement root and a requested
 * path -- a different question (the picker asks it about the pick BEFORE
 * any path is requested under it), so it stays a function of its own
 * rather than a second call into `confinePath`.
 */
function isAncestorOrEqual (parent: string, child: string, flavour: PlatformPath): boolean {
  if (parent === child) return true
  const rel = flavour.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(rel)
}

/**
 * Why a pick under `guard.privateSessions.tempDir` is refused, or `null` to allow it: `picked`
 * IS or contains `tempDir` (reaching every session beneath it at once, the same "either
 * direction" reasoning `dataRoots` above applies to Orivon's own data), or its first path
 * segment under `tempDir` is shaped like a private session's own directory -- checked by name,
 * never by asking the filesystem which such directories exist right now (this file's own header:
 * no `node:fs` here), so a session started after this guard was built is covered exactly like
 * one already running.
 */
function privateSessionReason (picked: string, rule: NonNullable<PickerGuardRoots['privateSessions']>, flavour: PlatformPath, realpath: (p: string) => string): string | null {
  const tempDir = resolved(rule.tempDir, realpath)
  if (isAncestorOrEqual(picked, tempDir, flavour)) return 'this is where Orivon keeps private-session data'
  const rel = flavour.relative(tempDir, picked)
  if (rel === '' || rel === '..' || rel.startsWith(`..${flavour.sep}`) || flavour.isAbsolute(rel)) return null
  const firstSegment = rel.split(flavour.sep)[0] as string
  return rule.isPrivateDirName(firstSegment) ? "this folder holds a private session's data" : null
}

/**
 * Why the picker should refuse `picked` (already realpath'd by the
 * caller -- `../capabilities/user-selected.ts`'s `pickDirectory`/
 * `pickFiles` realpath a fresh OS pick before this ever runs), or `null` to
 * allow it. `guard`'s own entries are realpath'd here, once each, so a
 * symlinked profile directory or home folder cannot dodge the check the way
 * an un-canonicalised string comparison would let it.
 */
export function pickerBlockReason (picked: string, guard: PickerGuardRoots, realpath: (p: string) => string): string | null {
  const flavour = flavourFor(picked)

  for (const root of guard.dataRoots) {
    const canonicalRoot = resolved(root, realpath)
    if (isAncestorOrEqual(canonicalRoot, picked, flavour) || isAncestorOrEqual(picked, canonicalRoot, flavour)) {
      return "this folder holds Orivon's own data"
    }
  }
  if (guard.privateSessions !== undefined) {
    const reason = privateSessionReason(picked, guard.privateSessions, flavour, realpath)
    if (reason !== null) return reason
  }
  if (guard.home !== undefined && isAncestorOrEqual(picked, resolved(guard.home, realpath), flavour)) {
    return "this is the account's home folder"
  }
  if (flavour.parse(picked).root === picked) return 'this is a filesystem root'
  for (const dir of guard.systemDirectories) {
    if (isAncestorOrEqual(resolved(dir, realpath), picked, flavour)) return 'this is a system folder'
  }
  return null
}
