// Switching the whole browser on stops its sessions before it points them: in the very turn the setting flips, on a listener
// Orivon holds, and a session is said to be tunnelled from then on.

import { afterEach, describe, expect, it } from 'vitest'
import { createRouteController } from '../route-controller.js'
import type { RouteControllerDeps, RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

interface Fake extends RouteSession { readonly proxies: string[] }
const fake = (): Fake => {
  const proxies: string[] = []
  return { proxies, setProxy: async (config) => { proxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}`) }, closeAllConnections: async () => {} }
}

function world (extra: Partial<RouteControllerDeps> = {}) {
  let everywhere = false
  const hub = createRouteHub({ store: new RouteStore(null), proxy: () => ({ host: '127.0.0.1', port: 9050 }), everywhere: () => everywhere, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const appProxies: string[] = []
  const controller = createRouteController({
    hub,
    broker: () => undefined,
    sessionFor: () => fake(),
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => [],
    onContentsCreated: () => {},
    onLogin: () => {},
    setAppProxy: async (config) => { appProxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}`) },
    ...extra
  })
  const flip = (next: boolean): void => { const previous = everywhere; everywhere = next; hub.everywhereChanged(previous) }
  return { controller, flip, appProxies }
}

describe('switching the whole browser on', () => {
  it('stops the default session and the runtime\'s own requests in the very turn the setting flips on, before the front is had', async () => {
    const { controller, flip, appProxies } = world()
    const session = fake()
    controller.adopt(session)

    flip(true)
    expect(session.proxies, 'stopped before anything is awaited').toEqual(['fixed_servers:http://127.0.0.1:9'])
    expect(appProxies).toEqual(['fixed_servers:http://127.0.0.1:9'])
    expect(controller.isTunnelled(session)).toBe(true)
    await controller.settled()
    expect(session.proxies).toHaveLength(2)
    expect(session.proxies[1]).toMatch(/^fixed_servers:http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('stops on the listener Orivon holds when it has one, not on a port nothing is known to answer on', async () => {
    const { controller, flip } = world({ deadEnd: () => 'http://127.0.0.1:41999' })
    const session = fake()
    controller.adopt(session)
    flip(true)
    expect(session.proxies[0]).toBe('fixed_servers:http://127.0.0.1:41999')
    await controller.settled()
    const later = fake()
    controller.adopt(later)
    expect(later.proxies[0]).toBe('fixed_servers:http://127.0.0.1:41999')
  })

  it('says a session is tunnelled while it is pointed at a front or held shut, and not otherwise', async () => {
    const { controller, flip } = world()
    const session = fake()
    controller.adopt(session)
    expect(controller.isTunnelled(session)).toBe(false)
    flip(true)
    await controller.settled()
    expect(controller.isTunnelled(session)).toBe(true)
    flip(false)
    await controller.settled()
    expect(controller.isTunnelled(session)).toBe(false)
  })

  it('says a session that answers for a proxy of its own is tunnelled', () => {
    const own = fake()
    const { controller } = world({ ownProxy: (session) => session === own })
    expect(controller.isTunnelled(own)).toBe(true)
  })
})
