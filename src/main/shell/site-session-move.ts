// A tab showing a website whose tunnel state just changed moves to the session the new state calls for: into the
// website's own session when the tunnel was turned on, back to the shared one when it was turned off. The decision is
// pure; `install-site-sessions.ts` applies it with `repartitionView`.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isTemporaryRoutePartition } from '../route/temporary-routes.js'
import type { TabTunnelChoice } from '../route/tab-tunnel.js'
import type { TabRecord } from './tab-types.js'

/** What the decision reads of a tab. */
export interface TabInSession {
  readonly id: string
  readonly url: string
  readonly partition: string | undefined
  /** The new-tab page, an internal page or a tab put to sleep: none shows the website. */
  readonly showsPage: boolean
  /** The tunnel choice of the tab, if it has one: it decides the session ahead of the website's own entry. */
  readonly tunnelChoice?: TabTunnelChoice
}

/** The address a tab is on for its session: its page's, or while it has none the one its first navigation leads to. '' with neither. */
export function addressOfTab (committed: string, record: Pick<TabRecord, 'inflightTarget'>): string {
  return committed !== '' ? committed : record.inflightTarget ?? ''
}

export interface TabMove {
  readonly id: string
  readonly url: string
  readonly to: string | undefined
}

/** The tabs on `origin` whose session is not the one `partitionFor` names now for the tab's own choice. A tab in a temporary routed session stays in it. */
export function tabMovesFor (origin: string, tabs: readonly TabInSession[], partitionFor: (url: string, choice: TabTunnelChoice | undefined) => string | undefined): TabMove[] {
  const moves: TabMove[] = []
  for (const tab of tabs) {
    if (!tab.showsPage || originFromUrl(tab.url) !== origin || isTemporaryRoutePartition(tab.partition)) continue
    const to = partitionFor(tab.url, tab.tunnelChoice)
    if (to !== tab.partition) moves.push({ id: tab.id, url: tab.url, to })
  }
  return moves
}
