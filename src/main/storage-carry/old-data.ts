// What the partition an app used to run in holds on disk, read from its folder without opening the session: asking
// `session.fromPartition` for a partition that is not open makes it, and a folder is all that is needed to know whether
// the carry has anything to read.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { partitionFor } from '../../broker/grants/origin-hash.js'

/** The size of a LevelDB log with nothing written to it: the header Chromium leaves in the log a session opens. */
const EMPTY_LOG_BYTES = 30

/** The folder Electron keeps the partition `partitionFor(origin)` names in. */
export function oldPartitionDirectory (userDataPath: string, origin: string): string {
  return join(userDataPath, 'Partitions', partitionFor(origin).replace(/^persist:/, ''))
}

function entriesOf (directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function sizeOf (path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Whether a LevelDB folder holds a record: a table file, or a log with more than its header. */
function levelDbHoldsRecords (directory: string): boolean {
  return entriesOf(directory).some((name) => /\.(ldb|sst)$/.test(name) || (name.endsWith('.log') && sizeOf(join(directory, name)) > EMPTY_LOG_BYTES))
}

export type StorageKind = 'cookies' | 'local storage' | 'databases'

/**
 * The kinds of storage the partition's folder shows data in. A cookie file exists once a cookie was stored, a database
 * folder once a database was opened, and a LevelDB log is longer than its header once an item was written. Each test is the
 * weakest sign that data was ever written, because a wrong "no" leaves a person's data behind while a wrong "yes" costs one
 * carry that finds nothing.
 */
export function storageKindsOnDisk (directory: string): StorageKind[] {
  const kinds: StorageKind[] = []
  if (sizeOf(join(directory, 'Cookies')) > 0 || sizeOf(join(directory, 'Network', 'Cookies')) > 0) kinds.push('cookies')
  if (levelDbHoldsRecords(join(directory, 'Local Storage', 'leveldb'))) kinds.push('local storage')
  if (entriesOf(join(directory, 'IndexedDB')).length > 0) kinds.push('databases')
  return kinds
}

/** What the partition holds that the carry does not move, by the name a log line gives it. */
export function storageNotCarried (directory: string): string[] {
  const named: string[] = []
  if (entriesOf(join(directory, 'Service Worker')).length > 0) named.push('service workers and Cache Storage')
  if (entriesOf(join(directory, 'File System')).length > 0) named.push('files in the private file system')
  return named
}
