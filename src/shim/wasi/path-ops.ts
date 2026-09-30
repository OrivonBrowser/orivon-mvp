// What each path call does once its path is resolved, shared by the
// preview1 functions (preview1/path.ts) and the WASI 0.2 filesystem
// (../wasi-p2/filesystem.ts), so both refuse the same things the same way.
// Each is an effect generator run by drivers.ts; a refusal throws the
// PathError whose errno the call reports.

import type { FileStat } from '../../contracts/handles.js'
import { isRootPath } from '../fs/root.js'
import type { HostContext } from './context.js'
import { type Op, fsCall } from './effects.js'
import { Errno } from './errno.js'
import { type FileEntry, PathError, type ResolvedPath } from './fds.js'

export interface OpenIntent {
  readonly read: boolean
  readonly write: boolean
  readonly creat: boolean
  readonly excl: boolean
  readonly trunc: boolean
}

export type Opened = { readonly kind: 'directory' } | { readonly kind: 'file', readonly handle: FileEntry['handle'] }

/** A name that refers to a regular file but was written with a trailing slash. */
function assertTrailingSlashFits (resolved: ResolvedPath, stat: FileStat | undefined): void {
  if (resolved.trailingSlash && stat !== undefined && !stat.isDirectory) throw new PathError(Errno.NOTDIR)
}

function refuseRoot (resolved: ResolvedPath, errno: number): void {
  if (isRootPath(resolved.path)) throw new PathError(errno)
}

/**
 * The Node flags string orivon.fs.open takes. A file that exists and is not
 * truncated never gets a `w` flag (which would empty it), and one being
 * created always gets `x`, so two programs cannot both create it.
 */
export function openFlags (intent: OpenIntent, exists: boolean): string {
  if (!exists) return intent.read || !intent.write ? 'wx+' : 'wx'
  if (intent.trunc) return intent.read ? 'w+' : 'w'
  return intent.write ? 'r+' : 'r'
}

/**
 * Opens with the flags `openFlags` picks. A file that appeared between the
 * `stat` and a create without EXCL is simply opened: the program asked for
 * O_CREAT, not O_EXCL, so it must not see EEXIST.
 */
function * openFile (path: string, intent: OpenIntent, exists: boolean): Op<FileEntry['handle']> {
  try {
    return yield * fsCall<FileEntry['handle']>('open', path, openFlags(intent, exists))
  } catch (error) {
    const raced = !exists && !intent.excl && (error as { code?: unknown } | null)?.code === 'exists'
    if (!raced) throw error
    return yield * fsCall<FileEntry['handle']>('open', path, openFlags({ ...intent, trunc: false }, true))
  }
}

export function * openPath (ctx: HostContext, resolved: ResolvedPath, intent: OpenIntent, wantsDirectory: boolean): Op<Opened> {
  const existing = yield * ctx.statIfExists(resolved.path)
  assertTrailingSlashFits(resolved, existing)
  if (intent.creat && intent.excl && existing !== undefined) throw new PathError(Errno.EXIST)
  if (existing?.isDirectory === true) {
    if (intent.write) throw new PathError(Errno.ISDIR)
    return { kind: 'directory' }
  }
  if (wantsDirectory) throw new PathError(existing === undefined ? Errno.NOENT : Errno.NOTDIR)
  if (existing === undefined && !intent.creat) throw new PathError(Errno.NOENT)
  if (existing === undefined && resolved.trailingSlash) throw new PathError(Errno.ISDIR)
  return { kind: 'file', handle: yield * openFile(resolved.path, intent, existing !== undefined) }
}

export function * statPath (ctx: HostContext, resolved: ResolvedPath): Op<FileStat> {
  const stat = yield * ctx.stat(resolved.path)
  assertTrailingSlashFits(resolved, stat)
  return stat
}

export function * createDirectory (resolved: ResolvedPath): Op<void> {
  refuseRoot(resolved, Errno.EXIST)
  yield * fsCall('mkdir', resolved.path)
}

export function * removeDirectory (ctx: HostContext, resolved: ResolvedPath): Op<void> {
  refuseRoot(resolved, Errno.INVAL)
  const stat = yield * ctx.stat(resolved.path)
  if (!stat.isDirectory) throw new PathError(Errno.NOTDIR)
  const entries = yield * fsCall<readonly string[]>('readdir', resolved.path)
  if (entries.length > 0) throw new PathError(Errno.NOTEMPTY)
  // orivon.fs.rm is Node's fs.rm, which refuses any directory without
  // `recursive`; emptiness was checked above, as rmdir requires.
  yield * fsCall('rm', resolved.path, { recursive: true })
}

export function * unlinkFile (ctx: HostContext, resolved: ResolvedPath): Op<void> {
  refuseRoot(resolved, Errno.ISDIR)
  const stat = yield * ctx.stat(resolved.path)
  if (stat.isDirectory) throw new PathError(Errno.ISDIR)
  assertTrailingSlashFits(resolved, stat)
  yield * fsCall('rm', resolved.path)
}

export function * renamePath (ctx: HostContext, from: ResolvedPath, to: ResolvedPath): Op<void> {
  refuseRoot(from, Errno.ACCES)
  refuseRoot(to, Errno.ACCES)
  const source = yield * ctx.stat(from.path)
  assertTrailingSlashFits(from, source)
  if (to.trailingSlash && !source.isDirectory) throw new PathError(Errno.NOTDIR)
  yield * fsCall('rename', from.path, to.path)
}

/** orivon.fs has no symbolic links, so an existing name is never one: POSIX's EINVAL. */
export function * readlink (ctx: HostContext, resolved: ResolvedPath): Op<never> {
  yield * ctx.stat(resolved.path)
  throw new PathError(Errno.INVAL)
}
