// fd_readdir: a directory's entries packed as `dirent` records, resumable
// by cookie. The cookie is an index into a snapshot taken at cookie 0.

import { type HostContext, filestatOf } from '../context.js'
import { Errno } from '../errno.js'
import { type DirectoryEntry, type ListingEntry, inodeFor } from '../fds.js'
import { Filetype, encodeDirent, encodeUtf8, unsigned } from '../memory.js'
import type { ImportFamily } from './family.js'

function childPath (dir: DirectoryEntry, name: string): string {
  return dir.path === '.' ? name : `${dir.path}/${name}`
}

/** `.` and `..` first, as POSIX readdir returns them, then one stat per name for its type. */
async function snapshot (ctx: HostContext, dir: DirectoryEntry): Promise<readonly ListingEntry[]> {
  const names = await ctx.fsCall(() => ctx.fs.readdir(dir.path))
  const entries: ListingEntry[] = [
    { name: '.', filetype: Filetype.DIRECTORY, ino: inodeFor(dir.path) },
    { name: '..', filetype: Filetype.DIRECTORY, ino: 0n }
  ]
  for (const name of names) {
    const path = childPath(dir, name)
    const stat = await ctx.statIfExists(path)
    entries.push({ name, filetype: stat === undefined ? Filetype.UNKNOWN : filestatOf(path, stat).filetype, ino: inodeFor(path) })
  }
  return entries
}

export function directoryFunctions (ctx: HostContext): ImportFamily {
  return {
    sync: {},
    async: {
      fd_readdir: async (fd: number, rawBufPtr: number, rawBufLen: number, cookie: bigint, bufUsedPtr: number) => {
        const bufPtr = unsigned(rawBufPtr)
        const bufLen = unsigned(rawBufLen)
        const dir = ctx.fds.get(fd)
        if (dir === undefined) return Errno.BADF
        if (dir.kind !== 'directory') return Errno.NOTDIR
        if (cookie === 0n || dir.listing === undefined) dir.listing = await snapshot(ctx, dir)
        const listing = dir.listing
        // A record cut off by the end of the buffer is still written: filling
        // the buffer exactly is how wasi-libc knows to call again with a larger one.
        let used = 0
        for (let index = Number(cookie); index < listing.length && used < bufLen; index++) {
          const entry = listing[index] as ListingEntry
          const record = encodeDirent(BigInt(index + 1), entry.ino, encodeUtf8(entry.name), entry.filetype)
          const take = Math.min(record.length, bufLen - used)
          ctx.memory.bytes(bufPtr + used, take).set(record.subarray(0, take))
          used += take
        }
        ctx.memory.u32(bufUsedPtr, used)
        return Errno.SUCCESS
      }
    }
  }
}
