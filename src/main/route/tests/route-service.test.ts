import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRouteService } from '../route-service.js'
import type { ProxySettings } from '../route-service.js'
import { RouteStore } from '../route-store.js'

const APP = 'https://one.example'

function service (savedProxy: string) {
  const store = new RouteStore(null)
  return createRouteService({
    store,
    savedProxy,
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

function settingsWith (initial: string, initialEverywhere = false): ProxySettings & { set: (value: string) => void, setEverywhere: (value: boolean) => void } {
  let value = initial
  let everywhere = initialEverywhere
  const listeners = new Set<(change: { readonly key: string }) => void>()
  return {
    get: ((key: string) => key === 'network.route.proxy' ? value : everywhere) as ProxySettings['get'],
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { value = next; for (const listener of [...listeners]) listener({ key: 'network.route.proxy' }) },
    setEverywhere: (next) => { everywhere = next; for (const listener of [...listeners]) listener({ key: 'network.tunnel.everywhere' }) }
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
    const routes = createRouteService({ store, savedProxy: '127.0.0.1:9050', savedEverywhere: false, installed: () => [APP], electron: { broker: () => undefined, isApp: (origin) => origin === APP, sessionFor: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }), embedPartition: (origin) => `embed:${origin}`, allContents: () => [], onContentsCreated: () => {}, onLogin: () => {} } })
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
      const routes = createRouteService({ store, savedProxy: '127.0.0.1:9050', electron: { broker: () => undefined, sessionFor: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }), embedPartition: (origin) => `embed:${origin}`, allContents: () => [], onContentsCreated: () => {}, onLogin: () => {} } })

      routes.forget(APP)

      expect(routes.hub.isRouted(APP)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
