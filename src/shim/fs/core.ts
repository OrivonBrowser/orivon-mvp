// The async core fs/fs.ts's callback family and fs/promises.ts's
// `fs.promises` both call -- one implementation per operation, never two
// (code-guidelines.md Rule 3), so encoding, error-mapping and the
// append-vs-write choice cannot drift between the two surfaces the way they
// would if each re-implemented its own copy over `getOrivon().fs.*`.
//
// EVERY EXPORTED do*() FUNCTION HERE THROWS AN ALREADY NODE-SHAPED ERROR,
// EXACTLY ONCE -- never a raw OrivonError. A caller (callback wrapper or
// promise export) must never wrap the rejection through toNodeError a
// second time: doAppendFile's error already passed through it once, inside
// fs/handle.ts's own `guarded()`, and re-mapping an error whose `.code`
// is already a platform errno (not one of OrivonErrorCode's closed values)
// would silently overwrite it with toNodeError's 'internal' fallback.
//
// PATHS ARE MAPPED IN ONE PLACE, fs/paths.ts's `confine`: the virtual
// root is stripped from an absolute path, a relative one reaches orivon.fs
// exactly as written, and one outside the root fails EACCES before any call.
// The root itself never reaches orivon.fs (fs/root.ts).

import { getOrivon } from '../orivon-global.js'
import { NodeDirent, toNodeStats, type NodeStats } from './stats.js'
import { openHandle } from './handle.js'
import { announce, announceWrite, watchersExist } from './notices.js'
import {
  assertRootMkdirAllowed, isRootPath, rootIsDirectoryError, rootNotRemovableError, rootReaddirError, rootStat
} from './root.js'
import { confine, fsError, guarded, type PathLike } from './paths.js'
import { decode, encode, encodingOf } from '../encoding.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { Buffer } from 'buffer'
import { join } from 'path'

export interface ReadFileOptions { encoding?: string | null }
export interface WriteFileOptions { encoding?: string | null, flag?: string }
export interface MkdirOptions { recursive?: boolean }
export interface RmOptions { recursive?: boolean, force?: boolean }
export interface RmdirOptions { recursive?: boolean }
export interface ReaddirOptions { encoding?: string | null, withFileTypes?: boolean }

export async function doReadFile (path: PathLike, encoding: string | null | undefined): Promise<Uint8Array | string> {
  const confined = await confine(path, 'open')
  if (isRootPath(confined)) rootIsDirectoryError('read')
  return decode(await guarded(async () => await getOrivon().fs.readFile(confined)), encoding)
}

/** Node's writeFile flag: 'w' (the default) is one whole-file write; any other flag opens the file with it, so 'a' appends and 'wx' is an exclusive create. */
export async function doWriteFile (path: PathLike, data: unknown, options: WriteFileOptions | string | null | undefined): Promise<void> {
  const bytes = encode(data, encodingOf(options))
  const flag = typeof options === 'object' && options !== null ? options.flag : undefined
  if (flag !== undefined && flag !== 'w') { await writeThroughHandle(path, bytes, flag); return }
  const confined = await confine(path, 'open')
  if (isRootPath(confined)) rootIsDirectoryError('open')
  const existed = await existedBefore(confined)
  await guarded(async () => { await getOrivon().fs.writeFile(confined, bytes) })
  announceWrite(confined, existed)
}

/** Whether `confined` exists, asked only while something watches (notices.ts): a creating write announces 'rename' first. Unknown reads as existing. */
export async function existedBefore (confined: string): Promise<boolean> {
  if (!watchersExist()) return true
  return await getOrivon().fs.stat(confined).then(() => true, () => false)
}

/** appendFile is writeFile with the flag defaulting to 'a'. */
export async function doAppendFile (path: PathLike, data: unknown, options: WriteFileOptions | string | null | undefined): Promise<void> {
  const flag = typeof options === 'object' && options !== null ? options.flag : undefined
  await writeThroughHandle(path, encode(data, encodingOf(options)), flag ?? 'a')
}

/**
 * One open plus one cursor-relative write -- never read-modify-write.
 * fs/handle.ts's `initialCursor` seeds the cursor at the file's current
 * size for an append flag and at 0 otherwise, so the write lands at EOF for
 * 'a' with no extra read and no quota charge for bytes it never touches. On a
 * write failure the handle is still closed (best effort, swallowing a close
 * error so it cannot hide the real one) before the original error propagates.
 */
async function writeThroughHandle (path: PathLike, bytes: Uint8Array, flags: string): Promise<void> {
  const handle = await openHandle(path, flags)
  try {
    await handle.write(bytes, 0, bytes.length)
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  await handle.close()
}

/** `mkdir -p` of the root succeeds locally (@seald-io/nedb's own `path.dirname('settings.db')` is '.'); fs/root.ts says why. */
export async function doMkdir (path: PathLike, opts: MkdirOptions | undefined): Promise<void> {
  const confined = await confine(path, 'mkdir')
  if (isRootPath(confined)) { assertRootMkdirAllowed(opts); return }
  const existed = opts?.recursive === true ? await existedBefore(confined) : false
  await guarded(async () => { await getOrivon().fs.mkdir(confined, opts) })
  if (!existed) announce(confined, 'rename')
}

export async function doReaddir (path: PathLike, options: ReaddirOptions | string | null | undefined): Promise<ReadonlyArray<string | Uint8Array | NodeDirent>> {
  const confined = await confine(path, 'scandir')
  if (isRootPath(confined)) rootReaddirError()
  const names = await guarded(async () => await getOrivon().fs.readdir(confined))
  if (typeof options === 'object' && options?.withFileTypes === true) {
    const parentPath = typeof path === 'string' ? path : confined
    return await Promise.all(names.map(async (name) => {
      const stat = await getOrivon().fs.stat(join(confined, name)).catch(() => undefined)
      return new NodeDirent(name, parentPath, stat)
    }))
  }
  return encodingOf(options) === 'buffer' ? names.map((name) => Buffer.from(name)) : names
}

export async function doStat (path: PathLike): Promise<NodeStats> {
  const confined = await confine(path, 'stat')
  if (isRootPath(confined)) return toNodeStats(rootStat(), confined)
  return toNodeStats(await guarded(async () => await getOrivon().fs.stat(confined)), confined)
}

/** `force` is Node's, not the broker's: it is applied here, by ignoring ENOENT, and never forwarded. */
export async function doRm (path: PathLike, opts: RmOptions | undefined): Promise<void> {
  const confined = await confine(path, 'rm')
  if (isRootPath(confined)) rootNotRemovableError('rm')
  const brokerOpts = opts?.recursive === undefined ? undefined : { recursive: opts.recursive }
  try {
    await guarded(async () => { await getOrivon().fs.rm(confined, brokerOpts) })
  } catch (error) {
    if (opts?.force === true && (error as { code?: string }).code === 'ENOENT') return
    throw error
  }
  announce(confined, 'rename')
}

/**
 * Real Node's legacy rmdir: `ENOENT` if the path is missing, `ENOTDIR` if it
 * names a file, `ENOTEMPTY` if the directory has entries -- each checked
 * BEFORE ever asking the broker to remove anything, over a `stat` (missing
 * or not a directory) and then a `readdir` (empty or not) -- orivon.fs's own
 * `rm` cannot tell these apart itself: it fails the same way (its real-Node
 * adapter's own `ERR_FS_EISDIR`, mapped to 'internal') whether the directory
 * `recursive: false` refuses to touch is empty or not. Once confirmed empty,
 * this rides `rm` with `recursive: true` -- orivon.fs has one remove
 * primitive, which always needs it for a directory, empty or not.
 * `{ recursive: true }` skips every check and removes the whole tree, same
 * as `rm`'s own option.
 */
export async function doRmdir (path: PathLike, opts: RmdirOptions | undefined): Promise<void> {
  const confined = await confine(path, 'rmdir')
  if (isRootPath(confined)) rootNotRemovableError('rmdir')
  if (opts?.recursive === true) {
    await guarded(async () => { await getOrivon().fs.rm(confined, { recursive: true }) })
    announce(confined, 'rename')
    return
  }
  const pathText = typeof path === 'string' ? path : confined
  const stat = await guarded(async () => await getOrivon().fs.stat(confined))
  if (!stat.isDirectory) throw fsError('ENOTDIR', 'not a directory', 'rmdir', pathText)
  const entries = await guarded(async () => await getOrivon().fs.readdir(confined))
  if (entries.length > 0) throw fsError('ENOTEMPTY', 'directory not empty', 'rmdir', pathText)
  await guarded(async () => { await getOrivon().fs.rm(confined, { recursive: true }) })
  announce(confined, 'rename')
}

/**
 * The real path of anything this shim can stat: orivon.fs never reports a
 * symlink as its own kind (`doLstatSync`'s own comment -- one that would
 * escape confinement is denied before any access, and one that would not is
 * resolved transparently), so the "real" path of an existing entry is
 * exactly its normalised absolute path under the virtual root -- no broker
 * round trip beyond confirming it exists (`ENOENT` otherwise). The root
 * itself always exists, so it is answered locally, like every other root
 * call (`root.ts`).
 */
export async function doRealpath (path: PathLike): Promise<string> {
  const confined = await confine(path, 'lstat')
  if (!isRootPath(confined)) await guarded(async () => { await getOrivon().fs.stat(confined) })
  return isRootPath(confined) ? VIRTUAL_ROOT : join(VIRTUAL_ROOT, confined)
}

export async function doRename (from: PathLike, to: PathLike): Promise<void> {
  const source = await confine(from, 'rename')
  const target = await confine(to, 'rename')
  if (isRootPath(source) || isRootPath(target)) rootNotRemovableError('rename')
  await guarded(async () => { await getOrivon().fs.rename(source, target) })
  announce(source, 'rename')
  announce(target, 'rename')
}

/** Real Node's fs.unlink never takes a `recursive` option -- orivon.fs has no separate unlink primitive, so this rides fs.rm with none given, failing on a directory the same non-recursive way rm's own callers already do. */
export async function doUnlink (path: PathLike): Promise<void> {
  const confined = await confine(path, 'unlink')
  if (isRootPath(confined)) rootNotRemovableError('unlink')
  await guarded(async () => { await getOrivon().fs.rm(confined) })
  announce(confined, 'rename')
}

/**
 * `mode` (F_OK/R_OK/W_OK/X_OK) is accepted but not distinguished: orivon.fs
 * has no POSIX permission bits to check any of R_OK/W_OK/X_OK against
 * (fs/unsupported.ts's chmod/chown reasoning), so existence -- via
 * stat(), the same signal a grant-denied or confinement-denied path already
 * fails on -- is the only thing this can honestly answer for any mode.
 * Not owner-reviewed: README.md's Design notes, "fs.access's mode".
 */
export async function doAccess (path: PathLike): Promise<void> {
  const confined = await confine(path, 'access')
  if (isRootPath(confined)) return
  await guarded(async () => { await getOrivon().fs.stat(confined) })
}
