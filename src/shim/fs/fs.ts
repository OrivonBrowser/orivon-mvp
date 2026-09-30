// `fs` module target (module-map.ts). Wraps orivon.fs's promise-returning
// methods (capability-api.ts) in Node's callback shape -- every confirmed
// caller (fs-chunk-store, webtorrent's own torrent.js, and now
// @seald-io/nedb's Node storage layer) uses plain callback-style fs or
// fs.promises, never a hand-rolled one.
//
// ENCODING IS THE SHIM'S JOB, NOT ORIVON'S (handles.ts's OrivonFs doc, A12):
// encoding.ts. Every callback export below is a thin wrapper over
// fs/core.ts's do*() functions, the SAME core fs.promises
// (fs/promises.ts) calls, so the two surfaces cannot drift
// (code-guidelines.md Rule 3). fs.open
// (fs/handle.ts) and fs.createReadStream/createWriteStream
// (fs/streams.ts, over that same local FileHandle) are real; see each
// file's own header. FileHandle#createReadStream/createWriteStream -- a
// different surface -- still refuses.
//
// SYNCHRONOUS EXPORTS: readFileSync/existsSync work everywhere (ADR-0016);
// every other *Sync export works only in a Worker (fs/core-sync.ts), else
// refuses (fs/unsupported.ts) -- README.md's own Design notes has the detail.
//
// EVERY OTHER fs MEMBER (A135) names its gap: `chown` is 'not-applicable'
// (no POSIX uid/gid model), everything else is 'unimplemented'. The chmod
// family succeeds after an existence check (fs/permissions.ts).

import { type NodeStats } from './stats.js'
import {
  open, openHandle, openSync, close, closeSync, read, readSync, write, writeSync, fstat, fstatSync, fchmod, fchmodSync,
  ftruncate, fsync, type NodeCallback
} from './handle.js'
import { createReadStream, createWriteStream } from './streams.js'
import { chmod, lchmod, chmodSyncWith } from './permissions.js'
import { promises } from './promises.js'
import { FS_CONSTANTS } from './constants.js'
import { getOrivon } from '../orivon-global.js'
import {
  doAccess, doAppendFile, doMkdir, doReaddir, doReadFile, doRealpath, doRename, doRm, doRmdir, doStat,
  doUnlink, doWriteFile,
  type MkdirOptions, type ReaddirOptions, type ReadFileOptions, type RmdirOptions, type RmOptions, type WriteFileOptions
} from './core.js'
import {
  doAccessSync, doAppendFileSync, doCopyFileSync, doLstatSync, doMkdirSync, doMkdtempSync, doReaddirSync,
  doRealpathSync, doRenameSync, doRmSync, doRmdirSync, doStatSync, doUnlinkSync, doWriteFileSync, existsSyncCore
} from './core-sync.js'
import type { NodeDirent } from './stats.js'
import { Buffer } from 'buffer'
import { decode, encodingOf } from '../encoding.js'
import { toConfinedPath, type PathLike } from './paths.js'
import { isRootPath, rootIsDirectoryError } from './root.js'
import { refusingProxy } from '../unimplemented.js'
import { refuseShim } from '../errors.js'
import { toNodeError } from '../node-errors.js'

export { open, close, read, write, fstat, ftruncate, fsync, openSync, closeSync, readSync, writeSync, fstatSync, fchmod, fchmodSync } from './handle.js'
export { chmod, lchmod } from './permissions.js'
export { createReadStream, createWriteStream } from './streams.js'
export { promises } from './promises.js'
// Named as well as on the default export below: a bundled `require('fs')`
// reads named exports only, so data living solely on `default` is undefined.
export { FS_CONSTANTS as constants } from './constants.js'

/** Pops a trailing callback and an optional options object from a variadic tail -- the shape every fs.* call below shares once its own required leading args are removed. */
function splitTail<Options> (args: readonly unknown[]): { options: Options | undefined, callback: NodeCallback<unknown> } {
  const rest = [...args]
  const callback = rest.pop() as NodeCallback<unknown>
  const options = rest.length > 0 ? rest[0] as Options : undefined
  return { options, callback }
}


// Every function below is declared with real Node-shaped overloads (options
// optional, before the callback) rather than one loose `...args: unknown[]`
// signature, so a caller's callback parameters are inferred, not `any` --
// the implementation signature (the last one) still accepts the same
// variadic tail every overload above it can produce.

export function readFile (path: PathLike, callback: NodeCallback<Uint8Array | string>): void
export function readFile (path: PathLike, options: ReadFileOptions | string, callback: NodeCallback<Uint8Array | string>): void
export function readFile (path: PathLike, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<ReadFileOptions | string>(args)
  // `.then(onFulfilled, onRejected)`, never `.then(onFulfilled).catch(onRejected)`:
  // the two-callback form is the only one where a throw INSIDE onFulfilled
  // (here, inside the user's own callback) does not fall into onRejected and
  // re-invoke callback a second time. Node calls a callback exactly once --
  // every wrapper below relies on this same shape for that guarantee.
  doReadFile(path, encodingOf(options)).then(
    (result) => callback(null, result),
    (error) => callback(error as Error)
  )
}

export function readFileSync (path: PathLike, options?: ReadFileOptions | string | null): Uint8Array | string {
  // Still the one call with no async core to share: ADR-0016's synchronous
  // exception exists because orivon.fs.readFileSync itself is the only
  // synchronous orivon.fs entry point, so there is no async do*() version
  // of this call for fs/core.ts to hold -- decode() is shared, the
  // orivon.fs call underneath it is not.
  const confined = toConfinedPath(path, 'open')
  if (isRootPath(confined)) rootIsDirectoryError('read')
  let bytes: Uint8Array
  try {
    bytes = getOrivon().fs.readFileSync(confined)
  } catch (error) {
    throw toNodeError(error)
  }
  return decode(bytes, encodingOf(options))
}

/**
 * On the page: over readFileSync, the one synchronous orivon.fs call
 * (ADR-0016) -- a file it can read exists, and so does a directory, which
 * fails EISDIR. It cannot tell a missing path from one it may not read, so
 * both are false, as Node's own existsSync reports any failure. In a Worker
 * with the synchronous twin, a stat answers it directly (core-sync.ts's
 * existsSyncCore) -- no whole-file read.
 */
export function existsSync (path: PathLike): boolean {
  return existsSyncCore(path, (confined) => getOrivon().fs.readFileSync(confined))
}

export interface StatSyncOptions { throwIfNoEntry?: boolean }

/** statSync/lstatSync's shared `{ throwIfNoEntry: false }`: Node returns `undefined` for a missing path instead of throwing ENOENT (measured) -- any OTHER failure (a denial, EACCES) still throws, exactly as it always did. */
function statOrUndefined (run: () => NodeStats, throwIfNoEntry: boolean | undefined): NodeStats | undefined {
  if (throwIfNoEntry === false) {
    try { return run() } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
  }
  return run()
}

/** ADR-0016's Worker amendment: works only in a Worker of a cross-origin isolated app (core-sync.ts's doStatSync); elsewhere it throws the same named refusal it always has. */
export function statSync (path: PathLike, options?: StatSyncOptions): NodeStats | undefined {
  return statOrUndefined(() => doStatSync(path), options?.throwIfNoEntry)
}

export function lstatSync (path: PathLike, options?: StatSyncOptions): NodeStats | undefined {
  return statOrUndefined(() => doLstatSync(path), options?.throwIfNoEntry)
}

export function writeFileSync (path: PathLike, data: unknown, options?: WriteFileOptions | string | null): void {
  doWriteFileSync(path, data, options)
}

export function appendFileSync (path: PathLike, data: unknown, options?: WriteFileOptions | string | null): void {
  doAppendFileSync(path, data, options)
}

export function mkdirSync (path: PathLike, opts?: MkdirOptions): void {
  doMkdirSync(path, opts)
}

export function readdirSync (path: PathLike, options?: ReaddirOptions | string | null): ReturnType<typeof doReaddirSync> {
  return doReaddirSync(path, options)
}

export function rmSync (path: PathLike, opts?: RmOptions): void {
  doRmSync(path, opts)
}

export function rmdirSync (path: PathLike, opts?: RmdirOptions): void {
  doRmdirSync(path, opts)
}

export function renameSync (from: PathLike, to: PathLike): void {
  doRenameSync(from, to)
}

export function unlinkSync (path: PathLike): void {
  doUnlinkSync(path)
}

export function accessSync (path: PathLike, _mode?: number): void {
  doAccessSync(path)
}

export function copyFileSync (src: PathLike, dest: PathLike, mode?: number): void {
  doCopyFileSync(src, dest, mode)
}

export function mkdtempSync (prefix: string): string {
  return doMkdtempSync(prefix)
}

export interface RealpathOptions { encoding?: string | null }

/** realpathSync/realpath share this: `encoding: 'buffer'` returns the path as a Buffer, same as readdir's own encoding option. */
function realpathResult (path: string, options: RealpathOptions | string | null | undefined): string | Buffer {
  return encodingOf(options) === 'buffer' ? Buffer.from(path) : path
}

/** ADR-0016's Worker amendment: works only in a Worker of a cross-origin isolated app (core-sync.ts's doRealpathSync); elsewhere it throws the same named refusal every other *Sync export does. `.native` bypasses Node's own realpath cache -- this shim keeps none, so it is the exact same call. */
export function realpathSync (path: PathLike, options?: RealpathOptions | string | null): string | Buffer {
  return realpathResult(doRealpathSync(path), options)
}
export namespace realpathSync {
  export function native (path: PathLike, options?: RealpathOptions | string | null): string | Buffer {
    return realpathResult(doRealpathSync(path), options)
  }
}

export function writeFile (path: PathLike, data: unknown, callback: NodeCallback<void>): void
export function writeFile (path: PathLike, data: unknown, options: WriteFileOptions | string, callback: NodeCallback<void>): void
export function writeFile (path: PathLike, data: unknown, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<WriteFileOptions | string>(args)
  doWriteFile(path, data, options).then(
    () => callback(null),
    (error) => callback(error as Error)
  )
}

export function appendFile (path: PathLike, data: unknown, callback: NodeCallback<void>): void
export function appendFile (path: PathLike, data: unknown, options: WriteFileOptions | string, callback: NodeCallback<void>): void
export function appendFile (path: PathLike, data: unknown, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<WriteFileOptions | string>(args)
  doAppendFile(path, data, options).then(
    () => callback(null),
    (error) => callback(error as Error)
  )
}

export function mkdir (path: PathLike, callback: NodeCallback<void>): void
export function mkdir (path: PathLike, options: MkdirOptions, callback: NodeCallback<void>): void
export function mkdir (path: PathLike, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<MkdirOptions>(args)
  doMkdir(path, options).then(() => callback(null), (error) => callback(error as Error))
}

type ReaddirEntries = ReadonlyArray<string | Uint8Array | NodeDirent>

export function readdir (path: PathLike, callback: NodeCallback<ReaddirEntries>): void
export function readdir (path: PathLike, options: ReaddirOptions | string | null, callback: NodeCallback<ReaddirEntries>): void
export function readdir (path: PathLike, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<ReaddirOptions | string | null>(args)
  doReaddir(path, options).then((entries) => callback(null, entries), (error) => callback(error as Error))
}

export function stat (path: PathLike, callback: NodeCallback<NodeStats>): void
export function stat (path: PathLike, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  doStat(path).then((result) => callback(null, result), (error) => callback(error as Error))
}

export function rm (path: PathLike, callback: NodeCallback<void>): void
export function rm (path: PathLike, options: RmOptions, callback: NodeCallback<void>): void
export function rm (path: PathLike, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<RmOptions>(args)
  doRm(path, options).then(() => callback(null), (error) => callback(error as Error))
}

export function rename (from: PathLike, to: PathLike, callback: NodeCallback<void>): void {
  doRename(from, to).then(() => callback(null), (error) => callback(error as Error))
}

export function unlink (path: PathLike, callback: NodeCallback<void>): void {
  doUnlink(path).then(() => callback(null), (error) => callback(error as Error))
}

export function rmdir (path: PathLike, callback: NodeCallback<void>): void
export function rmdir (path: PathLike, options: RmdirOptions, callback: NodeCallback<void>): void
export function rmdir (path: PathLike, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<RmdirOptions>(args)
  doRmdir(path, options).then(() => callback(null), (error) => callback(error as Error))
}

function realpathCallback (path: PathLike, args: readonly unknown[]): void {
  const { options, callback } = splitTail<RealpathOptions | string | null>(args)
  doRealpath(path).then(
    (result) => callback(null, realpathResult(result, options)),
    (error) => callback(error as Error)
  )
}

export function realpath (path: PathLike, callback: NodeCallback<string | Buffer>): void
export function realpath (path: PathLike, options: RealpathOptions | string | null, callback: NodeCallback<string | Buffer>): void
export function realpath (path: PathLike, ...args: readonly unknown[]): void {
  realpathCallback(path, args)
}
export namespace realpath {
  export function native (path: PathLike, callback: NodeCallback<string | Buffer>): void
  export function native (path: PathLike, options: RealpathOptions | string | null, callback: NodeCallback<string | Buffer>): void
  export function native (path: PathLike, ...args: readonly unknown[]): void {
    realpathCallback(path, args)
  }
}

export function access (path: PathLike, callback: NodeCallback<void>): void
export function access (path: PathLike, mode: number, callback: NodeCallback<void>): void
export function access (path: PathLike, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  doAccess(path).then(() => callback(null), (error) => callback(error as Error))
}

export type { NodeStats }

export function chmodSync (path: PathLike, mode: unknown): void {
  chmodSyncWith(existsSync, path, mode)
}

export const lchmodSync = chmodSync

const POSIX_PERMISSION_MEMBERS = new Set(['chown', 'chownSync', 'lchown', 'lchownSync', 'fchown', 'fchownSync'])

export function otherFsMember (prop: string) {
  if (POSIX_PERMISSION_MEMBERS.has(prop)) {
    return refuseShim(
      `fs.${prop}`, 'not-applicable',
      `fs.${prop} sets a POSIX ownership -- this shim's confined fs has no uid or ` +
      'gid to set one on (compatibility-matrix.md Table 3).'
    )
  }
  return refuseShim(
    `fs.${prop}`, 'unimplemented',
    `fs.${prop} is real Node fs surface this shim has not implemented and has not decided ` +
    'whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  )
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/fs.js'

export default refusingProxy({
  readFile, readFileSync, writeFile, writeFileSync, appendFile, unlink, access,
  mkdir, readdir, stat, rm, rmdir, rename, realpath, open, close, read, write, fstat, ftruncate, fsync, promises,
  createReadStream, createWriteStream,
  statSync, lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, renameSync, existsSync, accessSync,
  appendFileSync, unlinkSync, copyFileSync, mkdtempSync, realpathSync, openSync, closeSync, readSync, writeSync, fstatSync,
  chmod, chmodSync, lchmod, lchmodSync, fchmod, fchmodSync,
  // fs.constants is data (POSIX flag numbers), not a function -- a
  // throwing-function refusal (A169) would misreport its own type, so this
  // is a real object rather than routed through otherFsMember.
  constants: FS_CONSTANTS
}, otherFsMember)
