// The program's descriptor table, and how a guest path relative to one of
// its directory descriptors becomes the confined path orivon.fs takes.

import { normalize } from 'path'
import type { FileHandle } from '../../contracts/handles.js'
import { Errno } from './errno.js'

export interface StdioEntry {
  readonly kind: 'stdin' | 'stdout' | 'stderr'
}

export interface DirectoryEntry {
  readonly kind: 'directory'
  /** Confined path: `.` is the app's files root. */
  readonly path: string
  /** Set on a preopen: the guest name fd_prestat_dir_name reports. */
  readonly preopenName?: string
  /** fd_readdir's snapshot, taken when a read starts at cookie 0. */
  listing?: readonly ListingEntry[]
}

export interface FileEntry {
  readonly kind: 'file'
  readonly path: string
  readonly handle: FileHandle
  readonly readable: boolean
  readonly writable: boolean
  /** preview1 fdflags; APPEND is the one that changes what a write does. */
  fdflags: number
  position: number
}

export type FdEntry = StdioEntry | DirectoryEntry | FileEntry

export interface ListingEntry {
  readonly name: string
  readonly filetype: number
  readonly ino: bigint
}

/** Thrown with the errno a path_* call returns. */
export class PathError extends Error {
  readonly errno: number

  constructor (errno: number) {
    super(`WASI path error ${errno}`)
    this.errno = errno
  }
}

export class FdTable {
  readonly #entries = new Map<number, FdEntry>()

  get (fd: number): FdEntry | undefined {
    return this.#entries.get(fd)
  }

  /** The lowest free descriptor, as POSIX allocates. */
  add (entry: FdEntry): number {
    let fd = 0
    while (this.#entries.has(fd)) fd++
    this.#entries.set(fd, entry)
    return fd
  }

  set (fd: number, entry: FdEntry): void {
    this.#entries.set(fd, entry)
  }

  remove (fd: number): FdEntry | undefined {
    const entry = this.#entries.get(fd)
    this.#entries.delete(fd)
    return entry
  }

  values (): IterableIterator<FdEntry> {
    return this.#entries.values()
  }
}

export interface ResolvedPath {
  readonly path: string
  /** `dir/` names a directory; a regular file there is ENOTDIR. */
  readonly trailingSlash: boolean
}

/**
 * Joins `guestPath` onto `dir`. A path that is absolute, or climbs above
 * `dir` itself, is NOTCAPABLE before any call: a directory descriptor is a
 * capability for what is under it, not for its parent. The broker still
 * confines every path (T1); this check only chooses the errno.
 */
export function resolveGuestPath (dir: DirectoryEntry, guestPath: string): ResolvedPath {
  if (guestPath.length === 0) throw new PathError(Errno.NOENT)
  if (guestPath.includes('\0')) throw new PathError(Errno.INVAL)
  if (guestPath.startsWith('/')) throw new PathError(Errno.NOTCAPABLE)
  const relative = normalize(guestPath).replace(/\/+$/, '') || '.'
  if (relative === '..' || relative.startsWith('../')) throw new PathError(Errno.NOTCAPABLE)
  const joined = dir.path === '.' ? relative : normalize(`${dir.path}/${relative}`).replace(/\/+$/, '')
  return { path: joined === '' ? '.' : joined, trailingSlash: guestPath.endsWith('/') }
}

/**
 * orivon.fs has no inodes, so one is derived from the confined path: stable
 * for as long as the file keeps its name, which is what a program comparing
 * `stat` against `fstat` needs. FNV-1a, 64-bit.
 */
export function inodeFor (path: string): bigint {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < path.length; i++) {
    hash ^= BigInt(path.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash
}
