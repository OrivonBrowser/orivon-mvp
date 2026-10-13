import type { SiteRoute } from '../../main/permissions/site-info.js'

// The one line the popover shows for an origin the person routed through their tunnel, and the line that says so when
// the tunnel is not answering. Composed here, never from anything an app wrote.

/** Whose traffic the line is about: an installed app, a website, or a website whose own files Orivon fetches itself. */
export type RouteSubject = 'app' | 'site' | 'web3'

export function routeLineWords (route: SiteRoute, subject: RouteSubject = 'app'): string {
  const noun = subject === 'app' ? 'app' : 'site'
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

export function renderRouteLine (route: SiteRoute, subject: RouteSubject = 'app'): HTMLElement {
  const line = document.createElement('p')
  line.className = route === 'down' || route === 'no-proxy' ? 'route-line route-line-down' : 'route-line'
  line.textContent = routeLineWords(route, subject)
  return line
}
