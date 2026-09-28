// The path_* functions: opening, describing, creating, removing and
// renaming a name under a directory descriptor.

import type { FileHandle, FileStat } from '../../../contracts/handles.js'
import { isRootPath } from '../../fs/root.js'
import { type HostContext, filestatOf } from '../context.js'
import { Errno } from '../errno.js'
import { type DirectoryEntry, PathError, type ResolvedPath, resolveGuestPath } from '../fds.js'
import type { ImportFamily } from './family.js'
import { Oflags, Rights, SYNC_FDFLAGS } from './flags.js'

interface OpenIntent {
  readonly read: boolean
  readonly write: boolean
  readonly creat: boolean
  readonly excl: boolean
  readonly trunc: boolean
}

/** A name that refers to a regular file but was written with a trailing slash. */
function assertTrailingSlashFits (resolved: ResolvedPath, stat: FileStat | undefined): void {
  if (resolved.trailingSlash && stat !== undefined && !stat.isDirectory) throw new PathError(Errno.NOTDIR)
}

/**
 * The Node flags string orivon.fs.open takes. A file that exists and is not
 * truncated never gets a `w` flag (which would empty it), and one being
 * created always gets `x`, so two programs cannot both create it.
 */
function openFlags (intent: OpenIntent, exists: boolean): string {
  if (!exists) return intent.read || !intent.write ? 'wx+' : 'wx'
  if (intent.trunc) return intent.read ? 'w+' : 'w'
  return intent.write ? 'r+' : 'r'
}

/**
 * Opens with the flags `openFlags` picks. A file that appeared between the
 * `stat` and a create without EXCL is simply opened: the program asked for
 * O_CREAT, not O_EXCL, so it must not see EEXIST.
 */
async function openFile (ctx: HostContext, path: string, intent: OpenIntent, exists: boolean): Promise<FileHandle> {
  const closeLate = (handle: FileHandle): void => { void handle.close().catch(() => {}) }
  try {
    return await ctx.fsCall(() => ctx.fs.open(path, openFlags(intent, exists)), closeLate)
  } catch (error) {
    const raced = !exists && !intent.excl && (error as { code?: unknown } | null)?.code === 'exists'
    if (!raced) throw error
    return await ctx.fsCall(() => ctx.fs.open(path, openFlags({ ...intent, trunc: false }, true)), closeLate)
  }
}

export function pathFunctions (ctx: HostContext): ImportFamily {
  const { fds, memory } = ctx

  const resolve = (dirFd: number, pathPtr: number, pathLen: number): ResolvedPath => {
    const dir = fds.get(dirFd)
    if (dir === undefined) throw new PathError(Errno.BADF)
    if (dir.kind !== 'directory') throw new PathError(Errno.NOTDIR)
    return resolveGuestPath(dir, memory.string(pathPtr, pathLen))
  }

  const refuseRoot = (resolved: ResolvedPath, errno: number): void => {
    if (isRootPath(resolved.path)) throw new PathError(errno)
  }

  return {
    sync: {},
    async: {
      path_open: async (dirFd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number,
        rightsBase: bigint, _rightsInheriting: bigint, fdflags: number, openedFdPtr: number) => {
        const resolved = resolve(dirFd, pathPtr, pathLen)
        if ((fdflags & SYNC_FDFLAGS) !== 0) return Errno.NOTSUP
        const trunc = (oflags & Oflags.TRUNC) !== 0
        const write = (rightsBase & Rights.FD_WRITE) !== 0n || trunc
        const intent: OpenIntent = {
          read: (rightsBase & Rights.FD_READ) !== 0n || !write,
          write,
          creat: (oflags & Oflags.CREAT) !== 0,
          excl: (oflags & Oflags.EXCL) !== 0,
          trunc
        }
        const wantsDirectory = (oflags & Oflags.DIRECTORY) !== 0
        const existing = await ctx.statIfExists(resolved.path)
        assertTrailingSlashFits(resolved, existing)
        if (intent.creat && intent.excl && existing !== undefined) return Errno.EXIST
        if (existing?.isDirectory === true) {
          if (intent.write) return Errno.ISDIR
          const entry: DirectoryEntry = { kind: 'directory', path: resolved.path }
          memory.u32(openedFdPtr, fds.add(entry))
          return Errno.SUCCESS
        }
        if (wantsDirectory) return existing === undefined ? Errno.NOENT : Errno.NOTDIR
        if (existing === undefined && !intent.creat) return Errno.NOENT
        if (existing === undefined && resolved.trailingSlash) return Errno.ISDIR
        const handle = await openFile(ctx, resolved.path, intent, existing !== undefined)
        const fd = fds.add({
          kind: 'file',
          path: resolved.path,
          handle,
          readable: intent.read,
          writable: intent.write,
          fdflags,
          position: 0
        })
        memory.u32(openedFdPtr, fd)
        return Errno.SUCCESS
      },
      path_filestat_get: async (dirFd: number, _flags: number, pathPtr: number, pathLen: number, bufPtr: number) => {
        const resolved = resolve(dirFd, pathPtr, pathLen)
        const stat = await ctx.stat(resolved.path)
        assertTrailingSlashFits(resolved, stat)
        memory.filestat(bufPtr, filestatOf(resolved.path, stat))
        return Errno.SUCCESS
      },
      path_create_directory: async (dirFd: number, pathPtr: number, pathLen: number) => {
        const resolved = resolve(dirFd, pathPtr, pathLen)
        refuseRoot(resolved, Errno.EXIST)
        await ctx.fsCall(() => ctx.fs.mkdir(resolved.path))
        return Errno.SUCCESS
      },
      path_remove_directory: async (dirFd: number, pathPtr: number, pathLen: number) => {
        const resolved = resolve(dirFd, pathPtr, pathLen)
        refuseRoot(resolved, Errno.INVAL)
        const stat = await ctx.stat(resolved.path)
        if (!stat.isDirectory) return Errno.NOTDIR
        const entries = await ctx.fsCall(() => ctx.fs.readdir(resolved.path))
        if (entries.length > 0) return Errno.NOTEMPTY
        // orivon.fs.rm is Node's fs.rm, which refuses any directory without
        // `recursive`; emptiness was checked above, as rmdir requires.
        await ctx.fsCall(() => ctx.fs.rm(resolved.path, { recursive: true }))
        return Errno.SUCCESS
      },
      path_unlink_file: async (dirFd: number, pathPtr: number, pathLen: number) => {
        const resolved = resolve(dirFd, pathPtr, pathLen)
        refuseRoot(resolved, Errno.ISDIR)
        const stat = await ctx.stat(resolved.path)
        if (stat.isDirectory) return Errno.ISDIR
        assertTrailingSlashFits(resolved, stat)
        await ctx.fsCall(() => ctx.fs.rm(resolved.path))
        return Errno.SUCCESS
      },
      path_rename: async (oldFd: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) => {
        const from = resolve(oldFd, oldPtr, oldLen)
        const to = resolve(newFd, newPtr, newLen)
        refuseRoot(from, Errno.ACCES)
        refuseRoot(to, Errno.ACCES)
        const source = await ctx.stat(from.path)
        assertTrailingSlashFits(from, source)
        if (to.trailingSlash && !source.isDirectory) return Errno.NOTDIR
        await ctx.fsCall(() => ctx.fs.rename(from.path, to.path))
        return Errno.SUCCESS
      },
      path_readlink: async (dirFd: number, pathPtr: number, pathLen: number) => {
        // orivon.fs has no symbolic links, so an existing name is never one: POSIX's EINVAL.
        await ctx.stat(resolve(dirFd, pathPtr, pathLen).path)
        return Errno.INVAL
      }
    }
  }
}
