// Setting a tab's tunnel choice (ADR-0101): the tab takes the choice, and the website it shows moves into the session the choice
// calls for. Tied to Electron through `tab-parking.ts`, which swaps the tab's view; what the routes and a report read back of the
// tabs' choices is in `tab-tunnel-facts.ts`, which is not.
import { allowedTabChoice, ensureSiteSession } from '../route/site-routes.js'
import { profilePartition } from '../route/site-partition.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import { moveListOutOfView } from './tab-history.js'
import { repartitionView } from './tab-parking.js'
import { partitionChanged } from './tab-partition.js'
import type { TabRecord } from './tab-types.js'

function assign (record: TabRecord, choice: TabTunnelChoice | undefined): void {
  if (choice === undefined) delete record.tunnelChoice
  else record.tunnelChoice = choice
}

/**
 * Gives the tab `choice` (null takes it away), makes the profile it calls for ready so that the tunnel starts coming up while
 * the person types, and moves the website the tab shows, if it shows one, into the session the choice calls for. The move
 * reloads the page. A move that cannot be made at all gives the choice back, so the tab never claims a tunnel its page is not
 * using; one that stopped half-way leaves the page in the session the choice calls for and closes the view it left. A window held
 * to one tunnel (a private window held to Nym) takes no other choice: the request is refused and the tab keeps what it had.
 */
export function setTabTunnelChoice (id: string, record: TabRecord, choice: TabTunnelChoice | null): void {
  const previous = record.tunnelChoice
  const next = choice ?? undefined
  if (previous === next) return
  if (allowedTabChoice(next) !== next) {
    console.error(`[route] tab tunnel refused: this window is held to one tunnel, so a tab takes no other (${id})`)
    return
  }
  assign(record, next)
  console.log(`[route] tab tunnel ${next === undefined ? 'cleared' : `chosen: ${next}`} (${id})`)
  if (next !== undefined) ensureSiteSession(profilePartition(next, true), false)
  if (!moveToChoice(id, record)) assign(record, previous)
  record.host.emitState()
}

/** Whether the choice stands: false only when the page is still in the session it was in because the move could not be made. */
function moveToChoice (id: string, record: TabRecord): boolean {
  // A new tab that Back returned to holds the pages it was left for, in the session it is in.
  if (record.isDashboardTab && !record.view.webContents.isDestroyed()) moveListOutOfView(record, record.view.webContents)
  // The new-tab page, a page of the shell and a sleeping tab show no website: the first address, or the wake, follows the choice.
  if (record.isDashboardTab || record.internalPage !== null || (record.sleeping ?? null) !== null || record.host.isClosing()) return true
  const before = record.view
  if (before.webContents.isDestroyed()) return true
  const url = before.webContents.getURL()
  const swap = partitionChanged(url, record.partition, record.tunnelChoice)
  if (swap === undefined) return true
  try {
    repartitionView(id, record, url, swap.to)
  } catch (error) {
    console.error('[route] tab tunnel: the tab could not move to the session its choice calls for:', error)
    if (record.view === before) return false
    // The record already shows the view in the new session; the one left behind must not run its page on.
    if (!before.webContents.isDestroyed()) before.webContents.close()
  }
  return true
}
