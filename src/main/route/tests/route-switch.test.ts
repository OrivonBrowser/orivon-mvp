import { describe, expect, it, vi } from 'vitest'
import { createRouteSwitch } from '../route-switch.js'
import type { RouteSwitchWorld } from '../route-switch.js'
import { RouteStore } from '../route-store.js'
import { createRouteHub } from '../route-hub.js'
import { sitePartitionFor } from '../site-partition.js'

const APP = 'https://app.example'
const SITE = 'https://news.example'

function setup (options: { proxy?: boolean, world?: Partial<RouteSwitchWorld> } = {}) {
  const store = new RouteStore(null)
  const hub = createRouteHub({ store, proxy: () => options.proxy === false ? undefined : { host: '127.0.0.1', port: 9050 }, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  const settled = vi.fn(async () => {})
  const routes = { proxy: () => options.proxy === false ? undefined : { host: '127.0.0.1', port: 9050 }, store, hub, controller: { settled } as never }
  const world: RouteSwitchWorld = { isPinned: (origin) => origin === APP, isPersistable: () => true, ...options.world }
  return { store, hub, settled, routeSwitch: createRouteSwitch(routes, world) }
}

describe('turning a website\'s tunnel on', () => {
  it('writes an on entry and records that the website has storage of its own, once the sessions follow', async () => {
    const { routeSwitch, store, settled } = setup()
    await routeSwitch.setSite(SITE, true)
    expect(store.stateOf(SITE)).toBe('on')
    expect(store.isApart(SITE)).toBe(true)
    expect(settled).toHaveBeenCalled()
  })

  it('tells the person first only until the website has storage of its own', async () => {
    const { routeSwitch } = setup()
    expect(routeSwitch.siteNeedsNotice(SITE)).toBe(true)
    await routeSwitch.setSite(SITE, true)
    expect(routeSwitch.siteNeedsNotice(SITE)).toBe(false)
    await routeSwitch.setSite(SITE, false)
    expect(routeSwitch.siteNeedsNotice(SITE)).toBe(false)
  })

  it('sends the website back to following the default when turned off, and keeps its storage', async () => {
    const { routeSwitch, store } = setup()
    await routeSwitch.setSite(SITE, true)
    await routeSwitch.setSite(SITE, false)
    expect(store.stateOf(SITE)).toBeUndefined()
    expect(store.isApart(SITE)).toBe(true)
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
    expect(store.stateOf(APP)).toBe('on')
    expect(store.isApart(APP)).toBe(false)
    await routeSwitch.set(APP, false)
    expect(store.stateOf(APP)).toBeUndefined()
    expect(setup({ proxy: false }).routeSwitch.blockedFor(APP)).toBe('no-proxy')
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
      { origin: APP, kind: 'app', entry: 'on', state: 'idle', apart: false },
      { origin: SITE, kind: 'site', entry: 'on', state: 'idle', apart: true },
      { origin: 'https://old.example', kind: 'site', entry: undefined, state: 'off', apart: true }
    ])
  })
})

describe('removing a website\'s separate storage', () => {
  it('clears the session named for the origin, forgets the storage when no entry is left, and keeps the entry when there is one', async () => {
    const removeSiteStorage = vi.fn(async () => {})
    const { routeSwitch, store } = setup({ world: { removeSiteStorage } })
    await routeSwitch.setSite(SITE, true)

    expect(await routeSwitch.removeSiteStorage(SITE)).toBe(true)
    expect(removeSiteStorage).toHaveBeenCalledWith(sitePartitionFor(SITE))
    expect(store.stateOf(SITE)).toBe('on')
    expect(store.isApart(SITE)).toBe(true)

    await routeSwitch.setSite(SITE, false)
    expect(await routeSwitch.removeSiteStorage(SITE)).toBe(true)
    expect(store.isApart(SITE)).toBe(false)
    expect(routeSwitch.siteNeedsNotice(SITE)).toBe(true)
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
