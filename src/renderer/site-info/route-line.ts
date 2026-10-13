import type { SiteRoute } from '../../main/permissions/site-info.js'
import type { NymState } from '../../main/route/nym-status.js'
import { nymRouteLine } from '../pages/shared/nym-words.js'

// The one line the popover shows for an origin the person routed through their tunnel, and the line that says so when
// the tunnel is not answering. Composed here, never from anything an app wrote.

/** Whose traffic the line is about: an installed app or a website. */
export type RouteSubject = 'app' | 'site'

export function routeLineWords (route: SiteRoute, subject: RouteSubject = 'app', nym?: NymState): string {
  const noun = subject === 'app' ? 'app' : 'site'
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

export function renderRouteLine (route: SiteRoute, subject: RouteSubject = 'app', nym?: NymState): HTMLElement {
  const line = document.createElement('p')
  line.className = route === 'down' || route === 'no-proxy' || nym?.state === 'failed' || nym?.state === 'unavailable' ? 'route-line route-line-down' : 'route-line'
  line.textContent = routeLineWords(route, subject, nym)
  return line
}
