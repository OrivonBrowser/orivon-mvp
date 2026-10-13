// What the rest of the browser sees of the routes: the hub (which apps are routed, their route and front), the
// controller (what that does to Chromium) and the store. Built once by `routeSubsystem`; Electron-free.

import type { RouteTarget } from '../../broker/route/table.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import { createRouteController } from './route-controller.js'
import type { RouteController, RouteControllerDeps } from './route-controller.js'
import { createRouteHub } from './route-hub.js'
import type { RouteHub } from './route-hub.js'
import type { RouteStore } from './route-store.js'

/** The part of the settings store the proxy is read from. */
export interface ProxySettings {
  get: (key: 'network.route.proxy') => string
  onChange: (listener: (change: { readonly key: string }) => void) => () => void
}

export interface RouteService {
  readonly hub: RouteHub
  readonly controller: RouteController
  readonly store: RouteStore
  /** The proxy now, undefined when none is set or the setting is not an address. */
  proxy: () => RouteTarget | undefined
  /** An app was taken away: its route is cleared, and its front and sessions are let go. A route that cannot be cleared stays. */
  forget: (origin: string) => void
  /** Reads the proxy from the settings store from now on, and tells the hub when it changes. Call once the settings are read. */
  followSettings: (settings: ProxySettings) => void
}

const KEY = 'network.route.proxy'

export interface RouteServiceOptions {
  readonly store: RouteStore
  /** The saved proxy setting, read before the settings store is: what applies until `followSettings`. */
  readonly savedProxy: string
  /** The apps installed here, asked only while the store cannot say which are routed. */
  readonly installed?: () => readonly string[]
  readonly electron: Omit<RouteControllerDeps, 'hub'>
}

export function createRouteService (options: RouteServiceOptions): RouteService {
  let current = options.savedProxy
  const proxy = (): RouteTarget | undefined => parseProxyAddress(current)
  const hub = createRouteHub({ store: options.store, proxy, ...(options.installed === undefined ? {} : { installed: options.installed }) })
  const controller = createRouteController({ ...options.electron, hub })
  return {
    hub,
    controller,
    store: options.store,
    proxy,
    forget: (origin) => {
      try {
        // An unreadable list holds no entry to clear, and cannot be written to.
        if (!options.store.unreadable()) options.store.set(origin, false)
      } catch (error) {
        console.error('[route] could not clear the route of a forgotten app:', error)
        return
      }
      controller.forget(origin)
    },
    followSettings: (settings) => {
      const read = (): void => {
        if (settings.get(KEY) === current) return
        current = settings.get(KEY)
        hub.proxyChanged()
      }
      read()
      settings.onChange((change) => { if (change.key === KEY) read() })
    }
  }
}
