// The hub: which apps are routed, through which proxy, with one provider per app and one front per routed app. A
// routed app never falls back to a direct route: with no proxy set its route refuses.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouteProvider } from '../../../broker/route/provider.js'
import type { RouteTarget } from '../../../broker/route/table.js'
import { createRouteHub } from '../route-hub.js'
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
    proxy: () => proxy,
    providerFor: (key, target) => {
      const provider: RouteProvider = { connect: async () => { throw new Error(`fake provider for ${key}`) } }
      built.push({ key, target, provider })
      return provider
    }
  })
  hubs.push(hub)
  return { store, hub, built, setProxy: (next: RouteTarget | undefined) => { proxy = next; hub.proxyChanged() } }
}

describe('routeFor', () => {
  it('has no route for an app that is not routed', () => {
    const { hub } = setup()
    expect(hub.routeFor(APP)).toBeUndefined()
  })

  it('has a route through the proxy for a routed app, one provider per app', () => {
    const { hub, store, built } = setup()
    store.set(APP, true)
    store.set(OTHER, true)

    const route = hub.routeFor(APP)

    expect(route).toBeDefined()
    expect(hub.routeFor(APP)).toBe(route)
    expect(hub.routeFor(OTHER)).not.toBe(route)
    expect(built.map((one) => one.key).sort()).toEqual([APP, OTHER])
    expect(built[0]?.target).toEqual({ host: '127.0.0.1', port: 9050 })
  })

  it('refuses, never goes direct, for a routed app when no proxy is set', async () => {
    const { hub, store } = setup(undefined)
    store.set(APP, true)

    const route = hub.routeFor(APP)

    expect(route).toBeDefined()
    await expect(route?.provider.connect('x.test', 443, new AbortController().signal)).rejects.toThrow()
    expect(route?.provider.udp).toBeUndefined()
    expect(route?.provider.resolve).toBeUndefined()
  })

  it('follows the proxy as it changes, and the switch as it flips', () => {
    const { hub, store, built, setProxy } = setup()
    store.set(APP, true)
    const first = hub.routeFor(APP)

    setProxy({ host: '127.0.0.1', port: 9150 })
    const second = hub.routeFor(APP)
    expect(second).not.toBe(first)
    expect(built.at(-1)?.target).toEqual({ host: '127.0.0.1', port: 9150 })

    store.set(APP, false)
    expect(hub.routeFor(APP)).toBeUndefined()
  })
})

describe('state', () => {
  it('says off, no proxy, or idle before the route has carried anything', () => {
    const { hub, store, setProxy } = setup()
    expect(hub.state(APP)).toBe('off')
    store.set(APP, true)
    expect(hub.state(APP)).toBe('idle')
    setProxy(undefined)
    expect(hub.state(APP)).toBe('no-proxy')
  })

  it('says down once the route failed to carry something', async () => {
    const { hub, store } = setup()
    store.set(APP, true)
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
    const hub = createRouteHub({ store, proxy: () => ({ host: '127.0.0.1', port: 9050 }), providerFor: () => ({ connect: async () => { throw failure } }) })
    hubs.push(hub)
    store.set(APP, true)
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

    store.set(APP, true)
    expect(heard.mock.calls).toEqual([[APP, true, 'switch']])

    setProxy({ host: '127.0.0.1', port: 9150 })
    expect(heard.mock.calls).toEqual([[APP, true, 'switch'], [APP, true, 'proxy']])

    store.set(APP, false)
    expect(heard.mock.calls.at(-1)).toEqual([APP, false, 'switch'])
    heard.mockClear()
    setProxy({ host: '127.0.0.1', port: 9250 })
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('front', () => {
  it('starts one front per routed app and reuses it', async () => {
    const { hub, store } = setup()
    store.set(APP, true)
    store.set(OTHER, true)

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
    store.set(APP, true)
    const first = await hub.front(APP)

    store.set(APP, false)
    await hub.settled()
    store.set(APP, true)
    const second = await hub.front(APP)

    expect(second).not.toBe(first)
    expect(second.secret).not.toBe(first.secret)
  })

  it('knows which front an authentication challenge came from, by its port', async () => {
    const { hub, store } = setup()
    store.set(APP, true)
    const front = await hub.front(APP)

    expect(hub.credentialsForPort(front.port)).toEqual({ username: front.username, password: front.secret })
    expect(hub.credentialsForPort(front.port + 1)).toBeUndefined()
  })

  it('hands the secret of a port to nobody once its front is closing, so a later program on that port is not answered', async () => {
    const { hub, store } = setup()
    store.set(APP, true)
    const front = await hub.front(APP)

    store.set(APP, false)

    expect(hub.credentialsForPort(front.port)).toBeUndefined()
    await hub.settled()
    expect(hub.credentialsForPort(front.port)).toBeUndefined()
  })

  it('hands the secret of a port to nobody once the app\'s front was closed by anything else', async () => {
    const { hub, store } = setup()
    store.set(APP, true)
    const front = await hub.front(APP)

    await front.close()

    expect(hub.credentialsForPort(front.port)).toBeUndefined()
    const next = await hub.front(APP)
    expect(next).not.toBe(front)
    expect(hub.credentialsForPort(next.port)).toEqual({ username: next.username, password: next.secret })
  })

  it('hands no secret out after the hub is disposed', async () => {
    const { hub, store } = setup()
    store.set(APP, true)
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
    const hub = createRouteHub({ store, proxy: () => proxy, installed: () => installed, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
    hubs.push(hub)
    return { store, hub, setProxy: (next: RouteTarget | undefined) => { proxy = next; hub.proxyChanged() } }
  }

  it('routes every installed app while a tunnel is set, through it, and no website', () => {
    const { hub } = unreadable()

    expect(hub.isRouted(APP)).toBe(true)
    expect(hub.isRouted('https://a-website.example')).toBe(false)
    expect(hub.routeFor('https://a-website.example')).toBeUndefined()
    expect(hub.routeFor(OTHER)).toBeDefined()
    expect(hub.unreadable()).toBe(true)
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

  it('is not unreadable when the list is fine', () => {
    expect(setup().hub.unreadable()).toBe(false)
  })
})
