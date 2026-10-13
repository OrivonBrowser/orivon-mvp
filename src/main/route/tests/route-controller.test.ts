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

interface FakeSession extends RouteSession { readonly name: string, readonly calls: string[], readonly proxies: string[], readonly bypass: string[] }

function fakeSession (name: string, log: string[]): FakeSession {
  const calls: string[] = []
  const proxies: string[] = []
  const bypass: string[] = []
  return {
    name,
    calls,
    proxies,
    bypass,
    setProxy: async (config) => { calls.push('setProxy'); proxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}`); bypass.push(config.proxyBypassRules ?? ''); log.push(`${name}.setProxy`) },
    closeAllConnections: async () => { calls.push('close'); log.push(`${name}.close`) }
  }
}

function fakeContents (session: RouteSession, reloads: string[] = [], url = 'https://news.example/'): RouteContents & { policy: string[] } {
  const policy: string[] = []
  const name = (session as Partial<FakeSession>).name ?? 'session'
  return { session, policy, isDestroyed: () => false, getType: () => 'window', getURL: () => url, reload: () => { reloads.push(name) }, setWebRTCIPHandlingPolicy: (value) => { policy.push(value) } }
}

interface SetupOptions { routed?: readonly string[], callTimeoutMs?: number, isApp?: (origin: string) => boolean, everywhere?: boolean, extra?: Partial<RouteControllerDeps> }

function setup (options: SetupOptions | readonly string[] = {}) {
  const { routed = [], callTimeoutMs, isApp, everywhere: startEverywhere = false, extra = {} } = Array.isArray(options) ? { routed: options as readonly string[] } as SetupOptions : options as SetupOptions
  const store = new RouteStore(null)
  for (const origin of routed) store.set(origin, true)
  let everywhere = startEverywhere
  const hub = createRouteHub({ store, proxy: () => ({ host: '127.0.0.1', port: 9050 }), everywhere: () => everywhere, ...(isApp === undefined ? {} : { isApp }), providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
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
  /** The sessions whose pages were reloaded, by name. */
  const reloaded: string[] = []
  const hangOn = new Set<string>()
  const deps: RouteControllerDeps = {
    hub,
    broker: () => ({
      dropOrigin: async (origin) => {
        dropped.push(origin)
        log.push(`broker.drop ${origin}`)
        if (hangOn.has(origin)) await new Promise<void>(() => {})
      }
    }),
    sessionFor,
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => contents,
    onContentsCreated: (listener) => { created = listener },
    onLogin: (listener) => { login = listener },
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
    ...(isApp === undefined ? {} : { isApp }),
    ...extra
  }
  const controller = createRouteController(deps)
  /** A web contents in `session`, which the controller sees among all of them. */
  const page = (session: RouteSession): RouteContents & { policy: string[] } => {
    const one = fakeContents(session, reloaded)
    contents.push(one)
    return one
  }
  const flip = (next: boolean): void => { const previous = everywhere; everywhere = next; hub.everywhereChanged(previous) }
  return { store, hub, controller, sessionFor, flip, requested: () => [...new Set(asked)], contents, page, hangOn, log, dropped, reloaded, created: (one: RouteContents) => { created?.(one) }, login: (...args: Parameters<NonNullable<typeof login>>) => { login?.(...args) } }
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

describe('an app\'s session that cannot be pointed when it is registered', () => {
  it('is held on the rule that reaches nothing, and the failure is passed on so the loader does not open the app as a website', async () => {
    const { controller, sessionFor } = setup([APP])
    const broken = sessionFor('app')
    const original = broken.setProxy
    let refused = false
    broken.setProxy = async (config) => { if (!refused && config.proxyRules !== 'http://127.0.0.1:9') { refused = true; throw new Error('no proxy for you') } await original(config) }

    await expect(controller.appSessionRegistered(APP, broken)).rejects.toThrow('no proxy for you')

    expect(broken.proxies.at(-1)).toBe('fixed_servers:http://127.0.0.1:9')
  })

  it('is passed on without touching the session of an app that is not routed', async () => {
    const { controller, sessionFor } = setup()
    const session = sessionFor('app')
    session.setProxy = async () => { throw new Error('unused') }
    await expect(controller.appSessionRegistered(APP, session)).resolves.toBeUndefined()
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
  it('points every session of the app at the front and closes its connections, then closes its handles, then reloads every page in those sessions', async () => {
    const { store, controller, sessionFor, page, log, dropped, reloaded } = setup()
    await controller.appSessionRegistered(APP, sessionFor('app'))
    page(sessionFor('app'))
    page(sessionFor(`embed:${APP}`))
    log.length = 0

    store.set(APP, true)
    await controller.settled()

    expect([...new Set(log.filter((entry) => entry.endsWith('.setProxy')))].sort()).toEqual(['app.setProxy', `embed:${APP}.setProxy`])
    const lastSetProxy = Math.max(...log.map((entry, index) => entry.endsWith('.setProxy') ? index : -1))
    expect(log.indexOf('app.close'), 'connections close once the sessions are pointed').toBeGreaterThan(lastSetProxy)
    expect(log.indexOf(`broker.drop ${APP}`), 'handles close after the sessions are pointed and their connections closed').toBeGreaterThan(log.indexOf('app.close'))
    expect(dropped).toEqual([APP])
    expect(reloaded.sort()).toEqual(['app', `embed:${APP}`])
  })

  it('reloads the embeds, the child host and a popup too, and no page of any other session', async () => {
    const { store, controller, sessionFor, page, reloaded } = setup()
    const host = sessionFor('child-host')
    await controller.appSessionRegistered(APP, sessionFor('app'))
    await controller.prepare(APP, host, { webrtc: false })
    page(sessionFor('app'))
    page(sessionFor('app'))
    page(host)
    page(sessionFor(`embed:${APP}`))
    page(sessionFor('somewhere else'))

    store.set(APP, true)
    await controller.settled()

    expect(reloaded.sort()).toEqual(['app', 'app', 'child-host', `embed:${APP}`])
  })

  it('leaves a developer tools page alone', async () => {
    const { store, controller, sessionFor, contents, reloaded } = setup()
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const tools = fakeContents(sessionFor('app'), reloaded)
    ;(tools as { getType: () => string }).getType = () => 'remote'
    contents.push(tools)

    store.set(APP, true)
    await controller.settled()

    expect(reloaded).toEqual([])
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
    const { store, controller, sessionFor, page: pageIn, dropped, reloaded } = setup()
    store.set(APP, true)
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const page = pageIn(sessionFor('app'))
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
    expect(reloaded).toEqual(['app'])
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

    expect(hostSession.proxies).toEqual(['fixed_servers:http://127.0.0.1:9', expect.stringMatching(/^fixed_servers:http:\/\/127\.0\.0\.1:\d+$/), 'system:'])
    expect(host.policy).toEqual([])
  })
})

describe('a session that cannot be pointed at the front', () => {
  it('gets a rule that reaches nothing, the other sessions are still pointed, and the connections and handles still close', async () => {
    const { store, controller, sessionFor, dropped, log } = setup()
    const broken = sessionFor('app')
    const original = broken.setProxy
    let refused = false
    broken.setProxy = async (config) => { if (!refused && config.proxyRules !== 'http://127.0.0.1:9') { refused = true; throw new Error('no proxy for you') } await original(config) }
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
    broken.setProxy = async (config) => { if (!refused && config.proxyRules !== 'http://127.0.0.1:9') { refused = true; throw new Error('no proxy for you') } await original(config) }
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
    const { store, hub, controller, sessionFor, page, dropped, reloaded } = setup()
    store.set(APP, true)
    await controller.appSessionRegistered(APP, sessionFor('app'))
    page(sessionFor('app'))
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

describe('what stays off the proxy', () => {
  it('bypasses this machine alone: Chromium\'s implicit bypass of link-local addresses is taken away, so the local network goes through the front', async () => {
    const { controller, sessionFor } = setup([APP])
    const session = sessionFor('app')

    await controller.prepare(APP, session)

    expect(session.bypass).toEqual(['<-loopback>;localhost;*.localhost;127.0.0.1/8;[::1]'])
  })

  it('gives the rule that reaches nothing no bypass at all but the one that cancels the implicit ones', async () => {
    const { store, controller, sessionFor } = setup()
    const broken = sessionFor('app')
    const original = broken.setProxy
    let refused = false
    broken.setProxy = async (config) => { if (!refused && config.proxyRules !== 'http://127.0.0.1:9') { refused = true; throw new Error('no proxy for you') } await original(config) }
    await controller.appSessionRegistered(APP, broken)

    store.set(APP, true)
    await controller.settled()

    expect(broken.proxies.at(-1)).toBe('fixed_servers:http://127.0.0.1:9')
    expect(broken.bypass.at(-1)).toBe('<-loopback>')
  })
})

describe('an app whose handles will not close', () => {
  const OTHER = 'https://two.example'
  async function until (done: () => boolean): Promise<void> {
    for (let waited = 0; waited < 2000 && !done(); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done()).toBe(true)
  }

  it('has its sessions pointed and their connections closed before the broker is asked, and does not hold another app\'s switch', async () => {
    const { store, controller, sessionFor, page, hangOn, log, reloaded } = setup({ callTimeoutMs: 400 })
    await controller.appSessionRegistered(APP, sessionFor('app'))
    await controller.appSessionRegistered(OTHER, sessionFor('other'))
    page(sessionFor('app'))
    page(sessionFor('other'))
    hangOn.add(APP)
    log.length = 0

    store.set(APP, true)
    store.set(OTHER, true)
    await until(() => reloaded.includes('other'))

    expect(log.indexOf('app.setProxy')).toBeLessThan(log.indexOf('app.close'))
    expect(log.indexOf('app.close'), 'the hung app\'s connections were closed before its handles were asked about').toBeLessThan(log.indexOf(`broker.drop ${APP}`))
    expect(sessionFor('other').proxies.at(-1)).toMatch(/^fixed_servers:/)
    expect(reloaded, 'the app whose handles hang waits for them, the other does not').not.toContain('app')

    await controller.settled()
    expect(reloaded.sort(), 'and is reloaded once the wait is over').toEqual(['app', 'other'])
  })
})

describe('a switch-off that could not put a session back', () => {
  it('tries again, and the session ends on the system\'s proxy', async () => {
    const { store, controller, sessionFor } = setup()
    const session = sessionFor('app')
    const original = session.setProxy
    let refused = 0
    session.setProxy = async (config) => { if (config.mode === 'system' && refused < 1) { refused += 1; throw new Error('not now') } await original(config) }
    store.set(APP, true)
    await controller.appSessionRegistered(APP, session)

    store.set(APP, false)
    await controller.settled()

    expect(session.proxies.at(-1)).toBe('system:')
  })

  it('stays marked as pointed at the front while it could not be put back, so the next pass tries once more', async () => {
    const { store, controller, sessionFor } = setup()
    const session = sessionFor('app')
    const original = session.setProxy
    let broken = true
    session.setProxy = async (config) => { if (config.mode === 'system' && broken) throw new Error('not now'); await original(config) }
    store.set(APP, true)
    await controller.appSessionRegistered(APP, session)
    store.set(APP, false)
    await controller.settled()
    expect(session.proxies.at(-1)).toMatch(/^fixed_servers:/)

    broken = false
    await controller.prepare(APP, session)

    expect(session.proxies.at(-1)).toBe('system:')
  })
})

describe('an app that was forgotten while a session could not be put back', () => {
  it('tries that session once more, and keeps it marked if it still cannot, so a later pass repairs it', async () => {
    const { store, controller, sessionFor } = setup()
    const session = sessionFor('app')
    const original = session.setProxy
    let broken = true
    session.setProxy = async (config) => { if (config.mode === 'system' && broken) throw new Error('not now'); await original(config) }
    store.set(APP, true)
    await controller.appSessionRegistered(APP, session)
    store.set(APP, false)
    await controller.settled()
    controller.forget(APP)
    await controller.settled()
    expect(session.proxies.at(-1)).toMatch(/^fixed_servers:/)

    broken = false
    await controller.prepare(APP, session)

    expect(session.proxies.at(-1)).toBe('system:')
  })

  it('puts it back during the forgetting when it can', async () => {
    const { store, controller, sessionFor } = setup()
    const session = sessionFor('app')
    const original = session.setProxy
    let failures = 2
    session.setProxy = async (config) => { if (config.mode === 'system' && failures > 0) { failures -= 1; throw new Error('not now') } await original(config) }
    store.set(APP, true)
    await controller.appSessionRegistered(APP, session)
    store.set(APP, false)
    await controller.settled()
    controller.forget(APP)
    await controller.settled()

    expect(session.proxies.at(-1)).toBe('system:')
  })
})

describe('an app that was forgotten', () => {
  it('drops the sessions it knew, so switching it on again points only the ones registered anew', async () => {
    const { store, hub, controller, sessionFor } = setup()
    store.set(APP, true)
    await controller.appSessionRegistered(APP, sessionFor('app'))
    await controller.settled()

    store.set(APP, false)
    controller.forget(APP)
    await controller.settled()
    const before = sessionFor('app').calls.length
    store.set(APP, true)
    await controller.settled()

    expect(hub.isRouted(APP)).toBe(true)
    expect(sessionFor('app').calls.length, 'the dropped session is not touched').toBe(before)
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

describe('the credentials for a front\'s challenge', () => {
  it('are given to a request made from main for that front\'s port only', async () => {
    const { hub, controller, sessionFor } = setup([APP])
    await controller.appSessionRegistered(APP, sessionFor('app'))
    const front = await hub.front(APP)

    expect(controller.challengeCredentials({ isProxy: true, host: '127.0.0.1', port: front.port })).toEqual({ username: front.username, password: front.secret })
    expect(controller.challengeCredentials({ isProxy: true, host: '127.0.0.1', port: front.port + 1 })).toBeUndefined()
    expect(controller.challengeCredentials({ isProxy: false, host: '127.0.0.1', port: front.port })).toBeUndefined()
    expect(controller.challengeCredentials({ isProxy: true, host: 'proxy.example', port: front.port })).toBeUndefined()
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

describe('a website\'s session of its own', () => {
  const SITE = 'https://news.example'
  const VERIFIED = '*.eth;*.orivon'

  it('is pointed at the website\'s front, with this machine and the verifier\'s names reaching it without the proxy, and no direct fallback', async () => {
    const { hub, controller, sessionFor, store } = setup({ isApp: () => false })
    store.setEntry(SITE, 'on')
    const session = sessionFor('site')

    await controller.prepareSite(SITE, session, VERIFIED)

    const front = await hub.front(SITE)
    expect(session.proxies).toEqual([`fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(session.bypass[0]).toBe(`<-loopback>;localhost;*.localhost;127.0.0.1/8;[::1];${VERIFIED}`)
    expect(session.proxies.join()).not.toMatch(/direct/)
  })

  it('gives web contents in it the WebRTC policy that keeps UDP off the network, while the website is routed', async () => {
    const { controller, sessionFor, store, created, page } = setup({ isApp: () => false })
    store.setEntry(SITE, 'on')
    const session = sessionFor('site')
    await controller.prepareSite(SITE, session, VERIFIED)

    const one = page(session)
    created(one)

    expect(one.policy).toEqual(['disable_non_proxied_udp'])
  })

  it('makes no embed session and reloads no page when the website is switched, because its tab moves instead', async () => {
    const { controller, sessionFor, store, page, requested, reloaded, dropped } = setup({ isApp: () => false })
    const session = sessionFor('site')
    await controller.prepareSite(SITE, session, VERIFIED)
    page(session)

    store.setEntry(SITE, 'on')
    await controller.settled()

    expect(requested()).not.toContain(`embed:${SITE}`)
    expect(reloaded).toEqual([])
    expect(dropped, 'a website has no broker handles to close').toEqual([])
    expect(session.proxies.at(-1)).toMatch(/^fixed_servers:/)
  })

  it('goes back to the system\'s proxy when the website\'s tunnel is turned off, keeping the session', async () => {
    const { controller, sessionFor, store } = setup({ isApp: () => false })
    store.setEntry(SITE, 'on')
    const session = sessionFor('site')
    await controller.prepareSite(SITE, session, VERIFIED)

    store.setEntry(SITE, undefined)
    await controller.settled()

    expect(session.proxies.at(-1)).toBe('system:')
  })

  it('keeps an app\'s behaviour: its embed session is made and its pages reload on a switch', async () => {
    const { controller, sessionFor, store, page, requested, reloaded } = setup()
    const session = sessionFor('app')
    await controller.prepare(APP, session)
    page(session)

    store.set(APP, true)
    await controller.settled()

    expect(requested()).toContain(`embed:${APP}`)
    expect(reloaded).toEqual(['app'])
  })

  it('can be confined to a rule that reaches nothing', async () => {
    const { controller, sessionFor } = setup()
    const session = sessionFor('site')
    await controller.confineSite(session)
    expect(session.proxies).toEqual(['fixed_servers:http://127.0.0.1:9'])
    expect(session.bypass).toEqual(['<-loopback>'])
  })
})


describe('the shared identity, while the whole browser is on the tunnel', () => {
  const ownProxy = new WeakSet<object>()
  const appProxies: string[] = []
  function shared (everywhere = false) {
    appProxies.length = 0
    let defaultRef: FakeSession | undefined
    const world = setup({
      everywhere,
      isApp: (origin) => origin === APP,
      extra: {
        setAppProxy: async (config) => { appProxies.push(`${config.mode ?? ''}:${config.proxyRules ?? ''}:${config.proxyBypassRules ?? ''}`) },
        ownProxy: (session) => ownProxy.has(session),
        sharedBypass: () => '*.eth',
        defaultSession: () => defaultRef as FakeSession
      }
    })
    const defaultSession = world.sessionFor('default')
    defaultRef = defaultSession
    return { ...world, defaultSession }
  }

  it('stops a session at once when it is made, and points it at the shared front, with the names the verifier answers for left out of the proxy', async () => {
    const { controller, hub, sessionFor, defaultSession } = shared(true)
    const made = sessionFor('somewhere')
    controller.adopt(made)
    expect(made.proxies[0], 'in the same turn').toBe('fixed_servers:http://127.0.0.1:9')
    await controller.settled()
    const front = await hub.front('orivon-shared-tunnel')
    expect(made.proxies).toEqual(['fixed_servers:http://127.0.0.1:9', `fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(made.bypass[1]).toContain('*.eth')
    expect(defaultSession.proxies).toEqual([])
  })

  it('points the default session and the runtime\'s own requests at the shared front when it flips on, and back at the system when it flips off', async () => {
    const { controller, hub, defaultSession, flip, page } = shared(false)
    controller.adopt(defaultSession)
    const tab = page(defaultSession)

    flip(true)
    await controller.settled()
    const front = await hub.front('orivon-shared-tunnel')
    expect(defaultSession.proxies, 'stopped first, then pointed').toEqual(['fixed_servers:http://127.0.0.1:9', `fixed_servers:http://127.0.0.1:${String(front.port)}`])
    expect(appProxies).toEqual(['fixed_servers:http://127.0.0.1:9:<-loopback>', `fixed_servers:http://127.0.0.1:${String(front.port)}:<-loopback>;localhost;*.localhost;127.0.0.1/8;[::1]`])
    expect(tab.policy).toEqual(['disable_non_proxied_udp'])

    flip(false)
    await controller.settled()
    expect(defaultSession.proxies.at(-1)).toBe('system:')
    expect(appProxies.at(-1)).toBe('system::')
    expect(tab.policy).toEqual(['disable_non_proxied_udp', 'default'])
  })

  it('reloads the web pages of the shared session when it flips, and not the shell\'s own pages', async () => {
    const { controller, defaultSession, flip, reloaded, contents } = shared(false)
    controller.adopt(defaultSession)
    contents.push({ ...fakeContents(defaultSession, reloaded, 'https://news.example/'), reload: () => { reloaded.push('web') } })
    contents.push({ ...fakeContents(defaultSession, reloaded, 'orivon://settings/'), reload: () => { reloaded.push('shell') } })

    flip(true)
    await controller.settled()

    expect(reloaded).toEqual(['web'])
  })

  it('takes a session away from the shared identity once an origin prepares it, and puts an app set to off back on the system\'s proxy', async () => {
    const { controller, store, sessionFor, flip } = shared(true)
    store.setEntry(APP, 'off')
    const appSession = sessionFor('app')
    controller.adopt(appSession)
    await controller.appSessionRegistered(APP, appSession)
    await controller.settled()
    expect(appSession.proxies.at(-1)).toBe('system:')
    flip(false)
    flip(true)
    await controller.settled()
    expect(appSession.proxies.at(-1), 'the shared identity does not repoint it').toBe('system:')
  })

  it('leaves a session that sets its own proxy alone', async () => {
    const { controller, sessionFor } = shared(true)
    const confined = sessionFor('web-context')
    ownProxy.add(confined)
    controller.adopt(confined)
    await controller.settled()
    expect(confined.proxies).toEqual(['fixed_servers:http://127.0.0.1:9'])
  })

  it('remembers a session made while the setting was off, and points it when the setting flips on', async () => {
    const { controller, hub, sessionFor, flip } = shared(false)
    const made = sessionFor('later')
    controller.adopt(made)
    expect(made.proxies).toEqual([])
    flip(true)
    await controller.settled()
    const front = await hub.front('orivon-shared-tunnel')
    expect(made.proxies).toEqual(['fixed_servers:http://127.0.0.1:9', `fixed_servers:http://127.0.0.1:${String(front.port)}`])
  })

  it('stops the runtime\'s own requests when the shared front cannot be had', async () => {
    const { controller, hub, flip } = shared(false)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(hub, 'front').mockRejectedValue(new Error('no port'))
    flip(true)
    await controller.settled()
    expect(appProxies.at(-1)).toBe('fixed_servers:http://127.0.0.1:9:<-loopback>')
  })

  it('looks up a website that follows the default through the default session, a tunnel-profile website through its profile, and an app through its own', async () => {
    const { controller, defaultSession, store, sessionFor } = shared(true)
    store.setEntry('https://profile.example', 'on')
    store.setEntry('https://direct.example', 'off')

    expect(await controller.fetchSessionFor('https://plain.example')).toBe(defaultSession)
    expect(await controller.fetchSessionFor('https://profile.example')).toBe(sessionFor('persist:tunnel-profile'))
    expect(await controller.fetchSessionFor('https://direct.example'), 'an origin set to off is not looked up through the tunnel').toBeUndefined()
    const app = await controller.fetchSessionFor(APP)
    expect(app).not.toBe(defaultSession)
    expect(app).toBeDefined()
  })
})
