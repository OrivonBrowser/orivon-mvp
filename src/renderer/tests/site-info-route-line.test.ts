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

})

describe('routeLineWords for a tab', () => {
  it('says the tab\'s traffic goes through the tunnel, and stops when it does not answer', () => {
    expect(routeLineWords('ok', 'tab')).toBe('This tab\'s traffic goes through your tunnel.')
    expect(routeLineWords('down', 'tab')).toBe('Your tunnel is not answering, so this tab\'s traffic is stopped.')
    expect(routeLineWords('no-proxy', 'tab')).toBe('No tunnel is set, so this tab\'s traffic is stopped.')
    expect(routeLineWords('moving', 'tab')).toContain('This tab is not on your tunnel yet')
  })

  it('says what Nym is doing for the tab through Nym', () => {
    expect(routeLineWords('ok', 'tab', { state: 'off' })).toBe('This tab\'s traffic goes through Nym.')
    expect(routeLineWords('down', 'tab', { state: 'off' })).toBe('Nym is not answering, so this tab\'s traffic is stopped.')
  })
})

