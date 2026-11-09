// A name a protocol serves, written with the root dot (`vitalik.eth.`), is not covered by a bypass rule for `*.eth`, so the
// controller adds the root-dot spelling to what every front is bypassed for: an app's session, a temporary tab's, a website's
// own, and the requests made with no session. The resolver refuses the name, so none is sent to a tunnel.

import { afterEach, describe, expect, it } from 'vitest'
import { createRouteController } from '../route-controller.js'
import type { RouteControllerDeps, RouteProxyConfig, RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const SITE = 'https://news.example'
const MACHINE = '<-loopback>;localhost;*.localhost;127.0.0.1/8;[::1]'
const ROOT_DOT = '*.eth.;*.orivon.'
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

interface FakeSession extends RouteSession { readonly bypass: string[] }

function fakeSession (): FakeSession {
  const bypass: string[] = []
  return { bypass, setProxy: async (config) => { bypass.push(config.proxyBypassRules ?? '') }, closeAllConnections: async () => {} }
}

function setup (extra: Partial<RouteControllerDeps> = {}, everywhere = false) {
  const store = new RouteStore(null)
  let on = everywhere
  const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', everywhere: () => on, isApp: (origin) => origin === APP, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const controller = createRouteController({
    hub,
    broker: () => ({ dropOrigin: async () => {} }),
    sessionFor: () => fakeSession(),
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => [],
    onContentsCreated: () => {},
    onLogin: () => {},
    ...extra
  })
  const flip = (next: boolean): void => { const previous = on; on = next; hub.everywhereChanged(previous) }
  return { controller, store, flip }
}

describe('the root-dot spelling of the names the verifier answers for', () => {
  const rootDotBypass = (): string => ROOT_DOT

  it('is kept from an app\'s front, which has no list of names of its own', async () => {
    const { controller, store } = setup({ rootDotBypass })
    store.setEntry(APP, 'socks5')
    const session = fakeSession()
    await controller.prepare(APP, session)
    expect(session.bypass).toEqual([`${MACHINE};${ROOT_DOT}`])
  })

  it('is kept from a temporary tab\'s front', async () => {
    const { controller } = setup({ rootDotBypass })
    const session = fakeSession()
    await controller.prepareTemporary(session, { port: 41_001, username: 'orivon', secret: 'temporary-secret' }, 'socks5')
    expect(session.bypass).toEqual([`${MACHINE};${ROOT_DOT}`])
  })

  it('is listed once beside a website\'s own list, which holds it too', async () => {
    const { controller, store } = setup({ rootDotBypass })
    store.setEntry(SITE, 'socks5')
    const session = fakeSession()
    await controller.prepareSite(SITE, session, '*.eth;*.eth.;*.orivon;*.orivon.')
    expect(session.bypass).toEqual([`${MACHINE};${ROOT_DOT};*.eth;*.orivon`])
  })

  it('is kept from the requests made with no session while the whole browser is on the tunnel, and they send the dotless names to the front as before', async () => {
    const configs: RouteProxyConfig[] = []
    const { controller, flip } = setup({ rootDotBypass, sharedBypass: () => '*.eth;*.eth.', setAppProxy: async (config) => { configs.push(config) } })
    flip(true)
    await controller.settled()
    expect(configs.at(-1)?.proxyBypassRules).toBe(`${MACHINE};${ROOT_DOT}`)
  })

  it('adds nothing to a session when the runtime names none', async () => {
    const { controller, store } = setup()
    store.setEntry(APP, 'socks5')
    const session = fakeSession()
    await controller.prepare(APP, session)
    expect(session.bypass).toEqual([MACHINE])
  })
})
