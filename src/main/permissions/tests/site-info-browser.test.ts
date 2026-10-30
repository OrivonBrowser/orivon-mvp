import { describe, expect, it } from 'vitest'
import { browserTunnel, NO_BROWSER } from '../site-info-browser.js'
import type { BrowserTunnelFacts } from '../site-info-browser.js'

const PROXY = { address: '127.0.0.1:9050', users: { sites: 0, apps: 0, tabs: 0, everything: false } }
const facts = (over: Partial<BrowserTunnelFacts> = {}): BrowserTunnelFacts => ({ everywhere: false, defaultKind: 'nym', nodes: false, unreadable: false, blocked: {}, proxy: PROXY, tabs: [], ...over })

describe('the tunnel of the whole browser, as the Browser-wide panel shows it', () => {
  it('is on no tunnel while the whole browser is not on one, whatever the default is', () => {
    expect(browserTunnel(facts({ defaultKind: 'socks5' }))).toMatchObject({ via: null, defaultKind: 'socks5' })
  })

  it('is on the default tunnel while the whole browser is on one', () => {
    expect(browserTunnel(facts({ everywhere: true, defaultKind: 'socks5' })).via).toBe('socks5')
  })

  it('is on the tunnel every website takes while the settings cannot be read, which a default that has no address yields to', () => {
    expect(browserTunnel(facts({ everywhere: true, defaultKind: 'socks5', unreadable: true, unreadableKind: 'nym' })).via).toBe('nym')
    expect(browserTunnel(facts({ unreadable: true })).via, 'nothing is on while no tunnel is known to take every website').toBeNull()
  })

  it('carries the nodes, the blocked tunnels, the proxy and the tabs with a choice as they were given, and the route only when there is one', () => {
    const tabs = [{ title: 'News', choice: 'direct' as const }]
    expect(browserTunnel(facts({ nodes: true, blocked: { socks5: 'no-proxy' }, tabs }))).toEqual({ via: null, defaultKind: 'nym', nodes: true, blocked: { socks5: 'no-proxy' }, proxy: PROXY, unreadable: false, tabs })
    expect(browserTunnel(facts({ everywhere: true, route: 'down' })).route).toBe('down')
  })

  it('has no tabs and no settings of its own when nothing was injected', () => {
    expect(NO_BROWSER.tabs()).toEqual([])
    expect(NO_BROWSER.nodes()).toBe(false)
    expect(NO_BROWSER.setKind('nym')).toBe(false)
    expect(NO_BROWSER.setEverywhere(true)).toBe(false)
    expect(NO_BROWSER.setNodes(true)).toBe(false)
  })
})
