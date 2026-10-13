import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRouteService } from '../route-service.js'
import type { ProxySettings, RouteKind } from '../route-service.js'
import { NYM_TARGET } from '../nym-provider.js'
import type { NymSubsystem } from '../nym-subsystem.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'

const FAKE_NYM: NymSubsystem = { ensure: async () => ({ port: 1, secret: 's' }), state: () => ({ state: 'off' }), onChange: () => () => {}, test: async () => ({ ok: true, ms: 1 }), stop: () => {} }

function service (savedProxy: string, savedKind: RouteKind = 'socks5', nym: NymSubsystem = FAKE_NYM) {
  const store = new RouteStore(null)
  return createRouteService({
    store,
    savedProxy,
    savedKind,
    nym,
    electron: {
      broker: () => undefined,
      sessionFor: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }),
      embedPartition: (origin) => `embed:${origin}`,
      allContents: () => [],
      onContentsCreated: () => {},
      onLogin: () => {}
    }
  })
}

function settingsWith (initial: string, initialKind: RouteKind = 'socks5', initialEverywhere = false): ProxySettings & { set: (value: string) => void, setKind: (kind: RouteKind) => void, setEverywhere: (value: boolean) => void } {
  let value = initial
  let kind = initialKind
  let everywhere = initialEverywhere
  const listeners = new Set<(change: { readonly key: string }) => void>()
  const tell = (key: string): void => { for (const listener of [...listeners]) listener({ key }) }
  return {
    get: ((key: string) => key === 'network.route.kind' ? kind : key === 'network.route.proxy' ? value : everywhere) as ProxySettings['get'],
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { value = next; tell('network.route.proxy') },
    setKind: (next) => { kind = next; tell('network.route.kind') },
    setEverywhere: (next) => { everywhere = next; tell('network.tunnel.everywhere') }
  }
}

describe('the route service', () => {
  it('uses the saved proxy until the settings are followed, and nothing when it is not an address', () => {
    expect(service('127.0.0.1:9050').proxy()).toEqual({ host: '127.0.0.1', port: 9050 })
    expect(service('').proxy()).toBeUndefined()
    expect(service('nonsense').proxy()).toBeUndefined()
  })

  it('follows the settings, and tells a routed app\'s listeners when the proxy changes', () => {
    const routes = service('127.0.0.1:9050')
    routes.store.set(APP, true)
    const settings = settingsWith('127.0.0.1:9050')
    const heard = vi.fn()
    routes.hub.onChange(heard)
    routes.followSettings(settings)
    expect(heard).not.toHaveBeenCalled()

    settings.set('127.0.0.1:9150')

    expect(routes.proxy()).toEqual({ host: '127.0.0.1', port: 9150 })
    expect(heard).toHaveBeenCalledWith(APP, true, 'proxy')
  })

  it('starts from the saved browser-wide setting and follows its changes, telling the shared identity and each app that follows the default', () => {
    const store = new RouteStore(null)
    const routes = createRouteService({ store, savedProxy: '127.0.0.1:9050', savedKind: 'socks5', nym: FAKE_NYM, savedEverywhere: false, installed: () => [APP], electron: { broker: () => undefined, isApp: (origin) => origin === APP, sessionFor: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }), embedPartition: (origin) => `embed:${origin}`, allContents: () => [], onContentsCreated: () => {}, onLogin: () => {} } })
    const settings = settingsWith('127.0.0.1:9050')
    const heard = vi.fn()
    routes.hub.onChange(heard)
    routes.followSettings(settings)
    expect(routes.everywhere()).toBe(false)
    expect(routes.hub.isRouted(APP)).toBe(false)

    settings.setEverywhere(true)

    expect(routes.everywhere()).toBe(true)
    expect(routes.hub.isRouted(APP)).toBe(true)
    expect(heard.mock.calls).toEqual([['orivon-shared-tunnel', true, 'switch'], [APP, true, 'switch']])
  })

  it('applies a setting that differs from the saved one the moment it is followed', () => {
    const routes = service('')
    routes.followSettings(settingsWith('127.0.0.1:9050'))
    expect(routes.proxy()).toEqual({ host: '127.0.0.1', port: 9050 })
  })

  it('clears the route of an app that is forgotten, and tells the listeners the app is no longer routed', async () => {
    const routes = service('127.0.0.1:9050')
    routes.store.set(APP, true)
    const heard = vi.fn()
    routes.hub.onChange(heard)

    routes.forget(APP)
    await routes.controller.settled()

    expect(routes.store.has(APP)).toBe(false)
    expect(routes.hub.isRouted(APP)).toBe(false)
    expect(heard).toHaveBeenCalledWith(APP, false, 'switch')
  })

  it('keeps the route of an app whose clearing could not be saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-routes-service-'))
    try {
      const path = join(dir, 'routes.json')
      const store = new RouteStore(path)
      store.set(APP, true)
      rmSync(path)
      mkdirSync(path)
      const routes = createRouteService({ store, savedProxy: '127.0.0.1:9050', savedKind: 'socks5', nym: FAKE_NYM, electron: { broker: () => undefined, sessionFor: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }), embedPartition: (origin) => `embed:${origin}`, allContents: () => [], onContentsCreated: () => {}, onLogin: () => {} } })

      routes.forget(APP)

      expect(routes.hub.isRouted(APP)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves through Nym when that is the choice, whatever address is saved, and through the address when it is not', () => {
    expect(service('127.0.0.1:9050', 'nym').proxy()).toBe(NYM_TARGET)
    expect(service('', 'nym').proxy()).toBe(NYM_TARGET)
    expect(service('127.0.0.1:9050', 'socks5').proxy()).toEqual({ host: '127.0.0.1', port: 9050 })
  })

  it('gives a route to Nym the Nym provider, and a route to an address the SOCKS5 one', () => {
    const routes = service('127.0.0.1:9050', 'nym')
    expect(routes.providerFor('https://one.example', NYM_TARGET)).toBeDefined()
    expect(routes.providerFor('https://one.example', { host: '127.0.0.1', port: 9050 })).toBeUndefined()
  })

  it('tells a routed app\'s listeners when the choice moves between Nym and the address, and not when an address is typed under Nym', () => {
    const routes = service('127.0.0.1:9050', 'socks5')
    routes.store.set(APP, true)
    const settings = settingsWith('127.0.0.1:9050', 'socks5')
    const heard = vi.fn()
    routes.hub.onChange(heard)
    routes.followSettings(settings)

    settings.setKind('nym')
    expect(routes.proxy()).toBe(NYM_TARGET)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenLastCalledWith(APP, true, 'proxy')

    settings.set('127.0.0.1:9150')
    expect(heard).toHaveBeenCalledTimes(1)

    settings.setKind('socks5')
    expect(routes.proxy()).toEqual({ host: '127.0.0.1', port: 9150 })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('fails a routed app\'s connection closed when Nym cannot run, and never dials direct', async () => {
    const unavailable: NymSubsystem = { ...FAKE_NYM, ensure: async () => { throw new Error('the Nym tunnel is not in this build') } }
    const routes = service('', 'nym', unavailable)
    routes.store.set(APP, true)
    const route = routes.hub.routeFor(APP)
    await expect(route?.provider.connect('service.example', 443, new AbortController().signal)).rejects.toThrow(/not in this build/)
  })
})
