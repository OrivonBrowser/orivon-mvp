import { NYM_SWITCHED_OFF } from '../../route/nym-subsystem.js'
import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps } from '../../../broker/tests/index.test-helpers.js'
import type { SubsystemContext } from '../../registry.js'
import { createSiteInfoController } from '../site-info-controller.js'
import type { SiteTrustSources } from '../site-info-controller.js'
import type { BrowserTunnels } from '../site-info-browser.js'
import type { BrowserTunnelTab, SiteTunnelKind } from '../site-info.js'

// The Browser-wide panel of the tunnels popup: what the controller says of the whole browser's tunnel, and the two switches that
// move it. The settings are injected, so every order and refusal is read off a fake.

const NO_TRUST: SiteTrustSources = {
  isOriginServedFromCacheSync: () => false,
  pinCoverageFor: () => undefined,
  nameEvidenceFor: async () => undefined,
  levelOverrideFor: () => undefined,
  deliveryOverrideFor: () => undefined,
  localDdocHashFor: async () => undefined,
  providerVerdictFor: async () => ({ status: 'off' })
}

interface World {
  kind: SiteTunnelKind
  everywhere: boolean
  nodes: boolean
  unreadable?: boolean
  nymOff?: boolean
  noProxy?: boolean
  routeState?: string
  tabs?: readonly BrowserTunnelTab[]
}

/** The settings and routes of one browser, which the fake setters really move, and the calls they took in order. */
function world (start: Partial<World> = {}, refuse: Partial<Record<'kind' | 'everywhere' | 'nodes', boolean>> = {}) {
  const state: World = { kind: 'nym', everywhere: false, nodes: false, ...start }
  const calls: string[] = []
  const setters = {
    setKind: vi.fn((kind: SiteTunnelKind) => { calls.push(`kind:${kind}`); if (refuse.kind === true) return false; state.kind = kind; return true }),
    setEverywhere: vi.fn((on: boolean) => { calls.push(`everywhere:${String(on)}`); if (refuse.everywhere === true) return false; state.everywhere = on; return true }),
    setNodes: vi.fn((on: boolean) => { calls.push(`nodes:${String(on)}`); if (refuse.nodes === true) return false; state.nodes = on; return true })
  }
  const tunnels: BrowserTunnels = { tabs: () => state.tabs ?? [], nodes: () => state.nodes, ...setters }
  const routes = {
    hub: {
      state: (origin: string) => { calls.push(`state:${origin}`); return state.routeState ?? 'ok' },
      unreadable: () => state.unreadable === true,
      profileFor: () => state.unreadable === true ? 'nym' : undefined,
      isEverywhere: () => state.everywhere,
      kindOf: () => undefined
    },
    routeSwitch: { blockedFor: () => undefined, noticeFor: () => undefined },
    store: { entries: () => [], stateOf: () => undefined },
    defaultKind: () => state.kind,
    targetOf: (kind: SiteTunnelKind) => kind === 'socks5' && state.noProxy === true ? undefined : { host: '127.0.0.1', port: 9050 },
    nym: { state: () => state.nymOff === true ? { state: 'unavailable', cause: 'other', reason: NYM_SWITCHED_OFF } : { state: 'ready' } }
  } as unknown as SubsystemContext['routes']
  return { state, calls, setters, tunnels, routes }
}

/** What the popup draws for the tab `t1`: its info and the tunnel of the whole browser. */
const popupInfo = (controller: ReturnType<typeof controllerFor>) => controller.withBrowserTunnel(controller.tabInfoFor('t1') as never)

const controllerFor = (w: ReturnType<typeof world> | undefined, routes: SubsystemContext['routes'], privateTunnel: 'nym' | null = null) =>
  createSiteInfoController({ broker: createBroker(baseDeps()), routes, privateTunnel } as unknown as SubsystemContext, NO_TRUST, undefined, undefined, undefined, { choiceOf: () => ({ choice: undefined }), set: () => {} }, w?.tunnels)

describe('what the controller says of the browser\'s tunnel', () => {
  it('is on no tunnel, with the default one named, while the whole browser is not on a tunnel', () => {
    const w = world({ kind: 'socks5' })
    const info = popupInfo(controllerFor(w, w.routes))
    expect(info?.browserTunnel).toMatchObject({ via: null, defaultKind: 'socks5', nodes: false, unreadable: false, tabs: [], blocked: {}, proxy: { address: '', users: { sites: 0, apps: 0, everything: false } } })
    expect(info?.browserTunnel?.route, 'a browser on no tunnel has no route to speak of').toBeUndefined()
  })

  it('is on the default tunnel while the whole browser is on one, and reads the shared route, and what Nym is doing', () => {
    const w = world({ everywhere: true, nodes: true, routeState: 'down' })
    const browser = popupInfo(controllerFor(w, w.routes))?.browserTunnel
    expect(browser).toMatchObject({ via: 'nym', nodes: true, route: 'down', nym: { state: 'ready' } })
    expect(w.calls).toContain('state:orivon-shared-tunnel')
    const proxy = world({ everywhere: true, kind: 'socks5' })
    const onProxy = popupInfo(controllerFor(proxy, proxy.routes))?.browserTunnel
    expect(onProxy).toMatchObject({ via: 'socks5', route: 'ok', proxy: { users: { everything: true } } })
    expect(onProxy?.nym).toBeUndefined()
  })

  it('lists the tabs that keep a choice of their own, as the browser names them', () => {
    const tabs: BrowserTunnelTab[] = [{ title: 'News', choice: 'nym' }, { title: 'https://plain.example/', choice: 'direct' }]
    const w = world({ tabs })
    expect(popupInfo(controllerFor(w, w.routes))?.browserTunnel?.tabs).toEqual(tabs)
  })

  it('says why a tunnel cannot be chosen, and that the settings could not be read', () => {
    const noProxy = world({ noProxy: true })
    expect(popupInfo(controllerFor(noProxy, noProxy.routes))?.browserTunnel?.blocked).toEqual({ socks5: 'no-proxy' })
    const nymOff = world({ nymOff: true })
    expect(popupInfo(controllerFor(nymOff, nymOff.routes))?.browserTunnel?.blocked).toEqual({ nym: 'nym-off' })
    const unreadable = world({ unreadable: true, everywhere: true })
    expect(popupInfo(controllerFor(unreadable, unreadable.routes))?.browserTunnel).toMatchObject({ unreadable: true, via: 'nym' })
  })

  it('is added to a website\'s info for the popup, and not to what the toolbar asks on every tab change, and absent while routes are not running', async () => {
    const w = world({ everywhere: true })
    const controller = controllerFor(w, w.routes)
    const site = await controller.siteInfoFor('https://news.example/')
    expect(site.browserTunnel).toBeUndefined()
    expect(controller.withBrowserTunnel(site).browserTunnel).toMatchObject({ via: 'nym' })
    const bare = await controllerFor(undefined, undefined).siteInfoFor('https://news.example/')
    expect(controllerFor(undefined, undefined).withBrowserTunnel(bare)).toBe(bare)
  })
})

describe('setBrowserTunnel', () => {
  it('saves the tunnel first and only then turns the whole browser on, so the routes never see the old tunnel switched on', () => {
    const w = world()
    expect(controllerFor(w, w.routes).setBrowserTunnel('socks5')).toBe(true)
    expect(w.calls.filter((call) => !call.startsWith('state:'))).toEqual(['kind:socks5', 'everywhere:true'])
  })

  it('turns only the browser-wide switch off when the lit tunnel is turned off, and leaves the default tunnel alone', () => {
    const w = world({ everywhere: true, kind: 'socks5' })
    expect(controllerFor(w, w.routes).setBrowserTunnel(null)).toBe(true)
    expect(w.calls).toEqual(['everywhere:false'])
    expect(w.state).toMatchObject({ kind: 'socks5', everywhere: false })
  })

  it('does not turn the browser on when the tunnel could not be saved, and says it was not done when the switch could not move', () => {
    const noKind = world({}, { kind: true })
    expect(controllerFor(noKind, noKind.routes).setBrowserTunnel('socks5')).toBe(false)
    expect(noKind.setters.setEverywhere).not.toHaveBeenCalled()
    const noSwitch = world({}, { everywhere: true })
    expect(controllerFor(noSwitch, noSwitch.routes).setBrowserTunnel('nym')).toBe(false)
  })

  it('refuses a tunnel that cannot be used: no proxy address, Nym switched off. Turning off is always allowed', () => {
    const noProxy = world({ noProxy: true, everywhere: true })
    const controller = controllerFor(noProxy, noProxy.routes)
    expect(controller.setBrowserTunnel('socks5')).toBe(false)
    expect(noProxy.setters.setKind).not.toHaveBeenCalled()
    expect(controller.setBrowserTunnel(null)).toBe(true)
    const nymOff = world({ nymOff: true, everywhere: true })
    expect(controllerFor(nymOff, nymOff.routes).setBrowserTunnel('nym')).toBe(false)
    expect(controllerFor(nymOff, nymOff.routes).setBrowserTunnel(null)).toBe(true)
  })

  it('changes nothing while the tunnel settings cannot be read, in a window held to Nym, and while routes are not running', () => {
    const unreadable = world({ unreadable: true })
    expect(controllerFor(unreadable, unreadable.routes).setBrowserTunnel('nym')).toBe(false)
    expect(controllerFor(unreadable, unreadable.routes).setBrowserTunnel(null)).toBe(false)
    const held = world({ everywhere: true })
    const heldController = controllerFor(held, held.routes, 'nym')
    for (const kind of ['nym', 'socks5', null] as const) expect(heldController.setBrowserTunnel(kind), String(kind)).toBe(false)
    expect(controllerFor(world(), undefined).setBrowserTunnel('nym')).toBe(false)
    for (const refused of [unreadable, held]) expect(refused.calls.filter((call) => !call.startsWith('state:'))).toEqual([])
  })
})

describe('setNodesTunnel', () => {
  it('saves whether the nodes follow the tunnel, either way', () => {
    const w = world()
    const controller = controllerFor(w, w.routes)
    expect(controller.setNodesTunnel(true)).toBe(true)
    expect(controller.setNodesTunnel(false)).toBe(true)
    expect(w.calls).toEqual(['nodes:true', 'nodes:false'])
  })

  it('says it was not done when the setting could not be saved', () => {
    const w = world({}, { nodes: true })
    expect(controllerFor(w, w.routes).setNodesTunnel(true)).toBe(false)
  })

  it('changes nothing while the tunnel settings cannot be read, in a window held to Nym, and while routes are not running', () => {
    const unreadable = world({ unreadable: true })
    expect(controllerFor(unreadable, unreadable.routes).setNodesTunnel(true)).toBe(false)
    const held = world({ everywhere: true })
    expect(controllerFor(held, held.routes, 'nym').setNodesTunnel(true)).toBe(false)
    expect(controllerFor(world(), undefined).setNodesTunnel(true)).toBe(false)
    for (const refused of [unreadable, held]) expect(refused.setters.setNodes).not.toHaveBeenCalled()
  })
})
