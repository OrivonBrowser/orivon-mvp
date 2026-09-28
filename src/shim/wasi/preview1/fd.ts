// The fd_* functions: reading, writing, seeking and describing an open
// descriptor. Directory listing is directory.ts; opening is path.ts.

import type { FileStat } from '../../../contracts/handles.js'
import { type HostContext, filestatOf } from '../context.js'
import { type Op, handleCall, readStdin, writeOutput } from '../effects.js'
import { Errno } from '../errno.js'
import type { FdEntry, FileEntry, StdioEntry } from '../fds.js'
import { Filetype, unsigned } from '../memory.js'
import type { ImportFamily } from './family.js'
import { DIRECTORY_INHERITING, DIRECTORY_RIGHTS, Fdflags, STDIO_RIGHTS, SYNC_FDFLAGS, Whence, fileRights } from './flags.js'

const ADVICE_MAX = 5

function isStdio (entry: FdEntry): entry is StdioEntry {
  return entry.kind === 'stdin' || entry.kind === 'stdout' || entry.kind === 'stderr'
}

/** The errno a call gets on a descriptor it has no meaning for. */
function wrongKind (entry: FdEntry | undefined): number {
  if (entry === undefined) return Errno.BADF
  return isStdio(entry) ? Errno.SPIPE : Errno.BADF
}

function toOffset (value: bigint): number | undefined {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
}

function * readInto (ctx: HostContext, file: FileEntry, position: number, iovsPtr: number, iovsLen: number): Op<number> {
  const iovecs = ctx.memory.iovecs(iovsPtr, iovsLen)
  const length = iovecs.reduce((sum, iov) => sum + iov.len, 0)
  const data = yield * handleCall<Uint8Array>(file.handle, 'read', { position, length })
  return ctx.memory.scatter(iovecs, data)
}

function * writeFrom (ctx: HostContext, file: FileEntry, position: number, iovsPtr: number, iovsLen: number): Op<number> {
  const data = ctx.memory.gather(ctx.memory.iovecs(iovsPtr, iovsLen))
  if (data.length === 0) return 0
  return yield * handleCall<number>(file.handle, 'write', { position, data })
}

function * sizeOf (file: FileEntry): Op<number> {
  return (yield * handleCall<FileStat>(file.handle, 'stat')).size
}

export function fdFunctions (ctx: HostContext): ImportFamily {
  const { fds, memory } = ctx

  const file = (fd: number): FileEntry | undefined => {
    const entry = fds.get(fd)
    return entry?.kind === 'file' ? entry : undefined
  }

  return {
    sync: {
      fd_fdstat_get: (fd: number, ptr: number) => {
        const entry = fds.get(fd)
        if (entry === undefined) return Errno.BADF
        if (isStdio(entry)) {
          memory.fdstat(ptr, { filetype: Filetype.CHARACTER_DEVICE, flags: 0, rightsBase: STDIO_RIGHTS, rightsInheriting: 0n })
        } else if (entry.kind === 'directory') {
          memory.fdstat(ptr, { filetype: Filetype.DIRECTORY, flags: 0, rightsBase: DIRECTORY_RIGHTS, rightsInheriting: DIRECTORY_INHERITING })
        } else {
          memory.fdstat(ptr, { filetype: Filetype.REGULAR_FILE, flags: entry.fdflags, rightsBase: fileRights(entry.readable, entry.writable), rightsInheriting: 0n })
        }
        return Errno.SUCCESS
      },
      fd_fdstat_set_flags: (fd: number, flags: number) => {
        const entry = fds.get(fd)
        if (entry === undefined) return Errno.BADF
        if (entry.kind !== 'file' || (flags & SYNC_FDFLAGS) !== 0) return flags === 0 ? Errno.SUCCESS : Errno.NOTSUP
        entry.fdflags = flags
        return Errno.SUCCESS
      },
      fd_fdstat_set_rights: (fd: number) => fds.get(fd) === undefined ? Errno.BADF : Errno.NOTSUP,
      fd_tell: (fd: number, ptr: number) => {
        const entry = file(fd)
        if (entry === undefined) return wrongKind(fds.get(fd))
        memory.u64(ptr, BigInt(entry.position))
        return Errno.SUCCESS
      },
      fd_advise: (fd: number, _offset: bigint, _len: bigint, advice: number) => {
        if (file(fd) === undefined) return wrongKind(fds.get(fd))
        return advice > ADVICE_MAX ? Errno.INVAL : Errno.SUCCESS
      },
      fd_renumber: (from: number, to: number) => {
        const entry = fds.get(from)
        const target = fds.get(to)
        if (entry === undefined || target === undefined) return Errno.BADF
        if (from === to) return Errno.SUCCESS
        // dup2 closes the descriptor it replaces and ignores how that close went.
        if (target.kind === 'file') closeQuietly(target.handle)
        fds.set(to, entry)
        fds.remove(from)
        return Errno.SUCCESS
      },
      fd_prestat_get: (fd: number, ptr: number) => {
        const entry = fds.get(fd)
        if (entry?.kind !== 'directory' || entry.preopenName === undefined) return Errno.BADF
        memory.u32(ptr, 0)
        memory.u32(ptr + 4, new TextEncoder().encode(entry.preopenName).length)
        return Errno.SUCCESS
      },
      fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
        const entry = fds.get(fd)
        if (entry?.kind !== 'directory' || entry.preopenName === undefined) return Errno.BADF
        const name = new TextEncoder().encode(entry.preopenName)
        if (unsigned(len) < name.length) return Errno.NAMETOOLONG
        memory.bytes(ptr, name.length).set(name)
        return Errno.SUCCESS
      }
    },

    ops: {
      * fd_read (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) {
        const entry = fds.get(fd)
        if (entry?.kind === 'stdin') {
          const iovecs = memory.iovecs(iovsPtr, iovsLen)
          const chunk = yield * readStdin(iovecs.reduce((sum, iov) => sum + iov.len, 0))
          memory.u32(nreadPtr, memory.scatter(iovecs, chunk))
          return Errno.SUCCESS
        }
        if (entry?.kind === 'directory') return Errno.ISDIR
        if (entry?.kind !== 'file' || !entry.readable) return Errno.BADF
        const read = yield * readInto(ctx, entry, entry.position, iovsPtr, iovsLen)
        entry.position += read
        memory.u32(nreadPtr, read)
        return Errno.SUCCESS
      },
      * fd_pread (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number) {
        const entry = file(fd)
        if (entry === undefined) return fds.get(fd)?.kind === 'directory' ? Errno.ISDIR : wrongKind(fds.get(fd))
        if (!entry.readable) return Errno.BADF
        const position = toOffset(offset)
        if (position === undefined) return Errno.INVAL
        memory.u32(nreadPtr, yield * readInto(ctx, entry, position, iovsPtr, iovsLen))
        return Errno.SUCCESS
      },
      * fd_write (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) {
        const entry = fds.get(fd)
        if (entry?.kind === 'stdout' || entry?.kind === 'stderr') {
          const data = memory.gather(memory.iovecs(iovsPtr, iovsLen))
          yield * writeOutput(entry.kind, data)
          memory.u32(nwrittenPtr, data.length)
          return Errno.SUCCESS
        }
        if (entry?.kind !== 'file' || !entry.writable) return Errno.BADF
        const position = (entry.fdflags & Fdflags.APPEND) !== 0 ? yield * sizeOf(entry) : entry.position
        const written = yield * writeFrom(ctx, entry, position, iovsPtr, iovsLen)
        entry.position = position + written
        memory.u32(nwrittenPtr, written)
        return Errno.SUCCESS
      },
      * fd_pwrite (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number) {
        const entry = file(fd)
        if (entry === undefined) return wrongKind(fds.get(fd))
        if (!entry.writable) return Errno.BADF
        const position = toOffset(offset)
        if (position === undefined) return Errno.INVAL
        memory.u32(nwrittenPtr, yield * writeFrom(ctx, entry, position, iovsPtr, iovsLen))
        return Errno.SUCCESS
      },
      * fd_seek (fd: number, offset: bigint, whence: number, newOffsetPtr: number) {
        const entry = file(fd)
        if (entry === undefined) return wrongKind(fds.get(fd))
        let base: number
        if (whence === Whence.SET) base = 0
        else if (whence === Whence.CUR) base = entry.position
        else if (whence === Whence.END) base = yield * sizeOf(entry)
        else return Errno.INVAL
        const next = BigInt(base) + offset
        const position = toOffset(next)
        if (position === undefined) return Errno.INVAL
        entry.position = position
        memory.u64(newOffsetPtr, next)
        return Errno.SUCCESS
      },
      * fd_close (fd: number) {
        const entry = fds.remove(fd)
        if (entry === undefined) return Errno.BADF
        if (entry.kind === 'file') yield * handleCall(entry.handle, 'close')
        return Errno.SUCCESS
      },
      fd_sync: (fd: number) => syncDescriptor(fds.get(fd)),
      fd_datasync: (fd: number) => syncDescriptor(fds.get(fd)),
      * fd_filestat_get (fd: number, ptr: number) {
        const entry = fds.get(fd)
        if (entry === undefined) return Errno.BADF
        if (isStdio(entry)) {
          memory.filestat(ptr, { ino: 0n, filetype: Filetype.CHARACTER_DEVICE, size: 0n, mtimNs: 0n })
        } else if (entry.kind === 'directory') {
          memory.filestat(ptr, filestatOf(entry.path, yield * ctx.stat(entry.path)))
        } else if (entry.kind === 'file') {
          memory.filestat(ptr, filestatOf(entry.path, yield * handleCall<FileStat>(entry.handle, 'stat')))
        }
        return Errno.SUCCESS
      },
      * fd_filestat_set_size (fd: number, size: bigint) {
        const entry = file(fd)
        if (entry === undefined) return fds.get(fd)?.kind === 'directory' ? Errno.ISDIR : wrongKind(fds.get(fd))
        const length = toOffset(size)
        if (length === undefined) return Errno.INVAL
        if (!entry.writable) return Errno.BADF
        yield * handleCall(entry.handle, 'truncate', length)
        return Errno.SUCCESS
      },
      * fd_allocate (fd: number, offset: bigint, len: bigint) {
        const entry = file(fd)
        if (entry === undefined) return wrongKind(fds.get(fd))
        const end = toOffset(offset + len)
        if (end === undefined || len <= 0n) return Errno.INVAL
        if (!entry.writable) return Errno.BADF
        if (end > (yield * sizeOf(entry))) yield * handleCall(entry.handle, 'truncate', end)
        return Errno.SUCCESS
      }
    }
  }
}

function * syncDescriptor (entry: FdEntry | undefined): Op<number> {
  if (entry === undefined) return Errno.BADF
  if (entry.kind === 'file') yield * handleCall(entry.handle, 'sync')
  return isStdio(entry) ? Errno.INVAL : Errno.SUCCESS
}

/** Starts a close without waiting for it: an open handle's close returns a promise, a synchronous one's returns once done. */
function closeQuietly (handle: FileEntry['handle']): void {
  try {
    void Promise.resolve(handle.close()).catch(() => {})
  } catch {}
}
