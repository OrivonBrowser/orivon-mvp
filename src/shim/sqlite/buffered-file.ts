// Cuts the synchronous file calls a database costs. SQLite writes a journal
// record as three small writes and a commit as a run of adjacent pages; each
// call is a round trip to the page, so writes that continue where the last one
// ended are merged into one, and a file's size is asked for once. Safe because
// one connection uses a file at a time (vfs.ts): nothing else can write it. The
// VFS writes everything out when a transaction ends, so a commit is in the file
// before it returns; bytes stay pending until a write has succeeded.

import type { SqliteFile } from './files.js'

/** Pending bytes are written out once they reach this many, well under a broker reply's chunk. */
export const WRITE_BUFFER_LIMIT = 256 * 1024

export interface BufferedFile extends SqliteFile {
  /** Writes out what is pending, so a caller can tell a failed write from a failed read. The bytes stay pending when the write throws. */
  flush (): void
}

export function bufferedFile (file: SqliteFile, limit = WRITE_BUFFER_LIMIT): BufferedFile {
  let size: number | undefined
  let start = 0
  let chunks: Uint8Array[] = []
  let length = 0

  const flush = (): void => {
    if (length === 0) return
    const merged = chunks.length === 1 ? chunks[0] as Uint8Array : new Uint8Array(length)
    if (chunks.length > 1) {
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }
    }
    file.write(start, merged)
    chunks = []
    length = 0
  }

  return {
    flush,
    read (position, count) {
      flush()
      return file.read(position, count)
    },
    write (position, data) {
      if (length > 0 && position !== start + length) flush()
      if (length === 0) start = position
      chunks.push(data)
      length += data.length
      if (size !== undefined) size = Math.max(size, position + data.length)
      if (length >= limit) flush()
    },
    size () {
      if (size === undefined) {
        flush()
        size = file.size()
      }
      return size
    },
    truncate (newLength) {
      flush()
      file.truncate(newLength)
      size = newLength
    },
    sync () {
      flush()
      file.sync()
    },
    close () {
      try {
        flush()
      } finally {
        file.close()
      }
    }
  }
}
