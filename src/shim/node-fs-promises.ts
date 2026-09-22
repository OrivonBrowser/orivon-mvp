// fs.promises -- built on node-fs-core.ts's SAME async core node-fs.ts's
// callback family uses (code-guidelines.md Rule 3), plus fs.promises.open
// (node-fs-handle.ts, already built). `constants` mirrors real Node, which
// exposes the identical object at both `fs.constants` and
// `fs.promises.constants`.

import { openHandle } from './node-fs-handle.js'
import {
  doAccess, doAppendFile, doMkdir, doReaddir, doReadFile, doRename, doRm, doStat, doUnlink, doWriteFile,
  type MkdirOptions, type ReaddirOptions, type ReadFileOptions, type RmOptions, type WriteFileOptions
} from './node-fs-core.js'
import type { NodeDirent, NodeStats } from './node-fs-stats.js'
import { FS_CONSTANTS } from './node-fs-constants.js'
import { encodingOf } from './node-fs-encoding.js'
import type { PathLike } from './node-fs-path.js'
import { refusingProxy } from './unimplemented.js'
import { refuseShim } from './errors.js'


async function readFile (path: PathLike, options?: ReadFileOptions | string): Promise<Uint8Array | string> {
  return await doReadFile(path, encodingOf(options))
}

async function writeFile (path: PathLike, data: unknown, options?: WriteFileOptions | string): Promise<void> {
  await doWriteFile(path, data, options)
}

async function appendFile (path: PathLike, data: unknown, options?: WriteFileOptions | string): Promise<void> {
  await doAppendFile(path, data, options)
}

async function mkdir (path: PathLike, opts?: MkdirOptions): Promise<void> {
  await doMkdir(path, opts)
}

async function readdir (path: PathLike, options: ReaddirOptions & { withFileTypes: true }): Promise<readonly NodeDirent[]>
async function readdir (path: PathLike, options: ReaddirOptions & { encoding: 'buffer' }): Promise<readonly Uint8Array[]>
async function readdir (path: PathLike, options?: ReaddirOptions | string | null): Promise<readonly string[]>
async function readdir (path: PathLike, options?: ReaddirOptions | string | null): Promise<ReadonlyArray<string | Uint8Array | NodeDirent>> {
  return await doReaddir(path, options)
}

async function stat (path: PathLike): Promise<NodeStats> {
  return await doStat(path)
}

async function rm (path: PathLike, opts?: RmOptions): Promise<void> {
  await doRm(path, opts)
}

async function rename (from: PathLike, to: PathLike): Promise<void> {
  await doRename(from, to)
}

async function unlink (path: PathLike): Promise<void> {
  await doUnlink(path)
}

/** `mode` is accepted for Node signature parity; doAccess's own header says why it cannot be distinguished. */
async function access (path: PathLike, _mode?: number): Promise<void> {
  await doAccess(path)
}

function otherFsPromisesMember (prop: string) {
  return refuseShim(
    `fs.promises.${prop}`, 'unimplemented',
    `fs.promises.${prop} is real Node fs surface this shim has not implemented and has not ` +
    'decided whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  )
}

export const promises = refusingProxy({
  open: openHandle,
  access,
  readFile,
  writeFile,
  appendFile,
  rename,
  unlink,
  mkdir,
  readdir,
  stat,
  rm,
  // Data, not a function -- same A169 exception node-fs.ts's own `known`
  // object documents for the top-level fs.constants.
  constants: FS_CONSTANTS
}, otherFsPromisesMember)

// The `fs/promises` module target (module-map.ts) is this file itself: the
// same object as fs.promises, as default export and as named members.
export { openHandle as open, access, readFile, writeFile, appendFile, rename, unlink, mkdir, readdir, stat, rm }
export const constants = FS_CONSTANTS
export default promises
