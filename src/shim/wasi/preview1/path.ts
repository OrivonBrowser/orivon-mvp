// The path_* functions: opening, describing, creating, removing and
// renaming a name under a directory descriptor. What each does once its path
// is resolved is ../path-ops.ts, shared with the WASI 0.2 filesystem.

import { type HostContext, filestatOf } from '../context.js'
import { Errno } from '../errno.js'
import { PathError, type ResolvedPath, resolveGuestPath } from '../fds.js'
import { type OpenIntent, createDirectory, openPath, readlink, removeDirectory, renamePath, statPath, unlinkFile } from '../path-ops.js'
import type { ImportFamily } from './family.js'
import { Oflags, Rights, SYNC_FDFLAGS } from './flags.js'

export function pathFunctions (ctx: HostContext): ImportFamily {
  const { fds, memory } = ctx

  const resolve = (dirFd: number, pathPtr: number, pathLen: number): ResolvedPath => {
    const dir = fds.get(dirFd)
    if (dir === undefined) throw new PathError(Errno.BADF)
    if (dir.kind !== 'directory') throw new PathError(Errno.NOTDIR)
    return resolveGuestPath(dir, memory.string(pathPtr, pathLen))
  }

  return {
    sync: {},
    ops: {
      * path_open (dirFd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number,
        rightsBase: bigint, _rightsInheriting: bigint, fdflags: number, openedFdPtr: number) {
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
        const opened = yield * openPath(ctx, resolved, intent, (oflags & Oflags.DIRECTORY) !== 0)
        memory.u32(openedFdPtr, fds.add(opened.kind === 'directory'
          ? { kind: 'directory', path: resolved.path }
          : { kind: 'file', path: resolved.path, handle: opened.handle, readable: intent.read, writable: intent.write, fdflags, position: 0 }))
        return Errno.SUCCESS
      },
      * path_filestat_get (dirFd: number, _flags: number, pathPtr: number, pathLen: number, bufPtr: number) {
        const resolved = resolve(dirFd, pathPtr, pathLen)
        memory.filestat(bufPtr, filestatOf(resolved.path, yield * statPath(ctx, resolved)))
        return Errno.SUCCESS
      },
      * path_create_directory (dirFd: number, pathPtr: number, pathLen: number) {
        yield * createDirectory(resolve(dirFd, pathPtr, pathLen))
        return Errno.SUCCESS
      },
      * path_remove_directory (dirFd: number, pathPtr: number, pathLen: number) {
        yield * removeDirectory(ctx, resolve(dirFd, pathPtr, pathLen))
        return Errno.SUCCESS
      },
      * path_unlink_file (dirFd: number, pathPtr: number, pathLen: number) {
        yield * unlinkFile(ctx, resolve(dirFd, pathPtr, pathLen))
        return Errno.SUCCESS
      },
      * path_rename (oldFd: number, oldPtr: number, oldLen: number, newFd: number, newPtr: number, newLen: number) {
        yield * renamePath(ctx, resolve(oldFd, oldPtr, oldLen), resolve(newFd, newPtr, newLen))
        return Errno.SUCCESS
      },
      * path_readlink (dirFd: number, pathPtr: number, pathLen: number) {
        return yield * readlink(ctx, resolve(dirFd, pathPtr, pathLen))
      }
    }
  }
}
