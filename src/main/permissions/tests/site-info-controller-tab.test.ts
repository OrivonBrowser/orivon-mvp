import { NYM_SWITCHED_OFF } from '../../route/nym-subsystem.js'
import { describe, expect, it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps } from '../../../broker/tests/index.test-helpers.js'
import type { SubsystemContext } from '../../registry.js'
import type { TabTunnelChoice } from '../../route/tab-tunnel.js'
import { createSiteInfoController } from '../site-info-controller.js'
import type { SiteTrustSources } from '../site-info-controller.js'
import type { TabTunnels } from '../site-info-tab.js'

const NO_TRUST: SiteTrustSources = {
  isOriginServedFromCacheSync: () => false,
  pinCoverageFor: () => undefined,
  nameEvidenceFor: async () => undefined,
  levelOverrideFor: () => undefined,
  deliveryOverrideFor: () => undefined,
  localDdocHashFor: async () => undefined,
  providerVerdictFor: async () => ({ status: 'off' })
}
const ctxWith = (): SubsystemContext => ({ broker: createBroker(baseDeps()) }) as unknown as SubsystemContext

describe('createSiteInfoController -- the tunnel of a tab', () => {
  interface Options {
    everywhere?: boolean
    defaultKind?: 'nym' | 'socks5'
    unreadable?: boolean
    /** The profile every website is in while the settings cannot be read. */
    unreadableProfile?: 'nym' | 'socks5'
    nymOff?: boolean
    noProxy?: boolean
    routeState?: string
  }
  const asked: string[] = []
  function routesFor (options: Options = {}): SubsystemContext['routes'] {
    asked.length = 0
    return {
      hub: {
        state: (origin: string) => { asked.push(origin); return options.routeState ?? 'ok' },
        unreadable: () => options.unreadable === true,
        profileFor: () => options.unreadable === true ? options.unreadableProfile ?? 'nym' : undefined,
        isEverywhere: () => options.everywhere === true
      },
      store: { entries: () => [] },
      defaultKind: () => options.defaultKind ?? 'nym',
      targetOf: (kind: 'nym' | 'socks5') => kind === 'socks5' && options.noProxy === true ? undefined : { host: '127.0.0.1', port: 9050 },
      nym: { state: () => options.nymOff === true ? { state: 'unavailable', cause: 'other', reason: NYM_SWITCHED_OFF } : { state: 'ready' } }
    } as unknown as SubsystemContext['routes']
  }
  /** One open tab, 't1', whose choice `set` replaces unless `stuck` says the move could not be made. */
  function tabs (choice: TabTunnelChoice | undefined, stuck = false): TabTunnels & { choice: () => TabTunnelChoice | undefined, set: ReturnType<typeof vi.fn> } {
    let current = choice
    const set = vi.fn((_id: string, next: TabTunnelChoice | null) => { if (!stuck) current = next ?? undefined })
    return { choiceOf: (id) => id === 't1' ? { choice: current } : undefined, set, choice: () => current }
  }
  const controllerFor = (routes: SubsystemContext['routes'], tabSet: TabTunnels, privateTunnel: 'nym' | null = null) =>
    createSiteInfoController({ ...ctxWith(), routes, privateTunnel } as unknown as SubsystemContext, NO_TRUST, undefined, undefined, undefined, tabSet)

  it('describes a tab with no choice as following the browser, with nothing lit while the whole browser is not on a tunnel', async () => {
    const info = await controllerFor(routesFor(), tabs(undefined)).tabInfoFor('t1')
    expect(info).toMatchObject({ origin: '', displayOrigin: 'This tab', tunnel: { subject: 'tab', via: null, following: true, notices: {} }, everywhere: false })
    expect(info?.route).toBeUndefined()
    expect(info?.nym).toBeUndefined()
  })

  it('has nothing for a tab that is not open, and while routes are not running', async () => {
    expect(await controllerFor(routesFor(), tabs(undefined)).tabInfoFor('gone')).toBeUndefined()
    expect(await controllerFor(undefined, tabs('nym')).tabInfoFor('t1')).toBeUndefined()
  })

  it('says a tab with a choice goes through it, reads the route of that tunnel\'s profile and asks what Nym is doing for Nym', async () => {
    const nym = await controllerFor(routesFor({ routeState: 'down' }), tabs('nym')).tabInfoFor('t1')
    expect(nym).toMatchObject({ tunnelKind: 'nym', route: 'down', nym: { state: 'ready' }, tunnel: { via: 'nym', following: false, tabChoice: 'nym' } })
    expect(asked).toEqual(['orivon-tunnel-profile'])
    const proxy = await controllerFor(routesFor(), tabs('socks5')).tabInfoFor('t1')
    expect(proxy).toMatchObject({ tunnelKind: 'socks5', route: 'ok', tunnel: { via: 'socks5', tabChoice: 'socks5' } })
    expect(proxy?.nym).toBeUndefined()
    expect(asked).toEqual(['orivon-proxy-profile'])
  })

  it('reads the shared route for a tab that follows the whole browser\'s tunnel', async () => {
    const info = await controllerFor(routesFor({ everywhere: true, defaultKind: 'socks5' }), tabs(undefined)).tabInfoFor('t1')
    expect(info).toMatchObject({ tunnelKind: 'socks5', everywhere: true, route: 'ok', tunnel: { via: 'socks5', following: true } })
    expect(asked).toEqual(['orivon-shared-tunnel'])
  })

  it('has no route for a tab set to go direct, even while the whole browser is on a tunnel', async () => {
    const info = await controllerFor(routesFor({ everywhere: true }), tabs('direct')).tabInfoFor('t1')
    expect(info).toMatchObject({ everywhere: true, tunnel: { via: null, following: false, tabChoice: 'direct' } })
    expect(info?.route).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('says why a tunnel cannot be chosen, and that the settings could not be read, and that a private window is held to Nym', async () => {
    expect((await controllerFor(routesFor({ noProxy: true }), tabs(undefined)).tabInfoFor('t1'))?.tunnel?.blocked).toEqual({ socks5: 'no-proxy' })
    expect((await controllerFor(routesFor({ nymOff: true }), tabs(undefined)).tabInfoFor('t1'))?.tunnel?.blocked).toEqual({ nym: 'nym-off' })
    expect((await controllerFor(routesFor({ unreadable: true }), tabs(undefined)).tabInfoFor('t1'))?.tunnel?.unreadable).toBe(true)
    expect((await controllerFor(routesFor(), tabs(undefined), 'nym').tabInfoFor('t1'))?.tunnelHeld).toBe('nym')
  })

  describe('while the tunnel settings cannot be read', () => {
    it('lights the tunnel every website takes for a tab with no choice, even with the whole browser off a tunnel, and reads that tunnel\'s profile', async () => {
      const info = await controllerFor(routesFor({ unreadable: true, unreadableProfile: 'nym', routeState: 'down' }), tabs(undefined)).tabInfoFor('t1')
      expect(info).toMatchObject({ tunnelKind: 'nym', route: 'down', nym: { state: 'ready' }, tunnel: { via: 'nym', following: true, unreadable: true } })
      expect(asked).toEqual(['orivon-tunnel-profile'])
    })

    it('takes the default tunnel\'s profile when it has an address, which is the proxy', async () => {
      const info = await controllerFor(routesFor({ unreadable: true, unreadableProfile: 'socks5', defaultKind: 'socks5' }), tabs(undefined)).tabInfoFor('t1')
      expect(info).toMatchObject({ tunnelKind: 'socks5', route: 'ok', tunnel: { via: 'socks5' } })
      expect(info?.nym).toBeUndefined()
      expect(asked).toEqual(['orivon-proxy-profile'])
    })

    it('does not say direct for a tab restored with a direct choice: its websites go where every website does', async () => {
      const info = await controllerFor(routesFor({ unreadable: true, unreadableProfile: 'socks5', defaultKind: 'socks5' }), tabs('direct')).tabInfoFor('t1')
      expect(info).toMatchObject({ tunnelKind: 'socks5', route: 'ok', tunnel: { via: 'socks5', tabChoice: 'direct', unreadable: true } })
      expect(asked).toEqual(['orivon-proxy-profile'])
    })

    it('keeps a tunnel the tab chose', async () => {
      const info = await controllerFor(routesFor({ unreadable: true, unreadableProfile: 'nym' }), tabs('socks5')).tabInfoFor('t1')
      expect(info).toMatchObject({ tunnelKind: 'socks5', tunnel: { via: 'socks5', tabChoice: 'socks5' } })
      expect(asked).toEqual(['orivon-proxy-profile'])
    })
  })

  it('gives the tab the tunnel asked for, and says whether it kept it', async () => {
    const set = tabs(undefined)
    const controller = controllerFor(routesFor(), set)
    expect(await controller.setTabTunnel('t1', 'nym')).toBe(true)
    expect(set.set).toHaveBeenLastCalledWith('t1', 'nym')
    expect(await controller.setTabTunnel('t1', 'socks5')).toBe(true)
    expect(set.choice()).toBe('socks5')
    const stuck = tabs(undefined, true)
    expect(await controllerFor(routesFor(), stuck).setTabTunnel('t1', 'nym'), 'the move could not be made, so the tab kept what it had').toBe(false)
  })

  it('takes the choice away when the lit switch is turned off while the whole browser is not on a tunnel, and sets direct while it is', async () => {
    const off = tabs('nym')
    expect(await controllerFor(routesFor(), off).setTabTunnel('t1', null)).toBe(true)
    expect(off.set).toHaveBeenLastCalledWith('t1', null)
    const everywhere = tabs('nym')
    expect(await controllerFor(routesFor({ everywhere: true }), everywhere).setTabTunnel('t1', null)).toBe(true)
    expect(everywhere.set).toHaveBeenLastCalledWith('t1', 'direct')
  })

  it('refuses a tunnel that is blocked or Nym while it is switched off, but always lets one go', async () => {
    const noProxy = tabs(undefined)
    expect(await controllerFor(routesFor({ noProxy: true }), noProxy).setTabTunnel('t1', 'socks5')).toBe(false)
    expect(noProxy.set).not.toHaveBeenCalled()
    const off = tabs('socks5')
    const controller = controllerFor(routesFor({ nymOff: true }), off)
    expect(await controller.setTabTunnel('t1', 'nym')).toBe(false)
    expect(await controller.setTabTunnel('t1', null)).toBe(true)
  })

  it('changes nothing while the tunnel settings cannot be read, in a private window held to Nym except to Nym, for a tab that is gone and while routes are not running', async () => {
    const unreadable = tabs(undefined)
    expect(await controllerFor(routesFor({ unreadable: true }), unreadable).setTabTunnel('t1', 'nym')).toBe(false)
    const held = tabs(undefined)
    const heldController = controllerFor(routesFor(), held, 'nym')
    expect(await heldController.setTabTunnel('t1', 'socks5')).toBe(false)
    expect(await heldController.setTabTunnel('t1', null)).toBe(false)
    expect(held.set).not.toHaveBeenCalled()
    expect(await heldController.setTabTunnel('t1', 'nym')).toBe(true)
    expect(await controllerFor(routesFor(), tabs(undefined)).setTabTunnel('gone', 'nym')).toBe(false)
    expect(await controllerFor(undefined, tabs(undefined)).setTabTunnel('t1', 'nym')).toBe(false)
    expect(unreadable.set).not.toHaveBeenCalled()
  })
})
