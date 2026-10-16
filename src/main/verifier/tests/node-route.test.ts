import { afterEach, describe, expect, it } from 'vitest'
import { setOwnRequests } from '../../route/own-requests.js'
import type { OwnRequests } from '../../route/own-requests.js'
import { configureNodeRoute, nodesMayServeTunnelSites, nodesRunThroughTunnel } from '../node-route.js'

function routes (everywhere: boolean): OwnRequests {
  return { everywhere: () => everywhere, isRouted: () => everywhere, tunnel: async () => new Response(), direct: async () => new Response(), directSession: () => ({}) }
}

afterEach(() => {
  setOwnRequests(undefined)
  configureNodeRoute({ followTunnel: () => false })
})

describe('where the local nodes leave', () => {
  const cases = [
    // whole browser on the tunnel, nodes asked to follow it
    { everywhere: true, follow: true, through: true, tunnelSites: true },
    // whole browser on the tunnel, nodes direct (the default): the nodes serve a website with its own tunnel too
    { everywhere: true, follow: false, through: false, tunnelSites: true },
    // no tunnel for the browser: nodes direct, and a site with a tunnel of its own is not served by a node that would show its address
    { everywhere: false, follow: true, through: false, tunnelSites: false },
    { everywhere: false, follow: false, through: false, tunnelSites: true }
  ]
  for (const { everywhere, follow, through, tunnelSites } of cases) {
    it(`browser-wide tunnel ${everywhere ? 'on' : 'off'}, nodes follow it ${follow ? 'on' : 'off'}: ${through ? 'through the tunnel' : 'direct'}, a tunnel-profile website ${tunnelSites ? 'may' : 'may not'} read them`, () => {
      setOwnRequests(routes(everywhere))
      configureNodeRoute({ followTunnel: () => follow })
      expect(nodesRunThroughTunnel()).toBe(through)
      expect(nodesMayServeTunnelSites('nym')).toBe(tunnelSites)
    })
  }

  it('serves only the websites of the tunnel the nodes run through, when they run through one', () => {
    setOwnRequests(routes(true))
    configureNodeRoute({ followTunnel: () => true, nodesTunnel: () => 'socks5' })
    expect(nodesMayServeTunnelSites('socks5')).toBe(true)
    expect(nodesMayServeTunnelSites('nym')).toBe(false)
    configureNodeRoute({ followTunnel: () => false, nodesTunnel: () => 'socks5' })
    expect(nodesMayServeTunnelSites('nym'), 'direct nodes the person accepted serve both').toBe(true)
    expect(nodesMayServeTunnelSites('socks5')).toBe(true)
  })

  it('runs direct until the setting is read, whatever the tunnel does', () => {
    setOwnRequests(routes(true))
    expect(nodesRunThroughTunnel()).toBe(false)
  })
})
