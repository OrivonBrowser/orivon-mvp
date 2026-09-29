// A held grant alone puts no origin in its own session partition: a
// granted, network-served app shares the default session instead
// (ADR-0044's own Consequences), and "Clear app data" (../privacy/clear-data.ts)
// only ever reaches a CACHE-SERVED origin's partition. A `persist:app-<hash>`
// partition from before that still holds data is otherwise unreachable
// forever: neither "Clear app data" nor any live session touches it again.
// See README.md's Design notes for the disk-vs-session choice and why this
// runs exactly once.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { session } from 'electron'
import type { Session } from 'electron'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { appRootDirectoryName } from '../../loader/index.js'

const MARKER_FILE = 'orphaned-app-partitions-cleaned.json'
// alreadyCleaned() only honours a marker whose own `version` field matches
// this constant, so raising it makes every earlier marker unrecognised and
// the cleanup runs again under whatever selection rule is current.
const MARKER_VERSION = 2

/**
 * Whether `origin`'s own app directory exists under `<userDataPath>/apps`:
 * 'yes' if a stat succeeds, 'no' for ENOENT (never installed, or installed
 * and later fully removed), 'unreadable' for anything else (a permissions
 * problem, most likely) -- which must never be read as 'no', since that
 * would treat an app this run simply failed to SEE as one that does not
 * exist and clear its partition on that mistaken basis.
 */
function appDirectoryState (userDataPath: string, origin: string): 'yes' | 'no' | 'unreadable' {
  try {
    statSync(join(userDataPath, 'apps', appRootDirectoryName(origin)))
    return 'yes'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no' : 'unreadable'
  }
}

/**
 * Pure selection: every held-grant origin that is NOT cache-served AND has
 * no pin on disk, in the order `apps` gave them. Never derived from
 * scanning `<userData>/Partitions/` -- an `app-*` directory whose origin
 * cannot be named this way (an origin no permission row names any more) is
 * left untouched, never guessed at.
 *
 * `pinnedOrigins` is checked separately from `isCacheServed`: the latter
 * reads whether THIS run actually registered serving for the origin, which
 * is false for a pin that exists on disk but whose serving failed to
 * restore this run (a corrupted asset, `restorePinnedServing`'s own
 * per-origin failure tolerance). Treating that origin as orphaned would
 * clear a cache-served app's own data and then write the marker, leaving
 * nothing to retry the restore on a later run.
 */
export function orphanedGrantOrigins (
  apps: ReadonlyArray<{ readonly origin: string }>,
  isCacheServed: (origin: string) => boolean,
  pinnedOrigins: ReadonlySet<string>
): readonly string[] {
  return apps.filter((app) => !isCacheServed(app.origin) && !pinnedOrigins.has(app.origin)).map((app) => app.origin)
}

function alreadyCleaned (markerPath: string): boolean {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return false
  }
  try {
    const data = JSON.parse(raw) as { version?: unknown, done?: unknown }
    return data.version === MARKER_VERSION && data.done === true
  } catch {
    return false
  }
}

/**
 * Runs once per profile, ever: a grant creates no partition, so no origin
 * ever gains a new orphaned one for a later run to find -- unlike a
 * per-origin marker, one boolean is the whole state this needs. `clearData`
 * (Electron's own, more thorough than `clearStorageData` per its own docs)
 * is the same call `../privacy/clear-data.ts` already makes for a
 * cache-served app's "Clear app data" -- one mechanism, not two, and the
 * partition is left in place, empty, rather than deleted from disk: see
 * README.md's Design notes for why.
 *
 * Before clearing a candidate, this stats its own app directory on disk
 * (`appDirectoryState`): a directory that exists means the origin is
 * installed, whatever `pinnedOrigins` or `isCacheServed` say about it, and
 * it is skipped. A stat that fails for any reason other than the directory
 * not existing aborts the whole run -- no origin is cleared and no marker
 * is written -- so a later run, once whatever blocked the read is fixed,
 * gets a real chance to tell an orphan from an app this run merely could
 * not see.
 */
export async function cleanOrphanedAppPartitions (
  userDataPath: string,
  apps: ReadonlyArray<{ readonly origin: string }>,
  isCacheServed: (origin: string) => boolean,
  pinnedOrigins: ReadonlySet<string>,
  sessionFor: (partition: string) => Pick<Session, 'clearData'> = (partition) => session.fromPartition(partition)
): Promise<void> {
  const markerPath = join(userDataPath, MARKER_FILE)
  if (alreadyCleaned(markerPath)) return

  const toClear: string[] = []
  for (const origin of orphanedGrantOrigins(apps, isCacheServed, pinnedOrigins)) {
    const state = appDirectoryState(userDataPath, origin)
    if (state === 'unreadable') return
    if (state === 'yes') continue
    toClear.push(origin)
  }
  for (const origin of toClear) {
    await sessionFor(partitionFor(origin)).clearData()
  }
  writeFileAtomic(markerPath, JSON.stringify({ version: MARKER_VERSION, done: true }))
}
