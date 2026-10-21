// The tunnel a session leaves by, as the controller says it: the one its origin picked, and nothing for a session that
// follows the system.

import { afterEach, describe, expect, it } from 'vitest'
import { createRouteController } from '../route-controller.js'
import type { RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

function setup () {
  const store = new RouteStore(null)
  const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const sessions = new Map<string, RouteSession>()
  const sessionFor = (partition: string): RouteSession => {
    let one = sessions.get(partition)
    if (one === undefined) { one = { setProxy: async () => {}, closeAllConnections: async () => {} }; sessions.set(partition, one) }
    return one
  }
  const controller = createRouteController({ hub, broker: () => undefined, sessionFor, embedPartition: (origin) => `embed:${origin}`, allContents: () => [], onContentsCreated: () => {}, onLogin: () => {} })
  return { store, controller, sessionFor }
}

describe('the tunnel a session leaves by', () => {
  const OTHER_APP = 'https://two.example'

  it('is the tunnel its origin picked, for each origin on its own, and follows an origin that moves to the other tunnel', async () => {
    const { store, controller, sessionFor } = setup()
    store.setEntry(APP, 'socks5')
    store.setEntry(OTHER_APP, 'nym')
    await controller.appSessionRegistered(APP, sessionFor('app'))
    await controller.appSessionRegistered(OTHER_APP, sessionFor('other'))
    expect(controller.tunnelOf(sessionFor('app'))).toBe('socks5')
    expect(controller.tunnelOf(sessionFor('other'))).toBe('nym')

    store.setEntry(OTHER_APP, 'socks5')
    await controller.settled()
    expect(controller.tunnelOf(sessionFor('other'))).toBe('socks5')
  })

  it('is nothing for a session that is not pointed at anything, and for an origin put back on the system\'s proxy', async () => {
    const { store, controller, sessionFor } = setup()
    store.setEntry(APP, 'nym')
    await controller.appSessionRegistered(APP, sessionFor('app'))
    expect(controller.tunnelOf(sessionFor('never'))).toBeUndefined()
    store.setEntry(APP, undefined)
    await controller.settled()
    expect(controller.tunnelOf(sessionFor('app'))).toBeUndefined()
  })

  it('is the tunnel of a temporary session\'s front', async () => {
    const { controller, sessionFor } = setup()
    await controller.prepareTemporary(sessionFor('temporary'), { port: 41002, username: 'orivon', secret: 's' }, 'nym')
    expect(controller.tunnelOf(sessionFor('temporary'))).toBe('nym')
    controller.releaseTemporary(sessionFor('temporary'), { port: 41002, username: 'orivon', secret: 's' })
    expect(controller.tunnelOf(sessionFor('temporary'))).toBeUndefined()
  })

  it('is held for a session stopped on the rule that reaches nothing', async () => {
    const { controller, sessionFor } = setup()
    await controller.confineSite(sessionFor('stopped'))
    expect(controller.tunnelOf(sessionFor('stopped'))).toBe('held')
  })
})
