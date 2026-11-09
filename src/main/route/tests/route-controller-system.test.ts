// A session that follows the system is set to the config the controller is given (`systemConfig`) when it is made, when it
// leaves a front and when that config changes, and never while it is on a front, on the dead end, in a temporary tunnel or
// setting a proxy of its own: a pointing or a stop that came first is read inside the session's turn and wins (T84). With no
// config given, nothing is set that a session did not already have.

import { afterEach, describe, expect, it } from 'vitest'
import { createRouteController } from '../route-controller.js'
import type { RouteProxyConfig, RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const OTHER_APP = 'https://two.example'
const MIRRORED: RouteProxyConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128', proxyBypassRules: '*.eth' }
const SECOND: RouteProxyConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:8080', proxyBypassRules: '*.eth' }
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

interface FakeSession extends RouteSession { readonly name: string, readonly proxies: string[], gate: Promise<void> | undefined }

function fakeSession (name: string): FakeSession {
  const session: FakeSession = {
    name,
    proxies: [],
    gate: undefined,
    setProxy: async (config) => {
      session.proxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}`)
      await session.gate
    },
    closeAllConnections: async () => {}
  }
  return session
}

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }
const label = (config: RouteProxyConfig): string => `${config.mode ?? ''}:${config.proxyRules ?? ''}`

function setup (options: { given?: boolean, everywhere?: boolean, routed?: readonly string[] } = {}) {
  const { given = true, everywhere: start = false, routed = [] } = options
  const store = new RouteStore(null)
  for (const origin of routed) store.setEntry(origin, 'socks5')
  let everywhere = start
  const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', everywhere: () => everywhere, isApp: (origin) => origin === APP || origin === OTHER_APP, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const sessions = new Map<string, FakeSession>()
  const sessionFor = (partition: string): FakeSession => {
    let one = sessions.get(partition)
    if (one === undefined) { one = fakeSession(partition); sessions.set(partition, one) }
    return one
  }
  const own = new WeakSet<object>()
  const system = new WeakSet<object>()
  const state: { config: RouteProxyConfig } = { config: MIRRORED }
  const controller = createRouteController({
    hub,
    broker: () => ({ dropOrigin: async () => {} }),
    sessionFor,
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => [],
    onContentsCreated: () => {},
    onLogin: () => {},
    sharedBypass: () => '*.eth',
    setAppProxy: async () => {},
    ownProxy: (session) => own.has(session),
    followsSystem: (session) => system.has(session),
    ...(given ? { systemConfig: () => state.config } : {})
  })
  const flip = (next: boolean): void => { const previous = everywhere; everywhere = next; hub.everywhereChanged(previous) }
  return { controller, hub, store, sessionFor, own, system, state, flip }
}

describe('with no config given', () => {
  it('sets nothing to a session that was made, and puts a session leaving a front on the system\'s own config', async () => {
    const { controller, sessionFor, flip } = setup({ given: false, everywhere: true })
    const made = sessionFor('made')
    controller.adopt(made)
    await controller.settled()
    flip(false)
    await controller.settled()
    expect(made.proxies.at(-1)).toBe('system:')

    const later = sessionFor('later')
    controller.adopt(later)
    await flush()
    await controller.systemChanged()
    expect(later.proxies, 'a session already on the system\'s config is left as it is').toEqual([])
  })
})

describe('a session that follows the system', () => {
  it('is set to the config one microtask after it is made while the browser is off the tunnel', async () => {
    const { controller, sessionFor } = setup()
    const made = sessionFor('made')
    controller.adopt(made)
    expect(made.proxies).toEqual([])
    await flush()
    expect(made.proxies).toEqual([label(MIRRORED)])
  })

  it('is left alone when its maker marks it as setting a proxy of its own before that microtask', async () => {
    const { controller, sessionFor, own } = setup()
    const web = sessionFor('web-context')
    controller.adopt(web)
    own.add(web)
    await flush()
    await controller.systemChanged()
    expect(web.proxies).toEqual([])
  })

  it('is put on the config, not the system\'s own, when it leaves the tunnel', async () => {
    const { controller, sessionFor, flip } = setup({ everywhere: true })
    const made = sessionFor('made')
    controller.adopt(made)
    await controller.settled()
    flip(false)
    await controller.settled()
    expect(made.proxies.at(-1)).toBe(label(MIRRORED))
  })

  it('is set again, once, whenever the config changes, an app\'s that is not routed included', async () => {
    const { controller, sessionFor, state } = setup()
    const made = sessionFor('made')
    const unrouted = sessionFor('unrouted app')
    controller.adopt(made)
    await controller.prepare(OTHER_APP, unrouted)
    await flush()
    await controller.systemChanged()
    expect(unrouted.proxies).toEqual([label(MIRRORED)])
    state.config = SECOND
    await controller.systemChanged()
    await controller.systemChanged()
    expect(made.proxies).toEqual([label(MIRRORED), label(SECOND)])
    expect(unrouted.proxies).toEqual([label(MIRRORED), label(SECOND)])
  })
})

describe('a session that must not be set to the system\'s config', () => {
  it('is skipped on a front, on the dead end, in a temporary tunnel and when it sets a proxy of its own', async () => {
    const { controller, hub, sessionFor, own, state } = setup({ routed: [APP] })
    const onFront = sessionFor('on a front')
    await controller.prepare(APP, onFront)
    const stopped = sessionFor('stopped')
    await controller.prepare(OTHER_APP, stopped)
    await controller.confineSite(stopped)
    const temporary = sessionFor('temporary')
    controller.adopt(temporary)
    await controller.prepareTemporary(temporary, { port: 4242, username: 'u', secret: 's' }, 'socks5')
    const web = sessionFor('web-context')
    controller.adopt(web)
    own.add(web)
    await flush()
    const front = await hub.front(APP)

    state.config = SECOND
    await controller.systemChanged()

    expect(onFront.proxies).toEqual([`fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(stopped.proxies).toEqual(['fixed_servers:http://127.0.0.1:9'])
    expect(temporary.proxies, 'adopted, then pointed in the same turn: the microtask finds it in a tunnel').toEqual(['fixed_servers:http://127.0.0.1:4242'])
    expect(web.proxies).toEqual([])
  })

  it('is skipped when a stop came after the change was asked for and before its turn', async () => {
    const { controller, sessionFor, state } = setup()
    const made = sessionFor('made')
    controller.adopt(made)
    await flush()
    let open: () => void = () => {}
    made.gate = new Promise<void>((resolve) => { open = resolve })

    state.config = SECOND
    const first = controller.systemChanged()
    state.config = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:9999' }
    const second = controller.systemChanged()
    const stop = controller.confineSite(made)
    made.gate = undefined
    open()
    await Promise.all([first, second, stop])

    expect(made.proxies.slice(1)).toEqual([label(SECOND), 'fixed_servers:http://127.0.0.1:9'])
  })
})

describe('a session that sets a proxy of its own and follows the system', () => {
  it('is set to the config now, even when its adoption stopped it first, and at every change', async () => {
    const { controller, sessionFor, own, system, state, flip } = setup({ everywhere: true })
    const mirror = sessionFor('orivon-system-mirror')
    controller.adopt(mirror)
    own.add(mirror)
    system.add(mirror)
    await controller.mirrorSystem(mirror)
    expect(mirror.proxies).toEqual(['fixed_servers:http://127.0.0.1:9', label(MIRRORED)])
    expect(controller.tunnelOf(mirror)).toBeUndefined()

    await controller.settled()
    flip(false)
    flip(true)
    await controller.settled()
    state.config = SECOND
    await controller.systemChanged()
    expect(mirror.proxies.at(-1)).toBe(label(SECOND))
    expect(mirror.proxies.filter((one) => one.includes('127.0.0.1')), 'never pointed at a front').toEqual(['fixed_servers:http://127.0.0.1:9'])
  })

  it('is not touched by a change when it is the session that asks Chromium what the system says', async () => {
    const { controller, sessionFor, own, system, state } = setup()
    const probe = sessionFor('orivon-system-proxy')
    controller.adopt(probe)
    own.add(probe)
    system.add(probe)
    await flush()
    state.config = SECOND
    await controller.systemChanged()
    expect(probe.proxies).toEqual([])
  })
})
