// The decisions behind holding a file that runs code: which downloads are held, what the temporary file is
// called, where Keep puts the file, and what a restart makes of a held list. Pure: the service does the I/O.
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDangerousFile } from './dangerous-file.js'
import { isActive, uniquePath } from './download-model.js'
import type { DownloadEntry } from './download-types.js'

/** A held file is written under this name in the downloads folder, so a dangerous file never sits there under its real one. */
export function holdPath (folder: string, id: string): string {
  return join(folder, `Unconfirmed ${id}.download`)
}

const HOLD_NAME = /^Unconfirmed [\w-]{1,64}\.download$/u

/** Whether `path` is shaped like a hold file: an absolute path ending in the name `holdPath` gives. The list is read
 * back from disk, so nothing that is not shaped like one is ever deleted or renamed as one. */
export function isHoldPath (path: string): boolean {
  return isAbsolute(path) && HOLD_NAME.test(basename(path))
}

/** With a save dialog the person has just chosen where this file goes and what it is called, so nothing is held. */
export function shouldHold (name: string, mime: string, askWhere: boolean): boolean {
  return !askWhere && isDangerousFile(name, mime)
}

/** Where Keep puts a held file: its own folder, its real name, numbered when that is taken. */
export function keepPath (entry: Pick<DownloadEntry, 'savePath' | 'fileName'>, exists: (path: string) => boolean): string {
  return uniquePath(dirname(entry.savePath), entry.fileName, exists)
}

/** A held entry whose item ended or was overtaken: it is an ordinary entry again, with its temporary file gone. */
export function released (entry: DownloadEntry): DownloadEntry {
  const { held: _held, ...rest } = entry
  return rest
}

export interface Restored {
  readonly entries: DownloadEntry[]
  /** Temporary files nobody will answer for: a held download a previous run left unfinished. */
  readonly leftovers: string[]
  readonly changed: boolean
}

/** The list a run starts with. A download that was running is interrupted ("closed"); a finished held file waits for its answer
 * again, and one whose temporary file is gone has nothing left to answer for. A held entry that does not name a hold file is
 * dropped without touching the disk; one that is held but neither waiting nor running (an interrupted hold) is released and
 * its temporary file listed for deletion, since nobody will answer for it. */
export function restoreEntries (stored: readonly DownloadEntry[], now: number, fileExists: (path: string) => boolean): Restored {
  const leftovers: string[] = []
  let changed = false
  const entries: DownloadEntry[] = []
  for (const entry of stored) {
    if ((entry.held === true || entry.state === 'held') && !isHoldPath(entry.savePath)) { changed = true; continue }
    if (entry.state === 'held' && !fileExists(entry.savePath)) { changed = true; continue }
    if (isActive(entry)) {
      changed = true
      if (entry.held === true) leftovers.push(entry.savePath)
      entries.push({ ...released(entry), state: 'interrupted', reason: 'closed', endedAt: now })
    } else if (entry.held === true && entry.state !== 'held') {
      changed = true
      leftovers.push(entry.savePath)
      entries.push(released(entry))
    } else {
      entries.push(entry)
    }
  }
  return { entries, leftovers, changed }
}
