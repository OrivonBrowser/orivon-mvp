// fs.promises -- built on node-fs-core.ts's SAME async core node-fs.ts's
// callback family uses (code-guidelines.md Rule 3), plus fs.promises.open
// (node-fs-handle.ts, already built). `constants` mirrors real Node, which
// exposes the identical object at both `fs.constants` and
// `fs.promises.constants`.

import { openHandle } from './node-fs-handle.js'
import {
  doAccess, doAppendFile, doMkdir, doReaddir, doReadFile, doRename, doRm, doStat, doUnlink, doWriteFile,
  type MkdirOptions, type ReadFileOptions, type RmOptions, type WriteFileOptions
} from './node-fs-core.js'
import type { NodeStats } from './node-fs-stats.js'
import { FS_CONSTANTS } from './node-fs-constants.js'
import { refusingProxy } from './unimplemented.js'
import { refuseShim } from './errors.js'

function encodingOf (options: ReadFileOptions | WriteFileOptions | string | undefined): string | undefined {
  return typeof options === 'string' ? options : options?.encoding
}

async function readFile (path: string, options?: ReadFileOptions | string): Promise<Uint8Array | string> {
  return await doReadFile(path, encodingOf(options))
}

async function writeFile (path: string, data: unknown, options?: WriteFileOptions | string): Promise<void> {
  await doWriteFile(path, data, encodingOf(options))
}

async function appendFile (path: string, data: unknown, options?: WriteFileOptions | string): Promise<void> {
  await doAppendFile(path, data, encodingOf(options))
}

async function mkdir (path: string, opts?: MkdirOptions): Promise<void> {
  await doMkdir(path, opts)
}

async function readdir (path: string): Promise<readonly string[]> {
  return await doReaddir(path)
}

async function stat (path: string): Promise<NodeStats> {
  return await doStat(path)
}

async function rm (path: string, opts?: RmOptions): Promise<void> {
  await doRm(path, opts)
}

async function rename (from: string, to: string): Promise<void> {
  await doRename(from, to)
}

async function unlink (path: string): Promise<void> {
  await doUnlink(path)
}

/** `mode` is accepted for Node signature parity; doAccess's own header says why it cannot be distinguished. */
async function access (path: string, _mode?: number): Promise<void> {
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
