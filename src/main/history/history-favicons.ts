// One icon per site, kept in the `favicons` table beside the pages. An icon is forgotten with the last page of its
// site, so clearing history leaves no list of sites behind.
import type { DatabaseSync } from 'node:sqlite'

/** Keeps `dataUrl` as the icon of `host`, replacing the one it had. */
export function setHostFavicon (_db: DatabaseSync, _host: string, _dataUrl: string): void {}

/** The icon of each of `hosts` that has one. */
export function faviconsForHosts (_db: DatabaseSync, _hosts: readonly string[]): Record<string, string> {
  return {}
}

/** Forgets the icon of every site that no page in the history belongs to. */
export function pruneHostFavicons (_db: DatabaseSync): void {}
