import type { SiteRoute } from '../../main/permissions/site-info.js'

// The one line the popover shows for an app the person routed through their proxy, and the line that says so when the
// proxy is not answering. Composed here, never from anything an app wrote.

export function routeLineWords (route: SiteRoute): string {
  switch (route) {
    case 'down': return 'Your proxy is not answering, so this app\'s network traffic is stopped.'
    case 'no-proxy': return 'No proxy is set, so this app\'s network traffic is stopped.'
    case 'idle':
    case 'ok': return 'This app\'s network traffic goes through your proxy.'
  }
}

export function renderRouteLine (route: SiteRoute): HTMLElement {
  const line = document.createElement('p')
  line.className = route === 'down' || route === 'no-proxy' ? 'route-line route-line-down' : 'route-line'
  line.textContent = routeLineWords(route)
  return line
}
