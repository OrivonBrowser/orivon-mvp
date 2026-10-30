import type { SiteRoute } from '../../main/permissions/site-info.js'
import type { NymState } from '../../main/route/nym-status.js'
import { nymRouteLine } from '../pages/shared/nym-words.js'

// The words the tunnels page says for an origin the person routed through their tunnel, and when the tunnel is not
// answering. Composed here, never from anything an app wrote.

/** Whose traffic the line is about: an installed app, a website, a tab (every website opened in it) or the whole browser. */
export type RouteSubject = 'app' | 'site' | 'tab' | 'browser'

export function routeLineWords (route: SiteRoute, subject: RouteSubject = 'app', nym?: NymState): string {
  const noun = subject
  if (route === 'moving') return `This ${noun} is not on your tunnel yet, so its traffic is stopped. If this stays, reload the page.`
  // Through Nym the line also says what Nym is doing.
  if (nym !== undefined && route !== 'no-proxy') return nymRouteLine(route, nym, noun)
  switch (route) {
    case 'down': return `Your tunnel is not answering, so this ${noun}'s traffic is stopped.`
    case 'no-proxy': return `No tunnel is set, so this ${noun}'s traffic is stopped.`
    case 'temporary': return 'This page goes through your tunnel, and nothing it stores is kept once its last tab is closed.'
    case 'idle':
    case 'ok': return `This ${noun}'s traffic goes through your tunnel.`
  }
}
