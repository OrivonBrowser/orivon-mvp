// A tab showing a website whose tunnel state just changed moves to the session the new state calls for: into the
// website's own session when the tunnel was turned on, back to the shared one when it was turned off. The decision is
// pure; `install-site-sessions.ts` applies it with `repartitionView`.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isTemporaryRoutePartition } from '../route/temporary-routes.js'

/** What the decision reads of a tab. */
export interface TabInSession {
  readonly id: string
  readonly url: string
  readonly partition: string | undefined
  /** The new-tab page, an internal page or a tab put to sleep: none shows the website. */
  readonly showsPage: boolean
}

export interface TabMove {
  readonly id: string
  readonly url: string
  readonly to: string | undefined
}

/** The tabs on `origin` whose session is not the one `partitionFor` names now. A tab in a temporary routed session stays in it. */
export function tabMovesFor (origin: string, tabs: readonly TabInSession[], partitionFor: (url: string) => string | undefined): TabMove[] {
  const moves: TabMove[] = []
  for (const tab of tabs) {
    if (!tab.showsPage || originFromUrl(tab.url) !== origin || isTemporaryRoutePartition(tab.partition)) continue
    const to = partitionFor(tab.url)
    if (to !== tab.partition) moves.push({ id: tab.id, url: tab.url, to })
  }
  return moves
}
