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
      onLogin: () => {},
      reloadTabs: () => {}
    }
  })
}

function settingsWith (initial: string): ProxySettings & { set: (value: string) => void } {
  let value = initial
  const listeners = new Set<(change: { readonly key: string }) => void>()
  return {
    get: () => value,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next) => { value = next; for (const listener of [...listeners]) listener({ key: 'network.route.proxy' }) }
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

  it('applies a setting that differs from the saved one the moment it is followed', () => {
    const routes = service('')
    routes.followSettings(settingsWith('127.0.0.1:9050'))
    expect(routes.proxy()).toEqual({ host: '127.0.0.1', port: 9050 })
  })
})
