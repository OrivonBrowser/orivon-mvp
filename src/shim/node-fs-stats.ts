// Node's fs.Stats has isFile()/isDirectory() as METHODS and a real `mtime`
// Date; the contract's FileStat (handles.ts) has them as plain booleans and
// a `mtimeMs` number, because the wire format has no reason to carry a
// method. webtorrent's own torrent.js calls `stat.mtime.getTime()` -- a
// plain `mtimeMs` field would not satisfy that caller.

import type { FileStat } from '../contracts/handles.js'

export interface NodeStats {
  readonly size: number
  readonly mtimeMs: number
  readonly mtime: Date
  isFile (): boolean
  isDirectory (): boolean
  isSymbolicLink (): boolean
}

export function toNodeStats (stat: FileStat): NodeStats {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: new Date(stat.mtimeMs),
    isFile: () => stat.isFile,
    isDirectory: () => stat.isDirectory,
    // orivon.fs never reports a symlink as its own kind (handle-contracts.md's
    // FileHandle section: symlinks that would escape confinement are denied
    // before any access, and one that does not escape resolves transparently
    // to whatever it points at) -- so this is always false, never absent.
    isSymbolicLink: () => false
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
