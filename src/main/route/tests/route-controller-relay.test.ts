// The name relay, when the controller is handed one: sessions that follow the system are set to the relay's config while it has
// one and to the mirror's when it has none, and a proxy challenge from the relay's listener, and from nothing else, is answered
// with the relay's credentials. A session on a front, the dead end, a temporary tunnel or a proxy of its own is left alone.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NameRelayLink } from '../name-relay/relay-link.js'
import { createRouteController } from '../route-controller.js'
import type { RouteLoginListener, RouteProxyConfig, RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const MIRRORED: RouteProxyConfig = { mode: 'fixed_servers', proxyRules: 'http=proxy.test:3128', proxyBypassRules: '*.eth' }
const RELAYED: RouteProxyConfig = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:4545', proxyBypassRules: '*.eth' }
const RELAY_PORT = 4545
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

interface FakeSession extends RouteSession { readonly proxies: string[] }

const fakeSession = (): FakeSession => {
  const session: FakeSession = {
    proxies: [],
    setProxy: async (config) => { session.proxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}`) },
    closeAllConnections: async () => {}
  }
  return session
}
const label = (config: RouteProxyConfig): string => `${config.mode ?? ''}:${config.proxyRules ?? ''}`
const flush = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }

/** A relay that is active when `state.config` is set, and answers for its own port. */
function fakeRelay (state: { config: RouteProxyConfig | undefined }): NameRelayLink & { readonly asked: number[] } {
  const asked: number[] = []
  return {
    asked,
    config: () => state.config,
    credentials: (info) => { asked.push(info.port); return info.port === RELAY_PORT ? { username: 'orivon', password: 'relay-secret' } : undefined }
  }
}

function setup (options: { relay?: boolean, routed?: boolean } = {}) {
  const { relay: withRelay = true, routed = false } = options
  const store = new RouteStore(null)
  if (routed) store.setEntry(APP, 'socks5')
  const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', everywhere: () => false, isApp: (origin) => origin === APP, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const mirror: { config: RouteProxyConfig } = { config: MIRRORED }
  const active: { config: RouteProxyConfig | undefined } = { config: undefined }
  const relay = fakeRelay(active)
  const logins: RouteLoginListener[] = []
  const own = new WeakSet<object>()
  const controller = createRouteController({
    hub,
    broker: () => ({ dropOrigin: async () => {} }),
    sessionFor: () => fakeSession(),
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => [],
    onContentsCreated: () => {},
    onLogin: (listener) => { logins.push(listener) },
    sharedBypass: () => '*.eth',
    setAppProxy: async () => {},
    ownProxy: (session) => own.has(session),
    systemConfig: () => mirror.config,
    ...(withRelay ? { relay: () => relay } : {})
  })
  return { controller, hub, mirror, active, relay, logins, own }
}

describe('the config a session that follows the system is set to', () => {
  it('is the relay\'s while it has one, and the mirror\'s again when it has none', async () => {
    const { controller, mirror, active } = setup()
    const made = fakeSession()
    const app = fakeSession()
    controller.adopt(made)
    await controller.prepare('https://two.example', app)
    await flush()
    await controller.systemChanged()
    expect(made.proxies).toEqual([label(MIRRORED)])

    active.config = RELAYED
    await controller.systemChanged()
    expect(made.proxies.at(-1)).toBe(label(RELAYED))
    expect(app.proxies.at(-1)).toBe(label(RELAYED))

    mirror.config = { mode: 'system' }
    active.config = undefined
    await controller.systemChanged()
    expect(made.proxies.at(-1)).toBe('system:')
    expect(app.proxies.at(-1)).toBe('system:')
  })

  it('is the relay\'s at once for a session that mirrors the system, with no change asked for', async () => {
    const { controller, active } = setup()
    active.config = RELAYED
    const mirrored = fakeSession()
    controller.adopt(mirrored)
    await controller.mirrorSystem(mirrored)
    expect(mirrored.proxies).toEqual([label(RELAYED)])
  })

  it('is left as it is, mirror and all, when no relay is handed over', async () => {
    const { controller, active } = setup({ relay: false })
    active.config = RELAYED
    const made = fakeSession()
    controller.adopt(made)
    await flush()
    await controller.systemChanged()
    expect(made.proxies).toEqual([label(MIRRORED)])
  })

  it('never reaches a session on a front, on the dead end, in a temporary tunnel or setting a proxy of its own', async () => {
    const { controller, hub, active, own } = setup({ routed: true })
    const onFront = fakeSession()
    await controller.prepare(APP, onFront)
    const stopped = fakeSession()
    await controller.prepare('https://two.example', stopped)
    await controller.confineSite(stopped)
    const temporary = fakeSession()
    controller.adopt(temporary)
    await controller.prepareTemporary(temporary, { port: 4242, username: 'u', secret: 's' }, 'socks5')
    const web = fakeSession()
    controller.adopt(web)
    own.add(web)
    await flush()
    const front = await hub.front(APP)

    active.config = RELAYED
    await controller.systemChanged()

    expect(onFront.proxies).toEqual([`fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(stopped.proxies).toEqual(['fixed_servers:http://127.0.0.1:9'])
    expect(temporary.proxies).toEqual(['fixed_servers:http://127.0.0.1:4242'])
    expect(web.proxies).toEqual([])
  })
})

describe('a proxy challenge from the relay\'s listener', () => {
  it('is answered with the relay\'s credentials, and only for the relay\'s port on this computer', () => {
    const { controller, relay } = setup()
    expect(controller.challengeCredentials({ isProxy: true, host: '127.0.0.1', port: RELAY_PORT })).toEqual({ username: 'orivon', password: 'relay-secret' })
    expect(controller.challengeCredentials({ isProxy: true, host: '127.0.0.1', port: RELAY_PORT + 1 })).toBeUndefined()
    expect(relay.asked).toEqual([RELAY_PORT, RELAY_PORT + 1])
  })

  it('is never offered to the relay when it comes from a server, or is not a proxy\'s', () => {
    const { controller, relay } = setup()
    expect(controller.challengeCredentials({ isProxy: true, host: 'proxy.example', port: RELAY_PORT })).toBeUndefined()
    expect(controller.challengeCredentials({ isProxy: true, host: '10.0.0.5', port: RELAY_PORT })).toBeUndefined()
    expect(controller.challengeCredentials({ isProxy: false, host: '127.0.0.1', port: RELAY_PORT })).toBeUndefined()
    expect(relay.asked).toEqual([])
  })

  it('is not answered when no relay is handed over, and a front still answers for itself first', async () => {
    const without = setup({ relay: false })
    expect(without.controller.challengeCredentials({ isProxy: true, host: '127.0.0.1', port: RELAY_PORT })).toBeUndefined()

    const { controller, hub, relay } = setup({ routed: true })
    const front = await hub.front(APP)
    expect(controller.challengeCredentials({ isProxy: true, host: '127.0.0.1', port: front.port })).toEqual({ username: front.username, password: front.secret })
    expect(relay.asked, 'the relay is asked only when no front has the port').toEqual([])
  })

  it('reaches the application\'s login event, which signs in to the relay and leaves every other challenge to the person', () => {
    const { logins } = setup()
    expect(logins).toHaveLength(1)
    const listener = logins[0] as RouteLoginListener

    const prevented = vi.fn()
    const signedIn = vi.fn()
    listener({ preventDefault: prevented }, { isProxy: true, host: '127.0.0.1', port: RELAY_PORT }, signedIn)
    expect(prevented).toHaveBeenCalledOnce()
    expect(signedIn).toHaveBeenCalledWith('orivon', 'relay-secret')

    const left = vi.fn()
    const answered = vi.fn()
    listener({ preventDefault: left }, { isProxy: true, host: 'proxy.example', port: 3128 }, answered)
    expect(left).not.toHaveBeenCalled()
    expect(answered).not.toHaveBeenCalled()
  })
})
