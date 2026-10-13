// What routing an app does to Chromium: its sessions are pointed at the app's front and never at `direct`, every web
// contents in them gets the WebRTC policy that keeps UDP off the network, the broker's handles close when a route is
// switched, and the front's own proxy challenge is answered for that front alone.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouteController } from '../route-controller.js'
import type { RouteContents, RouteControllerDeps, RouteSession } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

interface FakeSession extends RouteSession { readonly name: string, readonly calls: string[], readonly proxies: string[] }

function fakeSession (name: string, log: string[]): FakeSession {
  const calls: string[] = []
  const proxies: string[] = []
  return {
    name,
    calls,
    proxies,
    setProxy: async (config) => { calls.push('setProxy'); proxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}`); log.push(`${name}.setProxy`) },
    closeAllConnections: async () => { calls.push('close'); log.push(`${name}.close`) }
  }
}

function fakeContents (session: RouteSession): RouteContents & { policy: string[] } {
  const policy: string[] = []
  return { session, policy, isDestroyed: () => false, setWebRTCIPHandlingPolicy: (value) => { policy.push(value) } }
}

function setup (routed: readonly string[] = []) {
  const store = new RouteStore(null)
  for (const origin of routed) store.set(origin, true)
  const hub = createRouteHub({ store, proxy: () => ({ host: '127.0.0.1', port: 9050 }), providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  const log: string[] = []
  const sessions = new Map<string, FakeSession>()
  const asked: string[] = []
  const sessionFor = (partition: string): FakeSession => {
    asked.push(partition)
    let one = sessions.get(partition)
    if (one === undefined) { one = fakeSession(partition, log); sessions.set(partition, one) }
    return one
  }
  const contents: Array<RouteContents & { policy: string[] }> = []
  let created: ((contents: RouteContents) => void) | undefined
  let login: Parameters<RouteControllerDeps['onLogin']>[0] | undefined
  const dropped: string[] = []
  const reloaded: string[] = []
  const deps: RouteControllerDeps = {
    hub,
    broker: () => ({ dropOrigin: async (origin) => { dropped.push(origin); log.push('broker.drop') } }),
    sessionFor,
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => contents,
    onContentsCreated: (listener) => { created = listener },
    onLogin: (listener) => { login = listener },
    reloadTabs: (origin) => { reloaded.push(origin); log.push('reload') }
  }
  const controller = createRouteController(deps)
  return { store, hub, controller, sessionFor, requested: () => [...new Set(asked)], contents, log, dropped, reloaded, created: (one: RouteContents) => { created?.(one) }, login: (...args: Parameters<NonNullable<typeof login>>) => { login?.(...args) } }
}

describe('preparing a session', () => {
  it('points a routed app\'s session at its front, with no direct fallback', async () => {
    const { hub, controller, sessionFor } = setup([APP])
    const session = sessionFor('app')

    await controller.prepare(APP, session)

    const front = await hub.front(APP)
    expect(session.proxies).toEqual([`fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(session.proxies.join()).not.toMatch(/direct/)
  })

  it('leaves the session of an app that is not routed alone', async () => {
    const { controller, sessionFor } = setup()
    const session = sessionFor('app')

    await controller.prepare(APP, session)

    expect(session.calls).toEqual([])
  })

  it('does not point the same session at the same front twice', async () => {
    const { controller, sessionFor } = setup([APP])
    const session = sessionFor('app')

    await controller.prepare(APP, session)
    await controller.prepare(APP, session)

    expect(session.calls).toEqual(['setProxy'])
  })

  it('prepares the app\'s embed session along with its own', async () => {
    const { controller, sessionFor } = setup([APP])

    await controller.appSessionRegistered(APP, sessionFor('app'))

    expect(sessionFor('app').calls).toEqual(['setProxy'])
    expect(sessionFor(`embed:${APP}`).calls).toEqual(['setProxy'])
  })
})

describe('an app that is not routed', () => {
  it('leaves its embed session uncreated: asking for a session creates one on disk', async () => {
    const { controller, sessionFor, requested } = setup()

    await controller.appSessionRegistered(APP, sessionFor('app'))

    expect(requested()).toEqual(['app'])
  })
})

describe('switching a route on', () => {
  it('points every session of the app at the front, then closes its connections and handles, then reloads its tabs', async () => {
    const { store, controller, sessionFor, log, dropped, reloaded } = setup()
    await controller.appSessionRegistered(APP, sessionFor('app'))
    log.length = 0

    store.set(APP, true)
    await controller.settled()

    expect(log.filter((entry) => entry.endsWith('.setProxy')).sort()).toEqual(['app.setProxy', `embed:${APP}.setProxy`])
    const lastSetProxy = Math.max(...log.map((entry, index) => entry.endsWith('.setProxy') ? index : -1))
    expect(log.indexOf('broker.drop')).toBeGreaterThan(lastSetProxy)
    expect(log.indexOf('app.close')).toBeGreaterThan(lastSetProxy)
    expect(log.indexOf('reload')).toBeGreaterThan(log.indexOf('app.close'))
    expect(dropped).toEqual([APP])
    expect(reloaded).toEqual([APP])
  })

  it('puts the WebRTC policy on the web contents already open in those sessions, and on no others', async () => {
    const { store, controller, sessionFor, contents } = setup()
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const inApp = fakeContents(sessionFor('app'))
    const inEmbed = fakeContents(sessionFor(`embed:${APP}`))
    const elsewhere = fakeContents(sessionFor('somewhere else'))
    contents.push(inApp, inEmbed, elsewhere)

    store.set(APP, true)
    await controller.settled()

    expect(inApp.policy).toEqual(['disable_non_proxied_udp'])
    expect(inEmbed.policy).toEqual(['disable_non_proxied_udp'])
    expect(elsewhere.policy).toEqual([])
  })

  it('gives the policy to a web contents created later in a routed session', async () => {
    const { controller, sessionFor, created } = setup([APP])
    await controller.appSessionRegistered(APP, sessionFor('app'))

    const popup = fakeContents(sessionFor('app'))
    const other = fakeContents(sessionFor('other'))
    created(popup)
    created(other)

    expect(popup.policy).toEqual(['disable_non_proxied_udp'])
    expect(other.policy).toEqual([])
  })
})

describe('switching a route off', () => {
  it('returns the sessions to the system\'s proxy, closes connections and handles, reloads, and restores the policy it set', async () => {
    const { store, controller, sessionFor, contents, dropped, reloaded } = setup()
    store.set(APP, true)
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const page = fakeContents(sessionFor('app'))
    contents.push(page)
    store.set(APP, false)
    store.set(APP, true)
    await controller.settled()
    dropped.length = 0
    reloaded.length = 0
    store.set(APP, false)
    await controller.settled()

    expect(sessionFor('app').proxies.at(-1)).toBe('system:')
    expect(page.policy.at(-1)).toBe('default')
    expect(dropped).toEqual([APP])
    expect(reloaded).toEqual([APP])
  })

  it('leaves the WebRTC policy of a session that confines itself alone, in either direction', async () => {
    const { store, controller, sessionFor, contents } = setup()
    const hostSession = sessionFor('child-host')
    const host = fakeContents(hostSession)
    contents.push(host)
    await controller.prepare(APP, hostSession, { webrtc: false })

    store.set(APP, true)
    await controller.settled()
    store.set(APP, false)
    await controller.settled()

    expect(hostSession.proxies).toEqual([expect.stringMatching(/^fixed_servers:/), 'system:'])
    expect(host.policy).toEqual([])
  })
})

describe('a session that cannot be pointed at the front', () => {
  it('gets a rule that reaches nothing, the other sessions are still pointed, and the connections and handles still close', async () => {
    const { store, controller, sessionFor, dropped, log } = setup()
    const broken = sessionFor('app')
    const original = broken.setProxy
    let refused = false
    broken.setProxy = async (config) => { if (!refused) { refused = true; throw new Error('no proxy for you') } await original(config) }
    await controller.appSessionRegistered(APP, broken)

    store.set(APP, true)
    await controller.settled()

    expect(broken.proxies.at(-1)).toBe('fixed_servers:http://127.0.0.1:9')
    expect(sessionFor(`embed:${APP}`).proxies).toEqual([expect.stringMatching(/^fixed_servers:http:\/\/127\.0\.0\.1:\d+$/)])
    expect(dropped).toEqual([APP])
    expect(log).toContain('app.close')
  })

  it('goes back to the system\'s proxy when the route is switched off, never staying on the rule that reaches nothing', async () => {
    const { store, controller, sessionFor } = setup()
    const broken = sessionFor('app')
    const original = broken.setProxy
    let refused = false
    broken.setProxy = async (config) => { if (!refused) { refused = true; throw new Error('no proxy for you') } await original(config) }
    await controller.appSessionRegistered(APP, broken)
    store.set(APP, true)
    await controller.settled()

    store.set(APP, false)
    await controller.settled()

    expect(broken.proxies.at(-1)).toBe('system:')
  })
})

describe('changing the proxy under a routed app', () => {
  it('closes connections and handles but does not reload the tabs', async () => {
    const { store, hub, controller, sessionFor, dropped, reloaded } = setup()
    store.set(APP, true)
    await controller.appSessionRegistered(APP, sessionFor('app'))
    await controller.settled()
    dropped.length = 0
    reloaded.length = 0
    const closesBefore = sessionFor('app').calls.filter((call) => call === 'close').length

    hub.proxyChanged()
    await controller.settled()

    expect(dropped).toEqual([APP])
    expect(reloaded).toEqual([])
    expect(sessionFor('app').calls.filter((call) => call === 'close').length).toBe(closesBefore + 1)
  })
})

describe('the front\'s proxy challenge', () => {
  it('is answered with the front\'s own credentials, for that front\'s port only', async () => {
    const { hub, controller, sessionFor, login } = setup([APP])
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const front = await hub.front(APP)

    const answered = vi.fn()
    const prevent = vi.fn()
    login({ preventDefault: prevent }, { isProxy: true, host: '127.0.0.1', port: front.port }, answered)
    expect(prevent).toHaveBeenCalled()
    expect(answered).toHaveBeenCalledWith(front.username, front.secret)

    const otherAnswered = vi.fn()
    const otherPrevent = vi.fn()
    login({ preventDefault: otherPrevent }, { isProxy: true, host: '127.0.0.1', port: front.port + 1 }, otherAnswered)
    login({ preventDefault: otherPrevent }, { isProxy: false, host: '127.0.0.1', port: front.port }, otherAnswered)
    login({ preventDefault: otherPrevent }, { isProxy: true, host: 'proxy.example', port: front.port }, otherAnswered)
    expect(otherPrevent).not.toHaveBeenCalled()
    expect(otherAnswered).not.toHaveBeenCalled()
  })
})

describe('the session lookups made about a routed app go through', () => {
  it('has none for an app that is not routed', async () => {
    const { controller } = setup()
    expect(await controller.fetchSessionFor(APP)).toBeUndefined()
  })

  it('is a session of its own, in memory, pointed at the front', async () => {
    const { hub, controller, sessionFor } = setup([APP])

    const session = await controller.fetchSessionFor(APP) as FakeSession

    const front = await hub.front(APP)
    expect(session.proxies).toEqual([`fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(session.name.startsWith('persist:')).toBe(false)
    expect(await controller.fetchSessionFor(APP)).toBe(session)
    expect(sessionFor(session.name)).toBe(session)
  })
})

describe('a temporary routed session', () => {
  const front = { port: 41_001, username: 'orivon', secret: 'temporary-secret' }

  it('is pointed at its own front, never at the app\'s, and stays there when an app\'s route changes', async () => {
    const { store, controller, sessionFor } = setup([APP])
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const session = sessionFor('temporary')

    await controller.prepareTemporary(session, front)
    store.set(APP, false)
    store.set(APP, true)
    await controller.settled()

    expect(session.proxies).toEqual(['fixed_servers:http://127.0.0.1:41001'])
    expect(session.proxies.join()).not.toMatch(/direct/)
  })

  it('puts the WebRTC policy on the web contents opened in it, and on no others', async () => {
    const { controller, sessionFor, created } = setup()
    const session = sessionFor('temporary')
    await controller.prepareTemporary(session, front)

    const inside = fakeContents(session)
    const outside = fakeContents(sessionFor('other'))
    created(inside)
    created(outside)

    expect(inside.policy).toEqual(['disable_non_proxied_udp'])
    expect(outside.policy).toEqual([])
  })

  it('has its front\'s challenge answered until it is released', async () => {
    const { controller, sessionFor, login } = setup()
    const session = sessionFor('temporary')
    await controller.prepareTemporary(session, front)

    const answered = vi.fn()
    login({ preventDefault: () => {} }, { isProxy: true, host: '127.0.0.1', port: front.port }, answered)
    expect(answered).toHaveBeenCalledWith('orivon', 'temporary-secret')

    controller.releaseTemporary(session, front)
    const after = vi.fn()
    login({ preventDefault: () => {} }, { isProxy: true, host: '127.0.0.1', port: front.port }, after)
    expect(after).not.toHaveBeenCalled()
  })
})
