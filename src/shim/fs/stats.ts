// Node's fs.Stats has isFile()/isDirectory() as METHODS and a real `mtime`
// Date; the contract's FileStat (handles.ts) has them as plain booleans and
// a `mtimeMs` number, because the wire format has no reason to carry a
// method. webtorrent's own torrent.js calls `stat.mtime.getTime()` -- a
// plain `mtimeMs` field would not satisfy that caller.

import type { FileStat } from '../../contracts/handles.js'

export interface NodeStats {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly nlink: number
  readonly uid: number
  readonly gid: number
  readonly rdev: number
  readonly size: number
  readonly blksize: number
  readonly blocks: number
  readonly atimeMs: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly birthtimeMs: number
  readonly atime: Date
  readonly mtime: Date
  readonly ctime: Date
  readonly birthtime: Date
  isFile (): boolean
  isDirectory (): boolean
  isSymbolicLink (): boolean
  isBlockDevice (): boolean
  isCharacterDevice (): boolean
  isFIFO (): boolean
  isSocket (): boolean
}

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const BLOCK_SIZE = 4096

/** FNV-1a over the confined path, kept below 2^53 so it stays a safe integer. */
function inodeOf (identity: string): number {
  let high = 0x811c9dc5
  let low = 0x01000193
  for (let i = 0; i < identity.length; i++) {
    high = Math.imul(high ^ identity.charCodeAt(i), 0x01000193)
    low = Math.imul(low + identity.charCodeAt(i), 0x85ebca6b) ^ (high >>> 13)
  }
  return (((high >>> 0) & 0x1fffff) * 0x100000000) + (low >>> 0) || 1
}

/**
 * `identity` is the confined path the stat was taken of: two stats of one path
 * agree on `ino`, and two paths differ. orivon.fs reports only size, kind and
 * mtime, so every other field is a fixed, plausible answer (README.md's Design
 * notes has the list) and atime, ctime and birthtime all follow mtime.
 */
export function toNodeStats (stat: FileStat, identity = ''): NodeStats {
  const mtime = () => new Date(stat.mtimeMs)
  return {
    dev: 1,
    ino: inodeOf(identity),
    mode: stat.isDirectory ? S_IFDIR | 0o755 : S_IFREG | 0o644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: stat.size,
    blksize: BLOCK_SIZE,
    blocks: Math.ceil(stat.size / BLOCK_SIZE) * (BLOCK_SIZE / 512),
    atimeMs: stat.mtimeMs,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.mtimeMs,
    birthtimeMs: stat.mtimeMs,
    atime: mtime(),
    mtime: mtime(),
    ctime: mtime(),
    birthtime: mtime(),
    isFile: () => stat.isFile,
    isDirectory: () => stat.isDirectory,
    // orivon.fs never reports a symlink as its own kind (handle-contracts.md's
    // FileHandle section: symlinks that would escape confinement are denied
    // before any access, and one that does not escape resolves transparently
    // to whatever it points at) -- so this is always false, never absent.
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  }
}

/**
 * `readdir(path, { withFileTypes: true })`'s entries. orivon.fs.readdir
 * returns names only, so the kind comes from a stat per entry; an entry that
 * vanished between the two calls reads as neither file nor directory.
 */
export class NodeDirent {
  readonly name: string
  readonly parentPath: string
  /** Node's older name for parentPath, still read by ported code. */
  readonly path: string
  private readonly stat: FileStat | undefined

  constructor (name: string, parentPath: string, stat: FileStat | undefined) {
    this.name = name
    this.parentPath = parentPath
    this.path = parentPath
    this.stat = stat
  }

  isFile (): boolean { return this.stat?.isFile === true }
  isDirectory (): boolean { return this.stat?.isDirectory === true }
  isSymbolicLink (): boolean { return false }
  isBlockDevice (): boolean { return false }
  isCharacterDevice (): boolean { return false }
  isFIFO (): boolean { return false }
  isSocket (): boolean { return false }
}
