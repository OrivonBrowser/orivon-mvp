import type { SiteRoute } from '../../main/permissions/site-info.js'
import type { NymState } from '../../main/route/nym-status.js'
import { nymRouteLine } from '../nym-words.js'

// The one line the popover shows for an origin the person routed through their tunnel, and the line that says so when
// the tunnel is not answering. Composed here, never from anything an app wrote.

/** Whose traffic the line is about: an installed app, a website, or a website whose own files Orivon fetches itself. */
export type RouteSubject = 'app' | 'site' | 'web3'

export function routeLineWords (route: SiteRoute, subject: RouteSubject = 'app', nym?: NymState): string {
  const noun = subject === 'app' ? 'app' : 'site'
  // Through Nym the line also says what Nym is doing; a Web3 site's own files come from Orivon, which has its sentence below.
  if (nym !== undefined && route !== 'no-proxy' && subject !== 'web3') return nymRouteLine(route, nym, noun)
  switch (route) {
    case 'down': return `Your tunnel is not answering, so this ${noun}'s traffic is stopped.`
    case 'no-proxy': return `No tunnel is set, so this ${noun}'s traffic is stopped.`
    case 'temporary': return 'This page goes through your tunnel, and nothing it stores is kept once its last tab is closed.'
    case 'idle':
    case 'ok': return subject === 'web3'
      ? 'What this site asks of other sites goes through your tunnel. Its own files come from Orivon itself, outside the tunnel.'
      : `This ${noun}'s traffic goes through your tunnel.`
  }
}

export function renderRouteLine (route: SiteRoute, subject: RouteSubject = 'app', nym?: NymState): HTMLElement {
  const line = document.createElement('p')
  line.className = route === 'down' || route === 'no-proxy' || nym?.state === 'failed' || nym?.state === 'unavailable' ? 'route-line route-line-down' : 'route-line'
  line.textContent = routeLineWords(route, subject, nym)
  return line
}
