// `fs` module target (module-map.ts). Wraps orivon.fs's promise-returning
// methods (capability-api.ts) in Node's callback shape -- every confirmed
// caller (fs-chunk-store, webtorrent's own torrent.js, and now
// @seald-io/nedb's Node storage layer) uses plain callback-style fs or
// fs.promises, never a hand-rolled one.
//
// ENCODING IS THE SHIM'S JOB, NOT ORIVON'S (handles.ts's OrivonFs doc, A12):
// node-fs-encoding.ts. Every callback export below is a thin wrapper over
// node-fs-core.ts's do*() functions, the SAME core fs.promises
// (node-fs-promises.ts) calls, so the two surfaces cannot drift
// (code-guidelines.md Rule 3). fs.open
// (node-fs-handle.ts) and fs.createReadStream/createWriteStream
// (node-fs-streams.ts, over that same local FileHandle) are real; see each
// file's own header. FileHandle#createReadStream/createWriteStream -- a
// different surface -- still refuses. Every synchronous
// export except readFileSync and existsSync (both over ADR-0016's one sync
// call) is a named refusal (node-fs-unsupported.ts).
//
// EVERY OTHER fs MEMBER (A135) names its gap: `chmod`/`chown` are
// 'not-applicable' (no POSIX uid/gid/mode model), everything else is
// 'unimplemented'.

import { type NodeStats } from './node-fs-stats.js'
import { syncUnsupported } from './node-fs-unsupported.js'
import { open, openHandle, close, read, write, fstat, ftruncate, fsync, type NodeCallback } from './node-fs-handle.js'
import { createReadStream, createWriteStream } from './node-fs-streams.js'
import { promises } from './node-fs-promises.js'
import { FS_CONSTANTS } from './node-fs-constants.js'
import { getOrivon } from './orivon-global.js'
import {
  doAccess, doAppendFile, doMkdir, doReaddir, doReadFile, doRename, doRm, doStat, doUnlink, doWriteFile,
  type MkdirOptions, type ReadFileOptions, type RmOptions, type WriteFileOptions
} from './node-fs-core.js'
import { decode, encodingOf } from './node-fs-encoding.js'
import { toConfinedPath, type PathLike } from './node-fs-path.js'
import { isRootPath, rootIsDirectoryError } from './node-fs-root.js'
import { refusingProxy } from './unimplemented.js'
import { refuseShim } from './errors.js'
import { toNodeError } from './node-http-errors.js'

export { open, close, read, write, fstat, ftruncate, fsync } from './node-fs-handle.js'
export { createReadStream, createWriteStream } from './node-fs-streams.js'
export { promises } from './node-fs-promises.js'
// Named as well as on the default export below: a bundled `require('fs')`
// reads named exports only, so data living solely on `default` is undefined.
export { FS_CONSTANTS as constants } from './node-fs-constants.js'

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
  // of this call for node-fs-core.ts to hold -- decode() is shared, the
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
 * Over readFileSync, the one synchronous orivon.fs call (ADR-0016): a file it
 * can read exists, and so does a directory, which fails EISDIR. It cannot
 * tell a missing path from one it may not read, so both are false, as Node's
 * own existsSync reports any failure. The cost is a whole-file read per call.
 */
export function existsSync (path: PathLike): boolean {
  let confined: string
  try {
    confined = toConfinedPath(path, 'access')
  } catch {
    return false
  }
  if (isRootPath(confined)) return true
  try {
    getOrivon().fs.readFileSync(confined)
    return true
  } catch (error) {
    return toNodeError(error).code === 'EISDIR'
  }
}

export const writeFileSync = syncUnsupported('fs.writeFileSync')
export const statSync = syncUnsupported('fs.statSync')
export const mkdirSync = syncUnsupported('fs.mkdirSync')
export const readdirSync = syncUnsupported('fs.readdirSync')
export const rmSync = syncUnsupported('fs.rmSync')
export const renameSync = syncUnsupported('fs.renameSync')
export const accessSync = syncUnsupported('fs.accessSync')
export const appendFileSync = syncUnsupported('fs.appendFileSync')
export const unlinkSync = syncUnsupported('fs.unlinkSync')

export function writeFile (path: PathLike, data: unknown, callback: NodeCallback<void>): void
export function writeFile (path: PathLike, data: unknown, options: WriteFileOptions | string, callback: NodeCallback<void>): void
export function writeFile (path: PathLike, data: unknown, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<WriteFileOptions | string>(args)
  doWriteFile(path, data, encodingOf(options)).then(
    () => callback(null),
    (error) => callback(error as Error)
  )
}

export function appendFile (path: PathLike, data: unknown, callback: NodeCallback<void>): void
export function appendFile (path: PathLike, data: unknown, options: WriteFileOptions | string, callback: NodeCallback<void>): void
export function appendFile (path: PathLike, data: unknown, ...args: readonly unknown[]): void {
  const { options, callback } = splitTail<WriteFileOptions | string>(args)
  doAppendFile(path, data, encodingOf(options)).then(
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

export function readdir (path: PathLike, callback: NodeCallback<readonly string[]>): void
export function readdir (path: PathLike, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  doReaddir(path).then((entries) => callback(null, entries), (error) => callback(error as Error))
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

export function access (path: PathLike, callback: NodeCallback<void>): void
export function access (path: PathLike, mode: number, callback: NodeCallback<void>): void
export function access (path: PathLike, ...args: readonly unknown[]): void {
  const { callback } = splitTail<unknown>(args)
  doAccess(path).then(() => callback(null), (error) => callback(error as Error))
}

export type { NodeStats }

const POSIX_PERMISSION_MEMBERS = new Set(['chmod', 'chmodSync', 'chown', 'chownSync'])

function otherFsMember (prop: string) {
  if (POSIX_PERMISSION_MEMBERS.has(prop)) {
    return refuseShim(
      `fs.${prop}`, 'not-applicable',
      `fs.${prop} sets a POSIX permission/ownership bit -- this shim's confined fs has no uid, ` +
      'gid or mode to set one on (compatibility-matrix.md Table 3).'
    )
  }
  return refuseShim(
    `fs.${prop}`, 'unimplemented',
    `fs.${prop} is real Node fs surface this shim has not implemented and has not decided ` +
    'whether it will -- distinct from the *Sync gaps above, which are a decided, permanent ' +
    'refusal (ADR-0016). See docs/planning/compatibility-matrix.md Table 3.'
  )
}

export default refusingProxy({
  readFile, readFileSync, writeFile, writeFileSync, appendFile, unlink, access,
  mkdir, readdir, stat, rm, rename, open, close, read, write, fstat, ftruncate, fsync, promises,
  createReadStream, createWriteStream,
  statSync, mkdirSync, readdirSync, rmSync, renameSync, existsSync, accessSync, appendFileSync, unlinkSync,
  // fs.constants is data (POSIX flag numbers), not a function -- a
  // throwing-function refusal (A169) would misreport its own type, so this
  // is a real object rather than routed through otherFsMember.
  constants: FS_CONSTANTS
}, otherFsMember)
