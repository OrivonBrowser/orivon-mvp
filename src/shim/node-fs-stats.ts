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
