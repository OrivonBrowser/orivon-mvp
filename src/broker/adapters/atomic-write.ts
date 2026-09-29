// Every store under src/main/ and src/broker/grants/ that persists a small
// JSON file uses this instead of a bare write, so a crash mid-write leaves
// the previous file intact rather than truncated.

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes `text` to `path` atomically: a temp file in the SAME directory
 * (`renameSync` across filesystems is not atomic, and is sometimes refused
 * outright), fsynced before the rename so the bytes are actually on disk and
 * not just buffered when the rename lands, then renamed over `path`, then
 * the containing directory fsynced so the entry naming those bytes is
 * durable too (`fsyncDirectory` below).
 * POSIX `rename` replaces its target as one atomic operation -- there is no
 * window where a reader sees a partially-written file, only the old
 * complete one or the new complete one.
 *
 * A bare `writeFileSync(path, text)` has no such guarantee: a process that
 * dies mid-write can leave `path` truncated, and the old contents are gone
 * either way. A write that can only ever land whole, or not at all, is what
 * keeps a crash from destroying what was there before.
 */
export function writeFileAtomic (path: string, text: string): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDirectory(dirname(path))
}

/**
 * `writeFileAtomic`'s async twin, for a store built on `node:fs/promises`.
 * Same shape, through one open file handle just as the sync version is
 * through one file descriptor: write the temp file, fsync it, rename it
 * over `path`, fsync the directory.
 */
export async function writeFileAtomicAsync (path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
  await fsyncDirectoryAsync(dirname(path))
}

/**
 * Flushes the DIRECTORY ENTRY the rename above just created. Syncing the
 * file's contents is only half of it: on ext4, XFS and others the entry
 * naming those contents is metadata with its own write-back, so a crash
 * between the rename and the next commit can leave the new file's bytes on
 * disk with nothing pointing at them.
 *
 * BEST EFFORT, deliberately. Windows has no equivalent -- opening a
 * directory as a file fails outright -- and some filesystems refuse fsync on
 * a directory handle. The rename itself has already succeeded by this point,
 * so the only thing lost is durability across a crash in the next few
 * seconds; failing the whole write over that would trade a real, common
 * outcome for a rare one.
 */
function fsyncDirectory (dir: string): void {
  let fd: number
  try {
    fd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // See above: nothing to recover, the data is already renamed into place.
  } finally {
    closeSync(fd)
  }
}

/** `fsyncDirectory`'s async twin, same best-effort contract. */
async function fsyncDirectoryAsync (dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(dir, 'r')
  } catch {
    return
  }
  try {
    await handle.sync()
  } catch {
    // See fsyncDirectory: nothing to recover, the data is already renamed into place.
  } finally {
    await handle.close()
  }
}
