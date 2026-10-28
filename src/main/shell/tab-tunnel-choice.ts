// Setting a tab's tunnel choice (ADR-0101): the tab takes the choice, and the website it shows moves into the session the choice
// calls for. Tied to Electron through `tab-parking.ts`, which swaps the tab's view; what the routes and a report read back of the
// tabs' choices is in `tab-tunnel-facts.ts`, which is not.
import { ensureSiteSession } from '../route/site-routes.js'
import { profilePartition } from '../route/site-partition.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import { repartitionView } from './tab-parking.js'
import { partitionChanged } from './tab-partition.js'
import type { TabRecord } from './tab-types.js'

/**
 * Gives the tab `choice` (null takes it away), makes the profile it calls for ready so that the tunnel starts coming up while
 * the person types, and moves the website the tab shows, if it shows one, into the session the choice calls for. The move
 * reloads the page; a move that cannot be made stops the page's loads, so it is never left in the session it was in.
 */
export function setTabTunnelChoice (id: string, record: TabRecord, choice: TabTunnelChoice | null): void {
  const next = choice ?? undefined
  if (record.tunnelChoice === next) return
  if (next === undefined) delete record.tunnelChoice
  else record.tunnelChoice = next
  console.log(`[route] tab tunnel ${next === undefined ? 'cleared' : `chosen: ${next}`} (${id})`)
  if (next !== undefined) ensureSiteSession(profilePartition(next, true), false)
  moveToChoice(id, record)
  record.host.emitState()
}

function moveToChoice (id: string, record: TabRecord): void {
  // The new-tab page, a page of the shell and a sleeping tab show no website: the first address, or the wake, follows the choice.
  if (record.isDashboardTab || record.internalPage !== null || (record.sleeping ?? null) !== null || record.host.isClosing()) return
  const contents = record.view.webContents
  if (contents.isDestroyed()) return
  const url = contents.getURL()
  const swap = partitionChanged(url, record.partition, record.tunnelChoice)
  if (swap === undefined) return
  try {
    repartitionView(id, record, url, swap.to)
  } catch (error) {
    console.error('[route] tab tunnel: the tab could not move to the session its choice calls for; its loads are stopped:', error)
    if (!record.view.webContents.isDestroyed()) record.view.webContents.stop()
  }
}
