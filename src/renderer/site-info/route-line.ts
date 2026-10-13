import type { SiteRoute } from '../../main/permissions/site-info.js'
import type { NymState } from '../../main/route/nym-status.js'
import { nymRouteLine } from '../nym-words.js'

// The one line the popover shows for an app the person routed through their tunnel, and the line that says so when the
// tunnel is not answering. Composed here, never from anything an app wrote.

export function routeLineWords (route: SiteRoute, nym?: NymState): string {
  if (nym !== undefined && route !== 'no-proxy') return nymRouteLine(route, nym)
  switch (route) {
    case 'down': return 'Your tunnel is not answering, so this app\'s traffic is stopped.'
    case 'no-proxy': return 'No tunnel is set, so this app\'s traffic is stopped.'
    case 'temporary': return 'This page goes through your tunnel, and nothing it stores is kept once its last tab is closed.'
    case 'idle':
    case 'ok': return 'This app\'s traffic goes through your tunnel.'
  }
}

export function renderRouteLine (route: SiteRoute, nym?: NymState): HTMLElement {
  const line = document.createElement('p')
  line.className = route === 'down' || route === 'no-proxy' || nym?.state === 'failed' || nym?.state === 'unavailable' ? 'route-line route-line-down' : 'route-line'
  line.textContent = routeLineWords(route, nym)
  return line
}
