import { describe, expect, it } from 'vitest'
import { tabTunnel, tabVia } from '../site-info-tab.js'
import type { TabTunnelFacts } from '../site-info-tab.js'

const PROXY = { address: '', users: { sites: 0, apps: 0, everything: false } }
const facts = (over: Partial<TabTunnelFacts> = {}): TabTunnelFacts => ({ choice: undefined, everywhere: false, defaultKind: 'nym', unreadable: false, blocked: {}, proxy: PROXY, ...over })

describe('the tunnel a tab\'s websites go through', () => {
  it('is the tab\'s own choice when it has a tunnel', () => {
    for (const everywhere of [false, true]) {
      expect(tabVia('nym', everywhere, 'socks5')).toBe('nym')
      expect(tabVia('socks5', everywhere, 'nym')).toBe('socks5')
    }
  })

  it('is none for a direct choice, even while the whole browser is on a tunnel', () => {
    expect(tabVia('direct', true, 'nym')).toBeNull()
    expect(tabVia('direct', false, 'nym')).toBeNull()
  })

  it('follows the browser with no choice: the default tunnel while the whole browser is on one, else none', () => {
    expect(tabVia(undefined, true, 'socks5')).toBe('socks5')
    expect(tabVia(undefined, false, 'socks5')).toBeNull()
  })
})

describe('the tunnel a tab\'s websites go through while the tunnel settings cannot be read', () => {
  it('is the tunnel every website takes, for a tab with no choice and for a direct one, even with the whole browser off a tunnel', () => {
    expect(tabVia(undefined, false, 'socks5', 'nym')).toBe('nym')
    expect(tabVia('direct', false, 'socks5', 'nym')).toBe('nym')
    expect(tabVia('direct', true, 'nym', 'socks5')).toBe('socks5')
  })

  it('is still the tab\'s own tunnel when it chose one', () => {
    expect(tabVia('socks5', false, 'nym', 'nym')).toBe('socks5')
  })

  it('is carried by the switches of the tab', () => {
    expect(tabTunnel(facts({ unreadable: true, unreadableKind: 'nym' }))).toMatchObject({ via: 'nym', following: true, unreadable: true })
    expect(tabTunnel(facts({ choice: 'direct', unreadable: true, unreadableKind: 'socks5' }))).toMatchObject({ via: 'socks5', tabChoice: 'direct', unreadable: true })
  })
})

describe('the tunnel switches of a tab', () => {
  it('are about a tab, follow the browser while the tab has no choice and carry no choice then', () => {
    const tunnel = tabTunnel(facts({ everywhere: true }))
    expect(tunnel).toMatchObject({ via: 'nym', following: true, subject: 'tab', notices: {}, swarm: false })
    expect('tabChoice' in tunnel).toBe(false)
  })

  it('carry the choice, and are no longer following', () => {
    expect(tabTunnel(facts({ choice: 'socks5' }))).toMatchObject({ via: 'socks5', following: false, tabChoice: 'socks5' })
    expect(tabTunnel(facts({ choice: 'direct', everywhere: true }))).toMatchObject({ via: null, following: false, tabChoice: 'direct' })
  })

  it('ask for no notice before the first move into a profile, which only a website\'s own entry has', () => {
    expect(tabTunnel(facts({ choice: 'nym' })).notices).toEqual({})
  })

  it('pass on why a tunnel cannot be chosen, what the proxy is and whether the settings could be read', () => {
    const proxy = { address: '127.0.0.1:9050', users: { sites: 1, apps: 0, everything: false } }
    expect(tabTunnel(facts({ blocked: { socks5: 'no-proxy' }, proxy, unreadable: true }))).toMatchObject({ blocked: { socks5: 'no-proxy' }, proxy, unreadable: true })
  })
})
