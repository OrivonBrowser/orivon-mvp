// Before ADR-0044, a held grant alone put an origin in its own
// `persist:app-<hash>` session partition; a granted, network-served app now
// shares the default session instead (ADR-0044's own Consequences), and
// "Clear app data" (../privacy/clear-data.ts) only ever reaches a
// CACHE-SERVED origin's partition. Data such an app left behind in its old
// partition is otherwise unreachable forever: neither "Clear app data" nor
// any live session touches it again. See README.md's Design notes for the
// disk-vs-session choice and why this runs exactly once.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { session } from 'electron'
import type { Session } from 'electron'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'

const MARKER_FILE = 'orphaned-app-partitions-cleaned.json'
const MARKER_VERSION = 1

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
 * Runs once per profile, ever: no NEW orphan can appear after this ships,
 * since a grant no longer creates a partition at all (ADR-0044) -- so unlike
 * a per-origin marker, one boolean is the whole state this needs. `clearData`
 * (Electron's own, more thorough than `clearStorageData` per its own docs)
 * is the same call `../privacy/clear-data.ts` already makes for a
 * cache-served app's "Clear app data" -- one mechanism, not two, and the
 * partition is left in place, empty, rather than deleted from disk: see
 * README.md's Design notes for why.
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
  for (const origin of orphanedGrantOrigins(apps, isCacheServed, pinnedOrigins)) {
    await sessionFor(partitionFor(origin)).clearData()
  }
  writeFileAtomic(markerPath, JSON.stringify({ version: MARKER_VERSION, done: true }))
}
