// The async core of `copyFile`, `cp` and `mkdtemp` (callback and promise forms alike), composed from core.ts's
// stat, readdir, readFile, writeFile and mkdir. Each of those answers a stand-in path from its pick and every
// other path from the app's own files, so a copy or a temp folder reaches exactly what a read and a write
// would, and between the two places too. README.md's Design notes, "Copying and temp folders", has the limits.

import { join, dirname, isAbsolute, normalize } from 'path/posix'
import { Buffer } from 'buffer'
import { doMkdir, doReaddir, doReadFile, doStat, doWriteFile } from './core.js'
import { randomSuffix } from './core-sync.js'
import { fsError, pathText, type NodeFsError, type PathLike } from './paths.js'
import { encodingOf } from '../encoding.js'
import { invalidArgType, invalidOption, outOfRangeError } from '../arg-errors.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import type { NodeStats } from './stats.js'

/** `COPYFILE_EXCL`: fail with EEXIST when the destination exists. The other copy modes (clone) only ask for a speed-up and change nothing here. */
const COPYFILE_EXCL = 1
const MKDTEMP_ATTEMPTS = 10

export interface CpOptions {
  recursive?: boolean
  force?: boolean
  errorOnExist?: boolean
  filter?: (source: string, destination: string) => boolean | Promise<boolean>
  mode?: number
  dereference?: boolean
  preserveTimestamps?: boolean
  verbatimSymlinks?: boolean
}

/** Node's SystemError for `cp`: `code` is the ERR_FS_* name, `errno` the positive system number it reports. */
function cpError (code: string, title: string, errnoName: string, errno: number, detail: string, path: string): Error {
  return Object.assign(new Error(`${title}: cp returned ${errnoName} (${detail})`), { code, errno, syscall: 'cp', path })
}

function copyfileError (code: string, description: string, from: string, to: string): NodeFsError {
  return fsError(code, description, 'copyfile', from, to)
}

/** Where `path` sits in the app's virtual root, so a relative and an absolute spelling of one place compare equal. */
function placeOf (path: string): string {
  return normalize(isAbsolute(path) ? path : join(VIRTUAL_ROOT, path)).replace(/(.)\/+$/, '$1')
}

async function statIfExists (path: string): Promise<NodeStats | undefined> {
  try {
    return await doStat(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

async function copyBytes (from: string, to: string): Promise<void> {
  await doWriteFile(to, await doReadFile(from, null), undefined)
}

function copyFileMode (mode: unknown): number {
  if (mode === undefined) return 0
  if (typeof mode !== 'number') throw invalidArgType('mode', 'of type number', mode)
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) throw outOfRangeError('mode', '>= 0 && <= 7', mode)
  return mode
}

/** The whole file is read, then written: not atomic, and a file larger than memory cannot be copied. A directory source is EISDIR. */
export async function doCopyFile (src: PathLike, dest: PathLike, mode?: number): Promise<void> {
  const from = pathText(src)
  const to = pathText(dest)
  const flags = copyFileMode(mode)
  if ((await doStat(from)).isDirectory()) throw copyfileError('EISDIR', 'illegal operation on a directory', from, to)
  const existing = await statIfExists(to)
  if (existing?.isDirectory() === true) throw copyfileError('EISDIR', 'illegal operation on a directory', from, to)
  if (existing !== undefined && (flags & COPYFILE_EXCL) !== 0) throw copyfileError('EEXIST', 'file already exists', from, to)
  await copyBytes(from, to)
}

function flag (options: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = options[name]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalidOption(name, 'of type boolean', value)
  return value
}

interface ResolvedCpOptions {
  readonly recursive: boolean
  readonly force: boolean
  readonly errorOnExist: boolean
  readonly filter: CpOptions['filter'] | undefined
  readonly mode: number | undefined
}

function cpOptions (options: unknown): ResolvedCpOptions {
  if (options === undefined || options === null) return { recursive: false, force: true, errorOnExist: false, filter: undefined, mode: undefined }
  if (typeof options !== 'object') throw invalidArgType('options', 'of type object', options)
  const record = options as Record<string, unknown>
  const { filter } = record
  if (filter !== undefined && typeof filter !== 'function') throw invalidOption('filter', 'of type function', filter)
  return {
    recursive: flag(record, 'recursive', false),
    force: flag(record, 'force', true),
    errorOnExist: flag(record, 'errorOnExist', false),
    filter: filter as CpOptions['filter'],
    mode: record.mode === undefined ? undefined : copyFileMode(record.mode)
  }
}

/**
 * One file or folder, and what is under it. The checks are Node's, made before anything is written: a folder over a
 * file or a file over a folder, a path onto itself, a folder into its own subfolder. `filter` is asked for every
 * entry, the first included. Times (`preserveTimestamps`), links and `dereference` have nothing to act on here.
 */
async function copyEntry (from: string, to: string, source: NodeStats, opts: ResolvedCpOptions, parentExists = false): Promise<void> {
  const existing = await statIfExists(to)
  if (existing !== undefined) {
    if (placeOf(from) === placeOf(to)) throw cpError('ERR_FS_CP_EINVAL', 'Invalid src or dest', 'EINVAL', 22, 'src and dest cannot be the same', to)
    if (source.isDirectory() && !existing.isDirectory()) {
      throw cpError('ERR_FS_CP_DIR_TO_NON_DIR', 'Cannot overwrite non-directory with directory', 'EISDIR', 21, `cannot overwrite non-directory ${to} with directory ${from}`, to)
    }
    if (!source.isDirectory() && existing.isDirectory()) {
      throw cpError('ERR_FS_CP_NON_DIR_TO_DIR', 'Cannot overwrite directory with non-directory', 'ENOTDIR', 20, `cannot overwrite directory ${to} with non-directory ${from}`, to)
    }
  }
  if (source.isDirectory() && placeOf(to).startsWith(`${placeOf(from)}/`)) {
    throw cpError('ERR_FS_CP_EINVAL', 'Invalid src or dest', 'EINVAL', 22, `cannot copy ${from} to a subdirectory of self ${to}`, to)
  }
  if (opts.filter !== undefined && !(await opts.filter(from, to))) return
  if (source.isDirectory()) {
    if (!opts.recursive) throw cpError('ERR_FS_EISDIR', 'Path is a directory', 'EISDIR', 21, `${from} is a directory (not copied)`, from)
    await doMkdir(to, { recursive: true })
    for (const name of await doReaddir(from, undefined) as string[]) {
      await copyEntry(join(from, name), join(to, name), await doStat(join(from, name)), opts, true)
    }
    return
  }
  if (existing !== undefined) {
    if (opts.mode !== undefined && (opts.mode & COPYFILE_EXCL) !== 0) throw copyfileError('EEXIST', 'file already exists', from, to)
    if (!opts.force) {
      if (opts.errorOnExist) throw cpError('ERR_FS_CP_EEXIST', 'Target already exists', 'EEXIST', 17, `${to} already exists`, to)
      return
    }
  } else if (!parentExists) {
    await doMkdir(dirname(to), { recursive: true })
  }
  await copyBytes(from, to)
}

export async function doCp (src: PathLike, dest: PathLike, options?: CpOptions | null): Promise<void> {
  const opts = cpOptions(options)
  const from = pathText(src)
  await copyEntry(from, pathText(dest), await doStat(from), opts)
}

/** `prefix` plus twelve random characters, made as a new folder; a name already taken is redrawn. The parent must exist (ENOENT otherwise), as in Node. */
export async function doMkdtemp (prefix: PathLike, options?: { encoding?: string | null } | string | null): Promise<string | Buffer> {
  if (typeof prefix !== 'string' && !(prefix instanceof Uint8Array) && !(prefix instanceof URL)) {
    throw invalidArgType('prefix', 'of type string or an instance of Buffer or URL', prefix)
  }
  const text = pathText(prefix)
  for (let attempt = 0; attempt < MKDTEMP_ATTEMPTS; attempt++) {
    const path = `${text}${randomSuffix()}`
    try {
      await doMkdir(path, undefined)
      return encodingOf(options) === 'buffer' ? Buffer.from(path) : path
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
  }
  throw fsError('EEXIST', 'file already exists', 'mkdtemp', `${text}XXXXXX`)
}
