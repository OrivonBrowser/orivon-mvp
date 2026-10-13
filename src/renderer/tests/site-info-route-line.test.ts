import { describe, expect, it } from 'vitest'
import { routeLineWords } from '../site-info/route-line.js'

// The words the popover shows for a routed app; the DOM is covered by the end-to-end spec that routes an app.

describe('the route line', () => {
  it('says the app\'s traffic goes through the person\'s proxy while it works', () => {
    expect(routeLineWords('ok')).toBe('This app\'s network traffic goes through your proxy.')
    expect(routeLineWords('idle')).toBe(routeLineWords('ok'))
  })

  it('says the traffic is stopped, not sent directly, when the proxy is not answering or not set', () => {
    expect(routeLineWords('down')).toBe('Your proxy is not answering, so this app\'s network traffic is stopped.')
    expect(routeLineWords('no-proxy')).toBe('No proxy is set, so this app\'s network traffic is stopped.')
  })

  it('says a page opened through the proxy from a routed app goes through it and keeps nothing', () => {
    expect(routeLineWords('temporary')).toBe('This page goes through your proxy, and nothing it stores is kept once its last tab is closed.')
  })
})
