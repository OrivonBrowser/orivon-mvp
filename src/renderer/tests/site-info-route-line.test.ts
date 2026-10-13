import { describe, expect, it } from 'vitest'
import { routeLineWords } from '../site-info/route-line.js'

// The words the popover shows for a routed app; the DOM is covered by the end-to-end spec that routes an app.

describe('the route line', () => {
  it('says the app\'s traffic goes through the person\'s tunnel while it works', () => {
    expect(routeLineWords('ok')).toBe('This app\'s traffic goes through your tunnel.')
    expect(routeLineWords('idle')).toBe(routeLineWords('ok'))
  })

  it('says the traffic is stopped, not sent directly, when the tunnel is not answering or not set', () => {
    expect(routeLineWords('down')).toBe('Your tunnel is not answering, so this app\'s traffic is stopped.')
    expect(routeLineWords('no-proxy')).toBe('No tunnel is set, so this app\'s traffic is stopped.')
  })

  it('says a page opened through the proxy from a routed app goes through it and keeps nothing', () => {
    expect(routeLineWords('temporary')).toBe('This page goes through your tunnel, and nothing it stores is kept once its last tab is closed.')
  })
})

describe('the route line for a website', () => {
  it('speaks of the site, not an app', () => {
    expect(routeLineWords('ok', 'site')).toBe('This site\'s traffic goes through your tunnel.')
    expect(routeLineWords('down', 'site')).toBe('Your tunnel is not answering, so this site\'s traffic is stopped.')
    expect(routeLineWords('no-proxy', 'site')).toBe('No tunnel is set, so this site\'s traffic is stopped.')
  })

  it('says plainly that a Web3 name\'s own files stay outside the tunnel, and never that the whole site goes through it', () => {
    const words = routeLineWords('ok', 'web3')
    expect(words).toContain('outside the tunnel')
    expect(words).not.toBe(routeLineWords('ok', 'site'))
  })
})
