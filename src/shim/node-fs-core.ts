// The async core node-fs.ts's callback family and node-fs-promises.ts's
// `fs.promises` both call -- one implementation per operation, never two
// (code-guidelines.md Rule 3), so encoding, error-mapping and the
// append-vs-write choice cannot drift between the two surfaces the way they
// would if each re-implemented its own copy over `getOrivon().fs.*`.
//
// EVERY EXPORTED do*() FUNCTION HERE THROWS AN ALREADY NODE-SHAPED ERROR,
// EXACTLY ONCE -- never a raw OrivonError. A caller (callback wrapper or
// promise export) must never wrap the rejection through toNodeError a
// second time: doAppendFile's error already passed through it once, inside
// node-fs-handle.ts's own `guarded()`, and re-mapping an error whose `.code`
// is already a platform errno (not one of OrivonErrorCode's closed values)
// would silently overwrite it with toNodeError's 'internal' fallback.
//
// PATHS ARE MAPPED IN ONE PLACE, node-fs-path.ts's `confine`: the virtual
// root is stripped from an absolute path, a relative one reaches orivon.fs
// exactly as written, and one outside the root fails EACCES before any call.
// The root itself never reaches orivon.fs (node-fs-root.ts).

import { getOrivon } from './orivon-global.js'
import { toNodeStats, type NodeStats } from './node-fs-stats.js'
import { openHandle } from './node-fs-handle.js'
import {
  assertRootMkdirAllowed, isRootPath, rootIsDirectoryError, rootNotRemovableError, rootReaddirError, rootStat
} from './node-fs-root.js'
import { confine, guarded, type PathLike } from './node-fs-path.js'
import { decode, encode } from './node-fs-encoding.js'

export interface ReadFileOptions { encoding?: string | null }
export interface WriteFileOptions { encoding?: string | null }
export interface MkdirOptions { recursive?: boolean }
export interface RmOptions { recursive?: boolean }

export async function doReadFile (path: PathLike, encoding: string | null | undefined): Promise<Uint8Array | string> {
  const confined = await confine(path, 'open')
  if (isRootPath(confined)) rootIsDirectoryError('read')
  return decode(await guarded(async () => await getOrivon().fs.readFile(confined)), encoding)
}

export async function doWriteFile (path: PathLike, data: unknown, encoding: string | null | undefined): Promise<void> {
  const bytes = encode(data, encoding)
  const confined = await confine(path, 'open')
  if (isRootPath(confined)) rootIsDirectoryError('open')
  await guarded(async () => { await getOrivon().fs.writeFile(confined, bytes) })
}

/**
 * A REAL append, through fs.open(path, 'a') plus one positional write --
 * never read-modify-write. node-fs-handle.ts's `initialCursor` already seeds
 * the local cursor at the file's current size for every append-mode flag
 * (APPEND_FLAGS), and 'a' is one of `VALID_OPEN_FLAGS`
 * (fs-handle-wrapper.ts) the broker already accepts -- so a single
 * cursor-relative write (position omitted) lands exactly at EOF with no
 * extra read, no extra round trip, and no quota charge for bytes this call
 * never touches. On a write failure the handle is still closed (best
 * effort, swallowing a close error so it cannot hide the real one) before
 * the original error propagates.
 */
export async function doAppendFile (path: PathLike, data: unknown, encoding: string | null | undefined): Promise<void> {
  const bytes = encode(data, encoding)
  const handle = await openHandle(path, 'a')
  try {
    await handle.write(bytes, 0, bytes.length)
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  await handle.close()
}

/** `mkdir -p` of the root succeeds locally (@seald-io/nedb's own `path.dirname('settings.db')` is '.'); node-fs-root.ts says why. */
export async function doMkdir (path: PathLike, opts: MkdirOptions | undefined): Promise<void> {
  const confined = await confine(path, 'mkdir')
  if (isRootPath(confined)) { assertRootMkdirAllowed(opts); return }
  await guarded(async () => { await getOrivon().fs.mkdir(confined, opts) })
}

export async function doReaddir (path: PathLike): Promise<readonly string[]> {
  const confined = await confine(path, 'scandir')
  if (isRootPath(confined)) rootReaddirError()
  return await guarded(async () => await getOrivon().fs.readdir(confined))
}

export async function doStat (path: PathLike): Promise<NodeStats> {
  const confined = await confine(path, 'stat')
  if (isRootPath(confined)) return toNodeStats(rootStat())
  return toNodeStats(await guarded(async () => await getOrivon().fs.stat(confined)))
}

export async function doRm (path: PathLike, opts: RmOptions | undefined): Promise<void> {
  const confined = await confine(path, 'rm')
  if (isRootPath(confined)) rootNotRemovableError('rm')
  await guarded(async () => { await getOrivon().fs.rm(confined, opts) })
}

export async function doRename (from: PathLike, to: PathLike): Promise<void> {
  const source = await confine(from, 'rename')
  const target = await confine(to, 'rename')
  if (isRootPath(source) || isRootPath(target)) rootNotRemovableError('rename')
  await guarded(async () => { await getOrivon().fs.rename(source, target) })
}

/** Real Node's fs.unlink never takes a `recursive` option -- orivon.fs has no separate unlink primitive, so this rides fs.rm with none given, failing on a directory the same non-recursive way rm's own callers already do. */
export async function doUnlink (path: PathLike): Promise<void> {
  const confined = await confine(path, 'unlink')
  if (isRootPath(confined)) rootNotRemovableError('unlink')
  await guarded(async () => { await getOrivon().fs.rm(confined) })
}

/**
 * `mode` (F_OK/R_OK/W_OK/X_OK) is accepted but not distinguished: orivon.fs
 * has no POSIX permission bits to check any of R_OK/W_OK/X_OK against
 * (node-fs-unsupported.ts's chmod/chown reasoning), so existence -- via
 * stat(), the same signal a grant-denied or confinement-denied path already
 * fails on -- is the only thing this can honestly answer for any mode.
 * Not owner-reviewed: README.md's Design notes, "fs.access's mode".
 */
export async function doAccess (path: PathLike): Promise<void> {
  const confined = await confine(path, 'access')
  if (isRootPath(confined)) return
  await guarded(async () => { await getOrivon().fs.stat(confined) })
}
