// The one-time move from a routes file that names no tunnel per origin to one that does. Electron-free over the folder it is
// handed.
//
// Before each origin named its own tunnel there was one choice for all of them, and every website that went through it kept
// its storage in the one tunnel profile (`persist:tunnel-profile`). When that choice was the person's proxy, the folder of that
// profile now belongs to the proxy's profile (`persist:proxy-profile`), so it is renamed before any session opens it and nobody
// is signed out. When the choice was Nym nothing moves.

import { existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { profilePartition } from './site-partition.js'
import type { RouteStore } from './route-store.js'

/** What became of the folder: `nothing` when there was none to move. */
export type FolderMove = 'moved' | 'nothing' | 'failed'

/** The folder a profile's persistent session keeps its data in, under the user data folder. */
export function profileFolder (userData: string, profile: 'nym' | 'socks5'): string {
  return join(userData, 'Partitions', profilePartition(profile, true).slice('persist:'.length))
}

/**
 * Moves the data of the websites that went through the proxy from Nym's profile folder to the proxy profile's. Never merges:
 * when the proxy profile's folder already holds anything, nothing is moved. Never throws.
 */
export function moveNymProfileToProxy (userData: string): FolderMove {
  const from = profileFolder(userData, 'nym')
  const to = profileFolder(userData, 'socks5')
  try {
    if (!existsSync(from)) return 'nothing'
    if (existsSync(to)) {
      if (readdirSync(to).length > 0) return 'failed'
      rmdirSync(to)
    }
    renameSync(from, to)
    return 'moved'
  } catch (error) {
    console.error('[route] could not move the data of the websites that went through the proxy to the proxy\'s profile:', error)
    return 'failed'
  }
}

/**
 * Runs the migration when the file was written before each origin named its own tunnel. Never throws: one that cannot be saved
 * is run again at the next start. `trusted` is false when the choice that was made could not be read from the settings, in which
 * case nothing is decided about the file.
 */
export function migrateRouteKinds (store: Pick<RouteStore, 'needsKinds' | 'legacyKind' | 'migrateToKinds'>, move: () => FolderMove, trusted = true): void {
  if (!trusted || !store.needsKinds()) return
  try {
    const moved = store.legacyKind !== 'socks5' || move() !== 'failed'
    store.migrateToKinds(moved)
  } catch (error) {
    console.error('[route] could not record which tunnel each site and app uses:', error)
  }
}
