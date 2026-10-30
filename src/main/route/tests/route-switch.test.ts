import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  // Nym always has a target; the proxy has one only while an address is saved.
  const targetOf = (kind: 'nym' | 'socks5'): { host: string, port: number } | undefined => kind === 'socks5' && options.proxy === false ? undefined : { host: '127.0.0.1', port: 9050 }
  const hub = createRouteHub({ store, defaultKind: () => options.kind ?? 'nym', everywhere: () => options.everywhere === true, isApp: (origin) => origin === APP, targetOf, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  const settled = vi.fn(async () => {})
  const routes = { targetOf, defaultKind: () => options.kind ?? 'nym', store, hub, controller: { settled } as never }
  const world: RouteSwitchWorld = { isPinned: (origin) => origin === APP, isPersistable: () => true, ...options.world }
  return { store, hub, settled, routeSwitch: createRouteSwitch(routes, world) }
}

describe('turning a website\'s tunnel on', () => {
  it('writes an on entry and records that the website has storage in the tunnel profile, once the sessions follow', async () => {
    const { routeSwitch, store, settled } = setup()
    await routeSwitch.choose(SITE, 'nym')
    expect(store.stateOf(SITE)).toBe('nym')
    expect(store.isApart(SITE, 'nym')).toBe(true)
    expect(store.isApart(SITE, 'direct')).toBe(false)
    expect(settled).toHaveBeenCalled()
  })

  it('tells the person first, naming the profile, only until the website has storage in it', async () => {
    const { routeSwitch } = setup()
    expect(routeSwitch.noticeFor(SITE, 'nym')).toBe('nym')
    expect(routeSwitch.noticeFor(SITE, null)).toBeUndefined()
    await routeSwitch.choose(SITE, 'nym')
    expect(routeSwitch.noticeFor(SITE, 'nym')).toBeUndefined()
    await routeSwitch.choose(SITE, null)
    expect(routeSwitch.noticeFor(SITE, 'nym')).toBeUndefined()
  })

  it('sends the website back to following the default when turned off, and keeps its storage', async () => {
    const { routeSwitch, store } = setup()
    await routeSwitch.choose(SITE, 'nym')
    await routeSwitch.choose(SITE, null)
    expect(store.stateOf(SITE)).toBeUndefined()
    expect(store.isApart(SITE, 'nym')).toBe(true)
  })

  it('with the whole browser on the tunnel, turning a website off writes an off entry and moves it to the direct profile, and turning it on again is a pick of its own that lives in its tunnel\'s profile', async () => {
    const { routeSwitch, store } = setup({ everywhere: true })
    expect(routeSwitch.noticeFor(SITE, null)).toBe('direct')
    expect(routeSwitch.noticeFor(SITE, 'nym'), 'its pick moves it into Nym\'s profile, which asks once').toBe('nym')
    await routeSwitch.choose(SITE, null)
    expect(store.stateOf(SITE)).toBe('off')
    expect(store.isApart(SITE, 'direct')).toBe(true)
    await routeSwitch.choose(SITE, 'nym')
    expect(store.stateOf(SITE)).toBe('nym')
    expect(store.isApart(SITE, 'direct')).toBe(true)
    expect(store.isApart(SITE, 'nym')).toBe(true)
  })

  it('with the whole browser on the tunnel, a website that was on keeps its entry, and turning it off makes it off', async () => {
    const off = setup({ everywhere: false })
    await off.routeSwitch.choose(SITE, 'nym')
    const { routeSwitch, store } = setup({ everywhere: true })
    store.setEntry(SITE, 'nym')
    await routeSwitch.choose(SITE, null)
    expect(store.stateOf(SITE)).toBe('off')
    expect(off.store.stateOf(SITE)).toBe('nym')
  })

  it('is blocked with no tunnel set, and for this computer, but can always be turned off', async () => {
    expect(setup({ proxy: false }).routeSwitch.blockedFor(SITE, 'socks5')).toBe('no-proxy')
    const { routeSwitch, store } = setup()
    expect(routeSwitch.blockedFor(SITE, 'nym')).toBeUndefined()
    expect(routeSwitch.blockedFor(SITE, 'socks5')).toBeUndefined()
    expect(setup({ proxy: false }).routeSwitch.blockedFor(SITE, 'nym'), 'Nym needs no address').toBeUndefined()
    expect(routeSwitch.blockedFor('http://localhost:3000', 'nym')).toBe('local')
    await routeSwitch.choose('http://localhost:3000', 'nym')
    expect(store.stateOf('http://localhost:3000')).toBeUndefined()
  })
})

describe('the app card\'s switch', () => {
  it('stays as it was: pinned and persistable apps only, an on entry or none', async () => {
    const { routeSwitch, store } = setup()
    expect(routeSwitch.blockedFor(APP, 'nym')).toBeUndefined()
    const unpinned = setup({ world: { isPinned: () => false } }).routeSwitch
    expect(unpinned.blockedFor(APP, 'nym')).toBe('not-cached')
    await routeSwitch.choose(APP, 'nym')
    expect(store.stateOf(APP)).toBe('nym')
    expect(store.isApartAnywhere(APP)).toBe(false)
    await routeSwitch.choose(APP, null)
    expect(store.stateOf(APP)).toBeUndefined()
    expect(setup({ proxy: false }).routeSwitch.blockedFor(APP, 'socks5')).toBe('no-proxy')
  })
})

describe('the app card\'s switch, with the whole browser on the tunnel', () => {
  it('writes an off entry when the app is switched off, and a tunnel entry of its own when it is switched on again, so a later change of the default never moves it', async () => {
    const { routeSwitch, store } = setup({ everywhere: true })
    await routeSwitch.choose(APP, null)
    expect(store.stateOf(APP)).toBe('off')
    await routeSwitch.choose(APP, 'nym')
    expect(store.stateOf(APP)).toBe('nym')
  })
})

describe('the tunnel a switch uses', () => {
  it('is the tunnel chosen for the browser, for a website: its entry, its storage notice and its profile', async () => {
    const { routeSwitch, store, hub } = setup({ kind: 'socks5' })
    expect(routeSwitch.noticeFor(SITE, 'socks5')).toBe('socks5')
    await routeSwitch.choose(SITE, 'socks5')
    expect(store.stateOf(SITE)).toBe('socks5')
    expect(store.isApart(SITE, 'socks5')).toBe(true)
    expect(store.isApart(SITE, 'nym')).toBe(false)
    expect(hub.profileFor(SITE)).toBe('socks5')
  })

  it('is the same for an app, which has no storage notice and no record of storage', async () => {
    const { routeSwitch, store } = setup({ kind: 'socks5' })
    await routeSwitch.choose(APP, 'socks5')
    expect(store.stateOf(APP)).toBe('socks5')
    expect(store.isApartAnywhere(APP)).toBe(false)
  })

  it('writes an entry for a website that picks the tunnel everything already goes through, and it lives in that tunnel\'s profile', async () => {
    const { routeSwitch, store, hub } = setup({ kind: 'socks5', everywhere: true })
    expect(routeSwitch.noticeFor(SITE, 'socks5')).toBe('socks5')
    await routeSwitch.choose(SITE, 'socks5')
    expect(store.stateOf(SITE)).toBe('socks5')
    expect(hub.profileFor(SITE)).toBe('socks5')
    expect(store.isApart(SITE, 'socks5')).toBe(true)
  })

  it('keeps a website that picked the default tunnel where it is when the default changes or the browser-wide setting goes off', async () => {
    const { routeSwitch, store, hub } = setup({ kind: 'nym', everywhere: true })
    await routeSwitch.choose(SITE, 'nym')
    expect(hub.profileFor(SITE)).toBe('nym')
    expect(hub.kindOf(SITE)).toBe('nym')
    const off = setup({ kind: 'nym', everywhere: false })
    off.store.setEntry(SITE, 'nym')
    expect(off.hub.kindOf(SITE)).toBe('nym')
    expect(store.stateOf(SITE)).toBe('nym')
  })

  it('lists a website in the proxy profile by the tunnel and the profile it uses', async () => {
    const { routeSwitch } = setup({ kind: 'socks5' })
    await routeSwitch.choose(SITE, 'socks5')
    expect(routeSwitch.rows()).toEqual([{ origin: SITE, kind: 'site', entry: 'socks5', state: 'idle', profile: 'socks5', apart: true, apartIn: ['socks5'] }])
  })

  it('clears the storage of a website from the profile it is kept in', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch, store } = setup({ kind: 'socks5', world: { removeSiteStorage } })
    await routeSwitch.choose(SITE, 'socks5')
    await expect(routeSwitch.removeSiteStorage(SITE)).resolves.toBe(true)
    expect(removeSiteStorage).toHaveBeenCalledWith('persist:proxy-profile', SITE)
    expect(store.isApart(SITE, 'socks5')).toBe(true)
  })
})

describe('the list of origins with a setting or storage of their own', () => {
  it('has apps and websites, each with its entry and state, and a website whose entry is gone but whose storage is kept', async () => {
    const { routeSwitch } = setup()
    await routeSwitch.choose(APP, 'nym')
    await routeSwitch.choose(SITE, 'nym')
    await routeSwitch.choose('https://old.example', 'nym')
    await routeSwitch.choose('https://old.example', null)

    const rows = routeSwitch.rows().sort((a, b) => a.origin.localeCompare(b.origin))

    expect(rows).toEqual([
      { origin: APP, kind: 'app', entry: 'nym', state: 'idle', profile: 'nym', apart: false, apartIn: [] },
      { origin: SITE, kind: 'site', entry: 'nym', state: 'idle', profile: 'nym', apart: true, apartIn: ['nym'] },
      { origin: 'https://old.example', kind: 'site', entry: undefined, state: 'off', profile: undefined, apart: true, apartIn: ['nym'] }
    ])
  })
})

describe('removing a website\'s separate storage', () => {
  it('clears that website\'s data from the profile, forgets the storage when no entry is left, and keeps the entry when there is one', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch, store } = setup({ world: { removeSiteStorage } })
    await routeSwitch.choose(SITE, 'nym')

    expect(await routeSwitch.removeSiteStorage(SITE)).toBe(true)
    expect(removeSiteStorage).toHaveBeenCalledWith(profilePartitionFor('nym', SITE), SITE)
    expect(store.stateOf(SITE)).toBe('nym')
    expect(store.isApart(SITE, 'nym')).toBe(true)

    await routeSwitch.choose(SITE, null)
    expect(await routeSwitch.removeSiteStorage(SITE)).toBe(true)
    expect(store.isApart(SITE, 'nym')).toBe(false)
    expect(routeSwitch.noticeFor(SITE, 'nym')).toBe('nym')
  })

  it('refuses an origin that has no storage of its own, an installed app among them', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch } = setup({ world: { removeSiteStorage } })
    await routeSwitch.choose(APP, 'nym')
    expect(await routeSwitch.removeSiteStorage(APP)).toBe(false)
    expect(await routeSwitch.removeSiteStorage('https://never.example')).toBe(false)
    expect(removeSiteStorage).not.toHaveBeenCalled()
  })
})

describe('a website that moves into a profile', () => {
  it('has its service workers unregistered in the shared session it left', async () => {
    const dropServiceWorkers = vi.fn(async () => {})
    const { routeSwitch } = setup({ world: { dropServiceWorkers } })
    await routeSwitch.choose(SITE, 'nym')
    expect(dropServiceWorkers).toHaveBeenCalledWith(undefined, SITE)
  })

  it('has them unregistered in the shared session it left for the direct profile, and in the profile it leaves when it goes back to the default', async () => {
    const dropServiceWorkers = vi.fn(async () => {})
    const { routeSwitch } = setup({ everywhere: true, world: { dropServiceWorkers } })
    await routeSwitch.choose(SITE, null)
    expect(dropServiceWorkers).toHaveBeenLastCalledWith(undefined, SITE)
    await routeSwitch.choose(SITE, 'nym')
    expect(dropServiceWorkers).toHaveBeenLastCalledWith(profilePartitionFor('direct', SITE), SITE)
  })

  it('is not undone by workers that cannot be unregistered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { routeSwitch, store } = setup({ world: { dropServiceWorkers: async () => { throw new Error('busy') } } })
    await routeSwitch.choose(SITE, 'nym')
    expect(store.stateOf(SITE)).toBe('nym')
  })
})

describe('a website whose storage in Nym\'s profile is the proxy\'s', () => {
  it('is told first, and has that storage cleared before it moves to Nym', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-switch-'))
    try {
      const path = join(dir, 'routes.json')
      writeFileSync(path, JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [SITE], via: { [SITE]: 'socks5' }, apart: [SITE], apartForeign: [SITE] }))
      const store = new RouteStore(path)
      const removed: string[] = []
      const hub = createRouteHub({ store, defaultKind: () => 'nym', isApp: () => false, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
      const routeSwitch = createRouteSwitch({ targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'nym', store, hub, controller: { settled: async () => {} } as never }, {
        isPinned: () => false,
        isPersistable: () => true,
        removeSiteStorage: async (partition, origin) => { removed.push(`${partition} ${origin}`) }
      })
      expect(store.isApart(SITE, 'nym')).toBe(true)
      expect(routeSwitch.noticeFor(SITE, 'nym')).toBe('nym')
      await routeSwitch.choose(SITE, 'nym')
      expect(removed).toEqual([`${profilePartitionFor('nym', SITE)} ${SITE}`])
      expect(store.stateOf(SITE)).toBe('nym')
      expect(store.isForeignToNym(SITE)).toBe(false)
      expect(routeSwitch.noticeFor(SITE, 'nym')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('taking a website\'s entry away', () => {
  it('drops the entry even while the whole browser is on a tunnel, where choosing none would write an off entry, and keeps its storage', async () => {
    const { routeSwitch, store, settled } = setup({ everywhere: true })
    await routeSwitch.choose(SITE, 'nym')
    settled.mockClear()
    await routeSwitch.forget(SITE)
    expect(store.stateOf(SITE)).toBeUndefined()
    expect(store.isApart(SITE, 'nym')).toBe(true)
    expect(settled).toHaveBeenCalled()
    await routeSwitch.choose(SITE, null)
    expect(store.stateOf(SITE), 'choosing none is an entry there').toBe('off')
    await routeSwitch.forget(SITE)
    expect(store.stateOf(SITE)).toBeUndefined()
  })

  it('does nothing for an installed app, whose entry is set by its own switch, nor for this computer', async () => {
    const { routeSwitch, store } = setup()
    await routeSwitch.choose(APP, 'nym')
    await routeSwitch.forget(APP)
    expect(store.stateOf(APP)).toBe('nym')
    await routeSwitch.forget('http://localhost:3000')
    expect(store.stateOf('http://localhost:3000')).toBeUndefined()
  })
})
