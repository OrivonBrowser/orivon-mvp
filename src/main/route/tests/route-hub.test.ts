// The hub: which apps are routed, through which proxy, with one provider per app and one front per routed app. A
// routed app never falls back to a direct route: with no proxy set its route refuses.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouteProvider } from '../../../broker/route/provider.js'
import type { RouteTarget } from '../../../broker/route/table.js'
import { createRouteHub, DIRECT_PROFILE_ORIGIN, NYM_PROFILE_ORIGIN, PROXY_PROFILE_ORIGIN, profileOrigin, SHARED_ORIGIN } from '../route-hub.js'
import type { TunnelKind } from '../route-state.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'
const OTHER = 'https://two.example'
const hubs: RouteHub[] = []
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.dispose() })

function setup (initial: RouteTarget | undefined = { host: '127.0.0.1', port: 9050 }) {
  const store = new RouteStore(null)
  let proxy: RouteTarget | undefined = initial
  const built: Array<{ key: string, target: RouteTarget, provider: RouteProvider }> = []
  const hub = createRouteHub({
    store,
    targetOf: () => proxy, defaultKind: () => 'socks5',
    providerFor: (key, target) => {
      const provider: RouteProvider = { connect: async () => { throw new Error(`fake provider for ${key}`) } }
      built.push({ key, target, provider })
      return provider
    }
  })
  hubs.push(hub)
  return { store, hub, built, setProxy: (next: RouteTarget | undefined) => { proxy = next; hub.addressChanged() } }
}

describe('routeFor', () => {
  it('has no route for an app that is not routed', () => {
    const { hub } = setup()
    expect(hub.routeFor(APP)).toBeUndefined()
  })

  it('has a route through the proxy for a routed app, one provider per app', () => {
    const { hub, store, built } = setup()
    store.setEntry(APP, 'socks5')
    store.setEntry(OTHER, 'socks5')

    const route = hub.routeFor(APP)

    expect(route).toBeDefined()
    expect(hub.routeFor(APP)).toBe(route)
    expect(hub.routeFor(OTHER)).not.toBe(route)
    expect(built.map((one) => one.key).sort()).toEqual([APP, OTHER])
    expect(built[0]?.target).toEqual({ host: '127.0.0.1', port: 9050 })
  })

  it('refuses, never goes direct, for a routed app when no proxy is set', async () => {
    const { hub, store } = setup(undefined)
    store.setEntry(APP, 'socks5')

    const route = hub.routeFor(APP)

    expect(route).toBeDefined()
    await expect(route?.provider.connect('x.test', 443, new AbortController().signal)).rejects.toThrow()
    expect(route?.provider.udp).toBeUndefined()
    expect(route?.provider.resolve).toBeUndefined()
  })

  it('follows the proxy as it changes, and the switch as it flips', () => {
    const { hub, store, built, setProxy } = setup()
    store.setEntry(APP, 'socks5')
    const first = hub.routeFor(APP)

    setProxy({ host: '127.0.0.1', port: 9150 })
    const second = hub.routeFor(APP)
    expect(second).not.toBe(first)
    expect(built.at(-1)?.target).toEqual({ host: '127.0.0.1', port: 9150 })

    store.setEntry(APP, undefined)
    expect(hub.routeFor(APP)).toBeUndefined()
  })
})

describe('state', () => {
  it('says off, no proxy, or idle before the route has carried anything', () => {
    const { hub, store, setProxy } = setup()
    expect(hub.state(APP)).toBe('off')
    store.setEntry(APP, 'socks5')
    expect(hub.state(APP)).toBe('idle')
    setProxy(undefined)
    expect(hub.state(APP)).toBe('no-proxy')
  })

  it('says down once the route failed to carry something', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    const front = await hub.front(APP)
    expect(hub.state(APP)).toBe('idle')

    await new Promise<void>((resolve) => {
      const socket = netConnect({ host: '127.0.0.1', port: front.port })
      socket.once('connect', () => { socket.write(`CONNECT x.test:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${front.username}:${front.secret}`).toString('base64')}\r\n\r\n`) })
      socket.once('close', () => { resolve() })
      socket.resume()
    })

    expect(hub.state(APP)).toBe('down')
  })
})

describe('state after a refusal by the proxy', () => {
  it('stays up when the proxy refused one destination, and goes down only when the route could not be used', async () => {
    const store = new RouteStore(null)
    let failure = new Error('Socks5 proxy rejected connection - HostUnreachable')
    const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', providerFor: () => ({ connect: async () => { throw failure } }) })
    hubs.push(hub)
    store.setEntry(APP, 'socks5')
    const route = hub.routeFor(APP)

    await expect(route?.provider.connect('nowhere.test', 443, new AbortController().signal)).rejects.toThrow('HostUnreachable')
    expect(hub.state(APP)).toBe('ok')

    failure = new Error('connect ECONNREFUSED 127.0.0.1:9050')
    await expect(route?.provider.connect('nowhere.test', 443, new AbortController().signal)).rejects.toThrow('ECONNREFUSED')
    expect(hub.state(APP)).toBe('down')
  })
})

describe('onChange', () => {
  it('tells listeners when a route is switched, and when the proxy changes under a routed app, but not for an app that is not routed', () => {
    const { hub, store, setProxy } = setup()
    const heard = vi.fn()
    hub.onChange(heard)

    store.setEntry(APP, 'socks5')
    expect(heard.mock.calls).toEqual([[APP, true, 'switch']])

    setProxy({ host: '127.0.0.1', port: 9150 })
    expect(heard.mock.calls).toEqual([[APP, true, 'switch'], [APP, true, 'proxy']])

    store.setEntry(APP, undefined)
    expect(heard.mock.calls.at(-1)).toEqual([APP, false, 'switch'])
    heard.mockClear()
    setProxy({ host: '127.0.0.1', port: 9250 })
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('front', () => {
  it('starts one front per routed app and reuses it', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    store.setEntry(OTHER, 'socks5')

    const one = await hub.front(APP)
    expect(await hub.front(APP)).toBe(one)
    expect((await hub.front(OTHER)).port).not.toBe(one.port)
    expect((await hub.front(OTHER)).secret).not.toBe(one.secret)
  })

  it('refuses to start a front for an app that is not routed', async () => {
    const { hub } = setup()
    await expect(hub.front(APP)).rejects.toThrow()
  })

  it('stops the front when the route is switched off, and starts a new one when it is switched on again', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    const first = await hub.front(APP)

    store.setEntry(APP, undefined)
    await hub.settled()
    store.setEntry(APP, 'socks5')
    const second = await hub.front(APP)

    expect(second).not.toBe(first)
    expect(second.secret).not.toBe(first.secret)
  })

  it('knows which front an authentication challenge came from, by its port', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    const front = await hub.front(APP)

    expect(hub.credentialsForPort(front.port)).toEqual({ username: front.username, password: front.secret })
    expect(hub.credentialsForPort(front.port + 1)).toBeUndefined()
  })

  it('hands the secret of a port to nobody once its front is closing, so a later program on that port is not answered', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    const front = await hub.front(APP)

    store.setEntry(APP, undefined)

    expect(hub.credentialsForPort(front.port)).toBeUndefined()
    await hub.settled()
    expect(hub.credentialsForPort(front.port)).toBeUndefined()
  })

  it('hands the secret of a port to nobody once the app\'s front was closed by anything else', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    const front = await hub.front(APP)

    await front.close()

    expect(hub.credentialsForPort(front.port)).toBeUndefined()
    const next = await hub.front(APP)
    expect(next).not.toBe(front)
    expect(hub.credentialsForPort(next.port)).toEqual({ username: next.username, password: next.secret })
  })

  it('hands no secret out after the hub is disposed', async () => {
    const { hub, store } = setup()
    store.setEntry(APP, 'socks5')
    const front = await hub.front(APP)

    await hub.dispose()

    expect(hub.credentialsForPort(front.port)).toBeUndefined()
  })
})

describe('a list of routed apps that cannot be read', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  function unreadable (initial: RouteTarget | null = { host: '127.0.0.1', port: 9050 }, installed: string[] = [APP, OTHER]) {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-routes-hub-'))
    dirs.push(dir)
    const path = join(dir, 'routes.json')
    writeFileSync(path, '{ not json')
    const store = new RouteStore(path)
    let proxy: RouteTarget | undefined = initial ?? undefined
    const hub = createRouteHub({ store, targetOf: () => proxy, defaultKind: () => 'socks5', installed: () => installed, isApp: (origin) => installed.includes(origin), providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
    hubs.push(hub)
    return { store, hub, setProxy: (next: RouteTarget | undefined) => { proxy = next; hub.addressChanged() } }
  }

  it('routes every origin while a tunnel is set, installed apps and websites alike, through it', () => {
    const { hub } = unreadable()

    expect(hub.isRouted(APP)).toBe(true)
    expect(hub.isRouted('https://a-website.example')).toBe(true)
    expect(hub.routeFor('https://a-website.example')).toBeDefined()
    expect(hub.profileFor('https://a-website.example')).toBe('socks5')
    expect(hub.routeFor(OTHER)).toBeDefined()
    expect(hub.unreadable()).toBe(true)
  })

  it('leaves the shared identity to the browser-wide setting: Orivon\'s own requests do not change with an unreadable list', () => {
    const { hub } = unreadable()
    expect(hub.isRouted(SHARED_ORIGIN)).toBe(false)
  })

  it('routes nothing while no proxy is set', () => {
    const { hub } = unreadable(null)

    expect(hub.isRouted(APP)).toBe(false)
    expect(hub.routeFor(APP)).toBeUndefined()
  })

  it('starts a front for any app', async () => {
    const { hub } = unreadable()
    expect((await hub.front(APP)).port).toBeGreaterThan(0)
  })

  it('tells listeners about every installed app when the proxy is set or cleared, because that changes what is routed', () => {
    const { hub, setProxy } = unreadable(null)
    const heard = vi.fn()
    hub.onChange(heard)

    setProxy({ host: '127.0.0.1', port: 9050 })
    expect(heard.mock.calls).toEqual([[APP, true, 'proxy'], [OTHER, true, 'proxy']])

    heard.mockClear()
    setProxy(undefined)
    expect(heard.mock.calls).toEqual([[APP, false, 'proxy'], [OTHER, false, 'proxy']])
  })

  it('tells listeners the shared identity changed when the browser-wide setting flips, even with an unreadable list and a proxy set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-routes-hub-'))
    dirs.push(dir)
    const path = join(dir, 'routes.json')
    writeFileSync(path, '{ not json')
    let everywhere = false
    const hub = createRouteHub({ store: new RouteStore(path), targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', installed: () => [], everywhere: () => everywhere, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
    hubs.push(hub)
    const heard = vi.fn()
    hub.onChange(heard)

    everywhere = true
    hub.everywhereChanged(false)
    expect(heard.mock.calls).toEqual([[SHARED_ORIGIN, true, 'switch']])

    heard.mockClear()
    everywhere = false
    hub.everywhereChanged(true)
    expect(heard.mock.calls).toEqual([[SHARED_ORIGIN, false, 'switch']])
  })

  it('is not unreadable when the list is fine', () => {
    expect(setup().hub.unreadable()).toBe(false)
  })
})

describe('a website in the hub', () => {
  const SITE = 'https://news.example'
  const SITE_TWO = 'https://other.example'

  function website (options: { everywhere?: () => boolean, proxy?: RouteTarget | undefined } = {}) {
    const store = new RouteStore(null)
    let proxy: RouteTarget | undefined = 'proxy' in options ? options.proxy : { host: '127.0.0.1', port: 9050 }
    const built: Array<{ key: string }> = []
    const hub = createRouteHub({
      store,
      targetOf: () => proxy, defaultKind: () => 'socks5',
      isApp: (origin) => origin === APP || origin === OTHER,
      ...(options.everywhere === undefined ? {} : { everywhere: options.everywhere }),
      providerFor: (key) => { built.push({ key }); return { connect: async () => { throw new Error(`fake provider for ${key}`) } } }
    })
    hubs.push(hub)
    return { store, hub, built, setProxy: (next: RouteTarget | undefined) => { proxy = next; hub.addressChanged() } }
  }

  it('is routed by an on entry of its own and by nothing else, with the default off, and then lives in the tunnel profile', () => {
    const { hub, store } = website()
    expect(hub.isRouted(SITE)).toBe(false)
    expect(hub.profileFor(SITE)).toBeUndefined()

    store.setEntry(SITE, 'socks5')
    expect(hub.isRouted(SITE)).toBe(true)
    expect(hub.profileFor(SITE)).toBe('socks5')
    expect(hub.routeFor(SITE)).toBeDefined()
  })

  it('lives in the direct profile with an off entry, whatever the default says', () => {
    for (const everywhere of [false, true]) {
      const { hub, store } = website({ everywhere: () => everywhere })
      store.setEntry(SITE, 'off')
      expect(hub.isRouted(SITE), String(everywhere)).toBe(false)
      expect(hub.profileFor(SITE), String(everywhere)).toBe('direct')
    }
  })

  it('changes nothing for the site when an off entry is stored while the default is off, except where it lives', () => {
    const { hub, store } = website()
    const heard = vi.fn()
    hub.onChange(heard)

    store.setEntry(SITE, 'off')

    expect(hub.isRouted(SITE)).toBe(false)
    expect(heard).not.toHaveBeenCalled()
  })

  it('shares one front and one set of tunnel credentials among every website with an on entry, and gives an app its own', async () => {
    const { hub, store, built } = website()
    store.setEntry(SITE, 'socks5')
    store.setEntry(SITE_TWO, 'socks5')
    store.setEntry(APP, 'socks5')
    hub.routeFor(SITE)
    hub.routeFor(SITE_TWO)
    hub.routeFor(APP)
    expect(built.map((one) => one.key).sort()).toEqual([PROXY_PROFILE_ORIGIN, APP].sort())
    const one = await hub.front(SITE)
    const two = await hub.front(SITE_TWO)
    expect(two.port).toBe(one.port)
    expect((await hub.front(APP)).port).not.toBe(one.port)
  })

  it('answers for the tunnel profile as a route that is always on, and for the direct profile as one that never is', () => {
    const { hub } = website()
    expect(hub.isRouted(PROXY_PROFILE_ORIGIN)).toBe(true)
    expect(hub.isRouted(DIRECT_PROFILE_ORIGIN)).toBe(false)
  })

  it('tells listeners when its tunnel is turned on and off', async () => {
    const { hub, store } = website()
    const heard = vi.fn()
    hub.onChange(heard)
    store.setEntry(SITE, 'socks5')
    expect((await hub.front(SITE)).port).toBeGreaterThan(0)
    store.setEntry(SITE, undefined)
    await hub.settled()
    expect(heard.mock.calls).toEqual([[SITE, true, 'switch'], [SITE, false, 'switch']])
    await expect(hub.front(SITE)).rejects.toThrow(/not routed/)
  })

  it('has the proxy changing affect the tunnel profile and the shared identity too', async () => {
    const { hub, store, setProxy } = website()
    store.setEntry(SITE, 'socks5')
    await hub.front(SITE)
    const heard = vi.fn()
    hub.onChange(heard)
    setProxy(undefined)
    expect(heard.mock.calls).toContainEqual([PROXY_PROFILE_ORIGIN, true, 'proxy'])
    expect(heard.mock.calls).toContainEqual([SITE, true, 'proxy'])
    expect(heard.mock.calls.map(([origin]) => origin), 'the shared identity is not told while the browser-wide setting is off').not.toContain(SHARED_ORIGIN)
  })
})

describe('the browser-wide default', () => {
  const SITE = 'https://news.example'
  let everywhere = false

  function browser (installed: string[] = [APP, OTHER]) {
    everywhere = false
    const store = new RouteStore(null)
    const built: string[] = []
    const hub = createRouteHub({
      store,
      targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5',
      everywhere: () => everywhere,
      isApp: (origin) => installed.includes(origin),
      installed: () => installed,
      providerFor: (key) => { built.push(key); return { connect: async () => { throw new Error(`fake provider for ${key}`) } } }
    })
    hubs.push(hub)
    const flip = (next: boolean): void => { const previous = everywhere; everywhere = next; hub.everywhereChanged(previous) }
    return { store, hub, built, flip }
  }

  it('routes the shared identity, every website with no entry and every app with no entry while on, and an origin set to off is not', () => {
    const { hub, store, flip } = browser()
    expect(hub.isRouted(SHARED_ORIGIN)).toBe(false)
    expect(hub.isRouted(SITE)).toBe(false)
    flip(true)
    expect(hub.isEverywhere()).toBe(true)
    expect(hub.isRouted(SHARED_ORIGIN)).toBe(true)
    expect(hub.isRouted(SITE)).toBe(true)
    expect(hub.isRouted(APP)).toBe(true)
    expect(hub.routeFor(SITE)).toBeDefined()
    store.setEntry(SITE, 'off')
    store.setEntry(APP, 'off')
    expect(hub.isRouted(SITE)).toBe(false)
    expect(hub.routeFor(APP)).toBeUndefined()
  })

  it('gives every app its own credentials and every website with no entry the shared identity\'s', () => {
    const { hub, built, flip } = browser()
    flip(true)
    hub.routeFor(APP)
    hub.routeFor(OTHER)
    hub.routeFor(SITE)
    hub.routeFor('https://third.example')
    expect(built.sort()).toEqual([APP, OTHER, SHARED_ORIGIN].sort())
  })

  it('tells listeners about the shared identity and every app that follows the default when it flips, and about nothing that has an entry of its own', () => {
    const { hub, store, flip } = browser()
    store.setEntry(OTHER, 'off')
    store.setEntry(SITE, 'socks5')
    const heard = vi.fn()
    hub.onChange(heard)

    flip(true)

    expect(heard.mock.calls).toEqual([[SHARED_ORIGIN, true, 'switch'], [APP, true, 'switch']])
    heard.mockClear()
    flip(false)
    expect(heard.mock.calls).toEqual([[SHARED_ORIGIN, false, 'switch'], [APP, false, 'switch']])
  })

  it('moves no website between sessions: a website\'s profile follows its own entry alone', () => {
    const { hub, store, flip } = browser()
    store.setEntry(SITE, 'socks5')
    store.setEntry('https://off.example', 'off')
    flip(true)
    expect(hub.profileFor(SITE)).toBe('socks5')
    expect(hub.profileFor('https://off.example')).toBe('direct')
    expect(hub.profileFor('https://none.example')).toBeUndefined()
    flip(false)
    expect(hub.profileFor(SITE)).toBe('socks5')
    expect(hub.profileFor('https://off.example')).toBe('direct')
  })

  it('stops the shared front when it is turned off', async () => {
    const { hub, flip } = browser()
    flip(true)
    await hub.front(SHARED_ORIGIN)
    flip(false)
    await hub.settled()
    await expect(hub.front(SHARED_ORIGIN)).rejects.toThrow(/not routed/)
  })
})

describe('websites that go through different tunnels', () => {
  const SITE = 'https://news.example'
  const SITE_TWO = 'https://other.example'

  function kinds (options: { everywhere?: boolean, defaultKind?: TunnelKind, unreadable?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-hub-kinds-'))
    cleanup.push(dir)
    const path = join(dir, 'routes.json')
    if (options.unreadable === true) writeFileSync(path, '{ not json')
    const store = new RouteStore(options.unreadable === true ? path : null)
    let kind: TunnelKind = options.defaultKind ?? 'nym'
    const built: string[] = []
    const hub = createRouteHub({
      store,
      targetOf: () => ({ host: '127.0.0.1', port: 9050 }),
      defaultKind: () => kind,
      everywhere: () => options.everywhere === true,
      isApp: (origin) => origin === APP,
      providerFor: (key) => { built.push(key); return { connect: async () => { throw new Error(`fake provider for ${key}`) } } }
    })
    hubs.push(hub)
    return { store, hub, built, setKind: (next: TunnelKind) => { const previous = kind; kind = next; hub.defaultKindChanged(previous) } }
  }
  const cleanup: string[] = []
  afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('puts a website whose entry is the proxy in the proxy profile and one whose entry is Nym in Nym\'s, each with its own front', async () => {
    const { hub, store, built } = kinds()
    store.setEntry(SITE, 'nym')
    store.setEntry(SITE_TWO, 'socks5')
    expect([hub.profileFor(SITE), hub.profileFor(SITE_TWO)]).toEqual(['nym', 'socks5'])
    expect([hub.isRouted(SITE), hub.isRouted(SITE_TWO)]).toEqual([true, true])
    hub.routeFor(SITE)
    hub.routeFor(SITE_TWO)
    expect(built.sort()).toEqual([NYM_PROFILE_ORIGIN, PROXY_PROFILE_ORIGIN].sort())
    expect((await hub.front(SITE)).port).not.toBe((await hub.front(SITE_TWO)).port)
  })

  it('shares the proxy profile\'s front among the websites whose entry is the proxy', async () => {
    const { hub, store } = kinds()
    store.setEntry(SITE, 'socks5')
    store.setEntry(SITE_TWO, 'socks5')
    expect((await hub.front(SITE)).port).toBe((await hub.front(SITE_TWO)).port)
    expect((await hub.front(PROXY_PROFILE_ORIGIN)).port).toBe((await hub.front(SITE)).port)
  })

  it('answers for each tunnel profile as a route that is always on, and gives each profile its identity', () => {
    const { hub } = kinds()
    expect(hub.isRouted(PROXY_PROFILE_ORIGIN)).toBe(true)
    expect(hub.isRouted(NYM_PROFILE_ORIGIN)).toBe(true)
    expect([profileOrigin('nym'), profileOrigin('socks5'), profileOrigin('direct')]).toEqual([NYM_PROFILE_ORIGIN, PROXY_PROFILE_ORIGIN, DIRECT_PROFILE_ORIGIN])
  })

  it('tells listeners when a website moves from one tunnel to the other, and stops nothing it is still routed by', async () => {
    const { hub, store } = kinds()
    store.setEntry(SITE, 'nym')
    const heard = vi.fn()
    hub.onChange(heard)
    store.setEntry(SITE, 'socks5')
    expect(heard.mock.calls).toEqual([[SITE, true, 'switch']])
    expect(hub.profileFor(SITE)).toBe('socks5')
    store.setEntry(SITE, undefined)
    expect(heard.mock.calls.at(-1)).toEqual([SITE, false, 'switch'])
  })

  it('keeps a website where its entry puts it when the default tunnel is changed, and puts one with no entry in no profile', () => {
    const { hub, store, setKind } = kinds({ defaultKind: 'socks5' })
    store.setEntry(SITE, 'socks5')
    store.setEntry(SITE_TWO, 'nym')
    setKind('nym')
    expect([hub.profileFor(SITE), hub.profileFor(SITE_TWO), hub.profileFor('https://none.example')]).toEqual(['socks5', 'nym', undefined])
  })

  it('follows the default tunnel for the shared identity and for the profile of an unreadable list', () => {
    const { hub, setKind } = kinds({ everywhere: true, defaultKind: 'socks5', unreadable: true })
    expect(hub.unreadable()).toBe(true)
    expect(hub.profileFor(SITE)).toBe('socks5')
    setKind('nym')
    expect(hub.profileFor(SITE)).toBe('nym')
    expect(hub.isRouted(SHARED_ORIGIN)).toBe(true)
  })

  it('treats an entry equal to the default tunnel while everything goes through it as the default, and a different tunnel as a choice of its own', () => {
    const { hub, store } = kinds({ everywhere: true, defaultKind: 'nym' })
    expect(hub.isRouted(SITE)).toBe(true)
    expect(hub.profileFor(SITE)).toBeUndefined()
    store.setEntry(SITE, 'socks5')
    expect(hub.profileFor(SITE)).toBe('socks5')
    store.setEntry(SITE_TWO, 'off')
    expect(hub.isRouted(SITE_TWO)).toBe(false)
  })
})

describe('each tunnel has its own target', () => {
  const SITE = 'https://news.example'
  const PROXY_TARGET = { host: '127.0.0.1', port: 9050 }
  const NYM = { host: 'nym.invalid', port: 0 }

  function targets (options: { address?: boolean, defaultKind?: TunnelKind, everywhere?: boolean, installed?: string[] } = {}) {
    const store = new RouteStore(null)
    let address = options.address !== false
    let kind: TunnelKind = options.defaultKind ?? 'nym'
    let everywhere = options.everywhere === true
    const built: Array<{ key: string, target: RouteTarget }> = []
    const hub = createRouteHub({
      store,
      targetOf: (which) => which === 'nym' ? NYM : address ? PROXY_TARGET : undefined,
      defaultKind: () => kind,
      everywhere: () => everywhere,
      isApp: (origin) => origin === APP || origin === OTHER,
      installed: () => options.installed ?? [APP, OTHER],
      providerFor: (key, target) => { built.push({ key, target }); return { connect: async () => { throw new Error(`fake provider for ${key}`) } } }
    })
    hubs.push(hub)
    return {
      store, hub, built,
      setAddress: (next: boolean) => { address = next; hub.addressChanged() },
      setKind: (next: TunnelKind) => { const previous = kind; kind = next; hub.defaultKindChanged(previous) },
      setEverywhere: (next: boolean) => { const previous = everywhere; everywhere = next; hub.everywhereChanged(previous) }
    }
  }

  it('builds the route of an origin against the target of the tunnel its entry names, whatever the default is', () => {
    const { hub, store, built } = targets({ defaultKind: 'nym' })
    store.setEntry(SITE, 'socks5')
    store.setEntry(APP, 'nym')
    store.setEntry(OTHER, 'socks5')
    hub.routeFor(SITE)
    hub.routeFor(APP)
    hub.routeFor(OTHER)
    expect(built.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: PROXY_PROFILE_ORIGIN, target: PROXY_TARGET },
      { key: APP, target: NYM },
      { key: OTHER, target: PROXY_TARGET }
    ].sort((a, b) => a.key.localeCompare(b.key)))
  })

  it('says which tunnel an origin goes through, and none for an origin that is not routed', () => {
    const { hub, store } = targets({ defaultKind: 'socks5', everywhere: true })
    store.setEntry(APP, 'nym')
    store.setEntry(OTHER, 'off')
    expect([hub.kindOf(APP), hub.kindOf(OTHER), hub.kindOf(SITE), hub.kindOf(SHARED_ORIGIN)]).toEqual(['nym', undefined, 'socks5', 'socks5'])
    expect([hub.kindOf(NYM_PROFILE_ORIGIN), hub.kindOf(PROXY_PROFILE_ORIGIN), hub.kindOf(DIRECT_PROFILE_ORIGIN)]).toEqual(['nym', 'socks5', undefined])
  })

  it('says no address is set only for an origin on the proxy: an origin on Nym is not held up by it', () => {
    const { hub, store } = targets({ address: false })
    store.setEntry(APP, 'socks5')
    store.setEntry(OTHER, 'nym')
    expect([hub.state(APP), hub.state(OTHER)]).toEqual(['no-proxy', 'idle'])
    expect(hub.routeFor(APP)?.provider).toBeDefined()
  })

  it('tells only the origins on the proxy when its address changes, and the one that lost its address stays routed', () => {
    const { hub, store, setAddress } = targets()
    store.setEntry(APP, 'socks5')
    store.setEntry(OTHER, 'nym')
    store.setEntry(SITE, 'socks5')
    const heard = vi.fn()
    hub.onChange(heard)
    setAddress(false)
    expect(heard.mock.calls, 'OTHER is on Nym and hears nothing').toEqual([[APP, true, 'proxy'], [SITE, true, 'proxy']])
  })

  it('moves the shared identity and the apps that follow the default to the new tunnel, and leaves an origin with its own tunnel alone', () => {
    const { hub, store, setKind, setEverywhere } = targets({ defaultKind: 'nym', everywhere: true })
    store.setEntry(OTHER, 'nym')
    const heard = vi.fn()
    hub.onChange(heard)
    setKind('socks5')
    expect(heard.mock.calls).toEqual([[SHARED_ORIGIN, true, 'proxy'], [APP, true, 'proxy']])
    expect([hub.kindOf(SHARED_ORIGIN), hub.kindOf(APP), hub.kindOf(OTHER)]).toEqual(['socks5', 'socks5', 'nym'])
    heard.mockClear()
    setEverywhere(false)
    expect(hub.kindOf(SHARED_ORIGIN)).toBeUndefined()
  })

  it('tells nothing when the default moves while the whole browser is off the tunnel', () => {
    const { hub, setKind } = targets({ defaultKind: 'nym', everywhere: false })
    const heard = vi.fn()
    hub.onChange(heard)
    setKind('socks5')
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells listeners when an origin moves from one tunnel to the other, and gives its front up so the next signs in afresh', async () => {
    const { hub, store } = targets()
    store.setEntry(APP, 'nym')
    const first = await hub.front(APP)
    const heard = vi.fn()
    hub.onChange(heard)
    store.setEntry(APP, 'socks5')
    await hub.settled()
    expect(heard.mock.calls).toEqual([[APP, true, 'switch']])
    const second = await hub.front(APP)
    expect(second.port).not.toBe(first.port)
  })

  it('lists the tunnels something goes through: the default while the whole browser is on one, and each entry\'s', () => {
    const { hub, store, setEverywhere } = targets({ defaultKind: 'socks5' })
    expect(hub.kindsInUse()).toEqual([])
    store.setEntry(SITE, 'nym')
    expect(hub.kindsInUse()).toEqual(['nym'])
    setEverywhere(true)
    expect(hub.kindsInUse().sort()).toEqual(['nym', 'socks5'])
    store.setEntry(SITE, 'off')
    expect(hub.kindsInUse()).toEqual(['socks5'])
  })

  it('says whether an origin is an installed app', () => {
    const { hub } = targets()
    expect([hub.isApp(APP), hub.isApp(SITE)]).toEqual([true, false])
  })
})
