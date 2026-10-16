import { describe, expect, it, vi } from 'vitest'
import { createRouteSwitch } from '../route-switch.js'
import type { RouteSwitchWorld } from '../route-switch.js'
import { RouteStore } from '../route-store.js'
import { createRouteHub } from '../route-hub.js'
import { profilePartitionFor } from '../site-partition.js'

const APP = 'https://app.example'
const SITE = 'https://news.example'

function setup (options: { proxy?: boolean, everywhere?: boolean, kind?: 'nym' | 'socks5', world?: Partial<RouteSwitchWorld> } = {}) {
  const store = new RouteStore(null)
  const hub = createRouteHub({ store, defaultKind: () => options.kind ?? 'nym', everywhere: () => options.everywhere === true, isApp: (origin) => origin === APP, proxy: () => options.proxy === false ? undefined : { host: '127.0.0.1', port: 9050 }, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  const settled = vi.fn(async () => {})
  const routes = { proxy: () => options.proxy === false ? undefined : { host: '127.0.0.1', port: 9050 }, defaultKind: () => options.kind ?? 'nym', store, hub, controller: { settled } as never }
  const world: RouteSwitchWorld = { isPinned: (origin) => origin === APP, isPersistable: () => true, ...options.world }
  return { store, hub, settled, routeSwitch: createRouteSwitch(routes, world) }
}

describe('turning a website\'s tunnel on', () => {
  it('writes an on entry and records that the website has storage in the tunnel profile, once the sessions follow', async () => {
    const { routeSwitch, store, settled } = setup()
    await routeSwitch.setSite(SITE, true)
    expect(store.stateOf(SITE)).toBe('nym')
    expect(store.isApart(SITE, 'nym')).toBe(true)
    expect(store.isApart(SITE, 'direct')).toBe(false)
    expect(settled).toHaveBeenCalled()
  })

  it('tells the person first, naming the profile, only until the website has storage in it', async () => {
    const { routeSwitch } = setup()
    expect(routeSwitch.siteNotice(SITE, true)).toBe('nym')
    expect(routeSwitch.siteNotice(SITE, false)).toBeUndefined()
    await routeSwitch.setSite(SITE, true)
    expect(routeSwitch.siteNotice(SITE, true)).toBeUndefined()
    await routeSwitch.setSite(SITE, false)
    expect(routeSwitch.siteNotice(SITE, true)).toBeUndefined()
  })

  it('sends the website back to following the default when turned off, and keeps its storage', async () => {
    const { routeSwitch, store } = setup()
    await routeSwitch.setSite(SITE, true)
    await routeSwitch.setSite(SITE, false)
    expect(store.stateOf(SITE)).toBeUndefined()
    expect(store.isApart(SITE, 'nym')).toBe(true)
  })

  it('with the whole browser on the tunnel, turning a website off writes an off entry and moves it to the direct profile, and turning it on again follows the default', async () => {
    const { routeSwitch, store } = setup({ everywhere: true })
    expect(routeSwitch.siteNotice(SITE, false)).toBe('direct')
    expect(routeSwitch.siteNotice(SITE, true)).toBeUndefined()
    await routeSwitch.setSite(SITE, false)
    expect(store.stateOf(SITE)).toBe('off')
    expect(store.isApart(SITE, 'direct')).toBe(true)
    await routeSwitch.setSite(SITE, true)
    expect(store.stateOf(SITE)).toBeUndefined()
    expect(store.isApart(SITE, 'direct')).toBe(true)
  })

  it('with the whole browser on the tunnel, a website that was on keeps its entry, and turning it off makes it off', async () => {
    const off = setup({ everywhere: false })
    await off.routeSwitch.setSite(SITE, true)
    const { routeSwitch, store } = setup({ everywhere: true })
    store.setEntry(SITE, 'nym')
    await routeSwitch.setSite(SITE, false)
    expect(store.stateOf(SITE)).toBe('off')
    expect(off.store.stateOf(SITE)).toBe('nym')
  })

  it('is blocked with no tunnel set, and for this computer, but can always be turned off', async () => {
    expect(setup({ proxy: false }).routeSwitch.siteBlockedFor(SITE)).toBe('no-proxy')
    const { routeSwitch, store } = setup()
    expect(routeSwitch.siteBlockedFor(SITE)).toBeUndefined()
    expect(routeSwitch.siteBlockedFor('http://localhost:3000')).toBe('local')
    await routeSwitch.setSite('http://localhost:3000', true)
    expect(store.stateOf('http://localhost:3000')).toBeUndefined()
  })
})

describe('the app card\'s switch', () => {
  it('stays as it was: pinned and persistable apps only, an on entry or none', async () => {
    const { routeSwitch, store } = setup()
    expect(routeSwitch.blockedFor(APP)).toBeUndefined()
    expect(routeSwitch.blockedFor(SITE)).toBe('not-cached')
    await routeSwitch.set(APP, true)
    expect(store.stateOf(APP)).toBe('nym')
    expect(store.isApartAnywhere(APP)).toBe(false)
    await routeSwitch.set(APP, false)
    expect(store.stateOf(APP)).toBeUndefined()
    expect(setup({ proxy: false }).routeSwitch.blockedFor(APP)).toBe('no-proxy')
  })
})

describe('the app card\'s switch, with the whole browser on the tunnel', () => {
  it('writes an off entry when the app is switched off, and takes it away when it is switched on again', async () => {
    const { routeSwitch, store } = setup({ everywhere: true })
    await routeSwitch.set(APP, false)
    expect(store.stateOf(APP)).toBe('off')
    await routeSwitch.set(APP, true)
    expect(store.stateOf(APP)).toBeUndefined()
  })
})

describe('the tunnel a switch uses', () => {
  it('is the tunnel chosen for the browser, for a website: its entry, its storage notice and its profile', async () => {
    const { routeSwitch, store, hub } = setup({ kind: 'socks5' })
    expect(routeSwitch.siteNotice(SITE, true)).toBe('socks5')
    await routeSwitch.setSite(SITE, true)
    expect(store.stateOf(SITE)).toBe('socks5')
    expect(store.isApart(SITE, 'socks5')).toBe(true)
    expect(store.isApart(SITE, 'nym')).toBe(false)
    expect(hub.profileFor(SITE)).toBe('socks5')
  })

  it('is the same for an app, which has no storage notice and no record of storage', async () => {
    const { routeSwitch, store } = setup({ kind: 'socks5' })
    await routeSwitch.set(APP, true)
    expect(store.stateOf(APP)).toBe('socks5')
    expect(store.isApartAnywhere(APP)).toBe(false)
  })

  it('writes no entry for a website while everything goes through the chosen tunnel, and an entry for the tunnel that is not', async () => {
    const { routeSwitch, store } = setup({ kind: 'socks5', everywhere: true })
    await routeSwitch.setSite(SITE, true)
    expect(store.stateOf(SITE)).toBeUndefined()
  })

  it('lists a website in the proxy profile as in the tunnel profile, as the list groups both', async () => {
    const { routeSwitch } = setup({ kind: 'socks5' })
    await routeSwitch.setSite(SITE, true)
    expect(routeSwitch.rows()).toEqual([{ origin: SITE, kind: 'site', entry: 'on', state: 'idle', profile: 'tunnel', apart: true, apartIn: ['tunnel'] }])
  })

  it('clears the storage of a website from the profile it is kept in', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch, store } = setup({ kind: 'socks5', world: { removeSiteStorage } })
    await routeSwitch.setSite(SITE, true)
    await expect(routeSwitch.removeSiteStorage(SITE)).resolves.toBe(true)
    expect(removeSiteStorage).toHaveBeenCalledWith('persist:proxy-profile', SITE)
    expect(store.isApart(SITE, 'socks5')).toBe(true)
  })
})

describe('the list of origins with a setting or storage of their own', () => {
  it('has apps and websites, each with its entry and state, and a website whose entry is gone but whose storage is kept', async () => {
    const { routeSwitch } = setup()
    await routeSwitch.set(APP, true)
    await routeSwitch.setSite(SITE, true)
    await routeSwitch.setSite('https://old.example', true)
    await routeSwitch.setSite('https://old.example', false)

    const rows = routeSwitch.rows().sort((a, b) => a.origin.localeCompare(b.origin))

    expect(rows).toEqual([
      { origin: APP, kind: 'app', entry: 'on', state: 'idle', profile: 'tunnel', apart: false, apartIn: [] },
      { origin: SITE, kind: 'site', entry: 'on', state: 'idle', profile: 'tunnel', apart: true, apartIn: ['tunnel'] },
      { origin: 'https://old.example', kind: 'site', entry: undefined, state: 'off', profile: undefined, apart: true, apartIn: ['tunnel'] }
    ])
  })
})

describe('removing a website\'s separate storage', () => {
  it('clears that website\'s data from the profile, forgets the storage when no entry is left, and keeps the entry when there is one', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch, store } = setup({ world: { removeSiteStorage } })
    await routeSwitch.setSite(SITE, true)

    expect(await routeSwitch.removeSiteStorage(SITE)).toBe(true)
    expect(removeSiteStorage).toHaveBeenCalledWith(profilePartitionFor('nym', SITE), SITE)
    expect(store.stateOf(SITE)).toBe('nym')
    expect(store.isApart(SITE, 'nym')).toBe(true)

    await routeSwitch.setSite(SITE, false)
    expect(await routeSwitch.removeSiteStorage(SITE)).toBe(true)
    expect(store.isApart(SITE, 'nym')).toBe(false)
    expect(routeSwitch.siteNotice(SITE, true)).toBe('nym')
  })

  it('refuses an origin that has no storage of its own, an installed app among them', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch } = setup({ world: { removeSiteStorage } })
    await routeSwitch.set(APP, true)
    expect(await routeSwitch.removeSiteStorage(APP)).toBe(false)
    expect(await routeSwitch.removeSiteStorage('https://never.example')).toBe(false)
    expect(removeSiteStorage).not.toHaveBeenCalled()
  })
})

describe('a website that moves into a profile', () => {
  it('has its service workers unregistered in the shared session it left', async () => {
    const dropServiceWorkers = vi.fn(async () => {})
    const { routeSwitch } = setup({ world: { dropServiceWorkers } })
    await routeSwitch.setSite(SITE, true)
    expect(dropServiceWorkers).toHaveBeenCalledWith(undefined, SITE)
  })

  it('has them unregistered in the shared session it left for the direct profile, and in the profile it leaves when it goes back to the default', async () => {
    const dropServiceWorkers = vi.fn(async () => {})
    const { routeSwitch } = setup({ everywhere: true, world: { dropServiceWorkers } })
    await routeSwitch.setSite(SITE, false)
    expect(dropServiceWorkers).toHaveBeenLastCalledWith(undefined, SITE)
    await routeSwitch.setSite(SITE, true)
    expect(dropServiceWorkers).toHaveBeenLastCalledWith(profilePartitionFor('direct', SITE), SITE)
  })

  it('is not undone by workers that cannot be unregistered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { routeSwitch, store } = setup({ world: { dropServiceWorkers: async () => { throw new Error('busy') } } })
    await routeSwitch.setSite(SITE, true)
    expect(store.stateOf(SITE)).toBe('nym')
  })
})
