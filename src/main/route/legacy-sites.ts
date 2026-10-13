// Clears the sessions of their own that websites had before the two profiles existed (`persist:site-<sha256(origin)>`),
// once, and records it. A website whose entry survives lives in the profile its entry names now, so the person signs in to
// it again once. Electron-free over the sessions it is handed.

import { createHash } from 'node:crypto'
import { isPersistableOrigin } from '../../broker/policy/origin.js'
import type { RouteStore } from './route-store.js'

/** The name an earlier build gave the session of the website at `origin`. */
export function legacySitePartition (origin: string): string {
  const name = `site-${createHash('sha256').update(origin, 'utf8').digest('hex')}`
  return isPersistableOrigin(origin) ? `persist:${name}` : name
}

export interface LegacySites {
  readonly clear: (partition: string) => Promise<void>
}

/** Runs the migration when the store was written before the profiles. Never throws: one that fails is tried again at the next start. */
export async function migrateLegacySites (store: Pick<RouteStore, 'needsMigration' | 'legacySites' | 'migrateToProfiles'>, sessions: LegacySites): Promise<void> {
  if (!store.needsMigration()) return
  try {
    for (const origin of store.legacySites()) await sessions.clear(legacySitePartition(origin))
    store.migrateToProfiles()
  } catch (error) {
    console.error('[route] could not clear the sessions websites had of their own:', error)
  }
}
