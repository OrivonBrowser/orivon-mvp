// The synchronous twin of core.ts's do*() functions -- ADR-0016's amendment:
// every path-based fs *Sync call works in a Worker (a forked child or a
// worker_threads thread) of a cross-origin isolated app, over the Worker's
// synchronous twin (sync-orivon.ts). Elsewhere it throws the same named
// refusal (fs/unsupported.ts's OrivonFsUnsupportedError, thrown by
// sync-orivon.ts's syncFs()).
//
// SHARES CONFINEMENT, ROOT SPECIAL-CASING, STATS CONVERSION AND ENCODING
// WITH core.ts'S ASYNC do*() FUNCTIONS (fs/paths.ts, fs/root.ts, fs/stats.ts,
// encoding.ts) -- the only thing that cannot be shared with them is the
// "await" itself: a *Sync export must return its result, never a Promise,
// so each function below is core.ts's matching do*() with `await` and
// `confine`'s tmpdir Promise both replaced by their synchronous equivalents.

import { NodeDirent, toNodeStats, type NodeStats } from './stats.js'
import {
  assertRootMkdirAllowed, isRootPath, rootIsDirectoryError, rootNotRemovableError, rootReaddirError, rootStat
} from './root.js'
import { confineSync, fsError, type PathLike } from './paths.js'
import { openHandleSync } from './handle.js'
import { guardedSync, syncFs, tryStatSync, type SyncOrivonFs } from './sync-orivon.js'
import { toNodeError } from '../node-errors.js'
import { encode, encodingOf } from '../encoding.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import type { MkdirOptions, ReaddirOptions, RmdirOptions, RmOptions, WriteFileOptions } from './core.js'
import { Buffer } from 'buffer'
import { join } from 'path'

export function doStatSync (path: PathLike): NodeStats {
  const confined = confineSync(path, 'stat', 'fs.statSync')
  if (isRootPath(confined)) return toNodeStats(rootStat(), confined)
  return toNodeStats(guardedSync(() => syncFs('fs.statSync').stat(confined)), confined)
}

/** `lstat` and `stat` never differ here: orivon.fs resolves a symlink that stays inside the confined root transparently and denies one that would not (README.md's own "never reports a symlink as its own kind"), so there is no separate primitive for this to call. */
export function doLstatSync (path: PathLike): NodeStats {
  const confined = confineSync(path, 'lstat', 'fs.lstatSync')
  if (isRootPath(confined)) return toNodeStats(rootStat(), confined)
  return toNodeStats(guardedSync(() => syncFs('fs.lstatSync').stat(confined)), confined)
}

export function doWriteFileSync (path: PathLike, data: unknown, options: WriteFileOptions | string | null | undefined): void {
  const bytes = encode(data, encodingOf(options))
  const flag = typeof options === 'object' && options !== null ? options.flag : undefined
  if (flag !== undefined && flag !== 'w') { writeThroughHandleSync(path, bytes, flag); return }
  const confined = confineSync(path, 'open', 'fs.writeFileSync')
  if (isRootPath(confined)) rootIsDirectoryError('open')
  guardedSync(() => { syncFs('fs.writeFileSync').writeFile(confined, bytes) })
}

export function doAppendFileSync (path: PathLike, data: unknown, options: WriteFileOptions | string | null | undefined): void {
  const flag = typeof options === 'object' && options !== null ? options.flag : undefined
  writeThroughHandleSync(path, encode(data, encodingOf(options)), flag ?? 'a')
}

/** core.ts's writeThroughHandle, blocking: one open plus one cursor-relative write, over fs/handle.ts's SyncNodeFileHandle. */
function writeThroughHandleSync (path: PathLike, bytes: Uint8Array, flags: string): void {
  const handle = openHandleSync(path, flags)
  try {
    handle.write(bytes, 0, bytes.length)
  } catch (error) {
    try { handle.close() } catch { /* the original error is the one that matters */ }
    throw error
  }
  handle.close()
}

export function doMkdirSync (path: PathLike, opts: MkdirOptions | undefined): void {
  const confined = confineSync(path, 'mkdir', 'fs.mkdirSync')
  if (isRootPath(confined)) { assertRootMkdirAllowed(opts); return }
  guardedSync(() => { syncFs('fs.mkdirSync').mkdir(confined, opts) })
}

export function doReaddirSync (path: PathLike, options: ReaddirOptions | string | null | undefined): ReadonlyArray<string | Uint8Array | NodeDirent> {
  const confined = confineSync(path, 'scandir', 'fs.readdirSync')
  if (isRootPath(confined)) rootReaddirError()
  const fs = syncFs('fs.readdirSync')
  const names = guardedSync(() => fs.readdir(confined))
  if (typeof options === 'object' && options?.withFileTypes === true) {
    const parentPath = typeof path === 'string' ? path : confined
    return names.map((name) => {
      let stat
      try { stat = fs.stat(join(confined, name)) } catch { stat = undefined }
      return new NodeDirent(name, parentPath, stat)
    })
  }
  return encodingOf(options) === 'buffer' ? names.map((name) => Buffer.from(name)) : names
}

export function doRmSync (path: PathLike, opts: RmOptions | undefined): void {
  const confined = confineSync(path, 'rm', 'fs.rmSync')
  if (isRootPath(confined)) rootNotRemovableError('rm')
  const brokerOpts = opts?.recursive === undefined ? undefined : { recursive: opts.recursive }
  try {
    guardedSync(() => { syncFs('fs.rmSync').rm(confined, brokerOpts) })
  } catch (error) {
    if (opts?.force === true && (error as { code?: string }).code === 'ENOENT') return
    throw error
  }
}

/**
 * doRmdir's synchronous twin (core.ts's own doc comment has the detail):
 * `ENOENT` missing, `ENOTDIR` a file, `ENOTEMPTY` a non-empty directory --
 * each checked over the twin's own `stat`/`readdir` before ever asking it to
 * remove anything, since its `rm` cannot tell an empty directory from a
 * non-empty one itself. Once confirmed empty, this rides `rm` with
 * `recursive: true`, the same primitive `rmSync` uses -- orivon.fs has one
 * remove primitive, which always needs it for a directory, empty or not.
 * `{ recursive: true }` skips every check and removes the whole tree.
 */
export function doRmdirSync (path: PathLike, opts: RmdirOptions | undefined): void {
  const confined = confineSync(path, 'rmdir', 'fs.rmdirSync')
  if (isRootPath(confined)) rootNotRemovableError('rmdir')
  const fs = syncFs('fs.rmdirSync')
  if (opts?.recursive === true) {
    guardedSync(() => { fs.rm(confined, { recursive: true }) })
    return
  }
  const pathText = typeof path === 'string' ? path : confined
  const stat = guardedSync(() => fs.stat(confined))
  if (!stat.isDirectory) throw fsError('ENOTDIR', 'not a directory', 'rmdir', pathText)
  const entries = guardedSync(() => fs.readdir(confined))
  if (entries.length > 0) throw fsError('ENOTEMPTY', 'directory not empty', 'rmdir', pathText)
  guardedSync(() => { fs.rm(confined, { recursive: true }) })
}

/** doRealpath's synchronous twin (core.ts's own doc comment has the detail): confirms the confined path exists (over the twin's `stat`), then returns its normalised absolute path under the virtual root -- no other broker call, since orivon.fs never reports a symlink as its own kind. */
export function doRealpathSync (path: PathLike): string {
  const confined = confineSync(path, 'lstat', 'fs.realpathSync')
  if (!isRootPath(confined)) guardedSync(() => { syncFs('fs.realpathSync').stat(confined) })
  return isRootPath(confined) ? VIRTUAL_ROOT : join(VIRTUAL_ROOT, confined)
}

export function doRenameSync (from: PathLike, to: PathLike): void {
  const source = confineSync(from, 'rename', 'fs.renameSync')
  const target = confineSync(to, 'rename', 'fs.renameSync')
  if (isRootPath(source) || isRootPath(target)) rootNotRemovableError('rename')
  guardedSync(() => { syncFs('fs.renameSync').rename(source, target) })
}

export function doUnlinkSync (path: PathLike): void {
  const confined = confineSync(path, 'unlink', 'fs.unlinkSync')
  if (isRootPath(confined)) rootNotRemovableError('unlink')
  guardedSync(() => { syncFs('fs.unlinkSync').rm(confined) })
}

export function doAccessSync (path: PathLike): void {
  const confined = confineSync(path, 'access', 'fs.accessSync')
  if (isRootPath(confined)) return
  guardedSync(() => { syncFs('fs.accessSync').stat(confined) })
}

const COPYFILE_EXCL = 1

/** copyFileSync over the twin's readFile/writeFile -- orivon.fs has no copy primitive of its own, sync or async. `mode`'s only bit this can honour is COPYFILE_EXCL: a stat-then-write race (fs/fs.ts's own "fs.access's mode" note has the same shape of gap), not atomic, but this fs has no exclusive-create flag to ask the broker for instead. */
export function doCopyFileSync (src: PathLike, dest: PathLike, mode: number | undefined): void {
  const fs = syncFs('fs.copyFileSync')
  const from = confineSync(src, 'copyfile', 'fs.copyFileSync')
  const to = confineSync(dest, 'copyfile', 'fs.copyFileSync')
  if (isRootPath(from)) rootIsDirectoryError('open')
  if (mode !== undefined && (mode & COPYFILE_EXCL) !== 0 && (isRootPath(to) || tryStatOk(fs, to))) {
    throw fileExistsError(typeof dest === 'string' ? dest : to)
  }
  if (isRootPath(to)) rootIsDirectoryError('open')
  const bytes = guardedSync(() => fs.readFile(from))
  guardedSync(() => { fs.writeFile(to, bytes) })
}

function tryStatOk (fs: SyncOrivonFs, path: string): boolean {
  try {
    fs.stat(path)
    return true
  } catch {
    return false
  }
}

function fileExistsError (path: string): Error {
  return Object.assign(new Error(`EEXIST: file already exists, copyfile '${path}'`), { code: 'EEXIST', path })
}

const MKDTEMP_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** mkdtempSync over mkdir: orivon.fs has no atomic exclusive-create, so a name collision (vanishingly unlikely at 12 random characters) retries with a fresh one instead of failing. */
export function doMkdtempSync (prefix: string): string {
  const fs = syncFs('fs.mkdtempSync')
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = `${prefix}${randomSuffix()}`
    const confined = confineSync(path, 'mkdtemp', 'fs.mkdtempSync')
    try {
      guardedSync(() => { fs.mkdir(confined) })
      return path
    } catch (error) {
      // guardedSync already mapped this to a Node-shaped error -- checking
      // toNodeError(error).code again here would overwrite a real errno with
      // 'internal' (core.ts's own header warns against exactly this).
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
  }
  throw Object.assign(new Error('EEXIST: file already exists, mkdtemp'), { code: 'EEXIST' })
}

function randomSuffix (): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += MKDTEMP_CHARS[byte % MKDTEMP_CHARS.length]
  return out
}

/**
 * existsSync's shared decision: a stat in a Worker, or the page's own
 * whole-file-read fallback (fs.ts keeps that route, over the one call
 * ADR-0016 always grants everywhere). `readFileSyncFallback` must be the
 * RAW orivon.fs.readFileSync call, not fs.ts's own Node-mapped export --
 * this maps its error exactly once, itself.
 */
export function existsSyncCore (path: PathLike, readFileSyncFallback: (confined: string) => Uint8Array): boolean {
  let confined: string
  try {
    confined = confineSync(path, 'access', 'fs.existsSync')
  } catch {
    return false
  }
  if (isRootPath(confined)) return true
  const inWorker = tryStatSync(confined)
  if (inWorker !== undefined) return inWorker
  try {
    readFileSyncFallback(confined)
    return true
  } catch (error) {
    return toNodeError(error).code === 'EISDIR'
  }
}
