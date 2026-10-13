// What the rest of the browser sees of the routes: the hub (which apps are routed, their route and front), the
// controller (what that does to Chromium) and the store. Built once by `routeSubsystem`; Electron-free.

import type { RouteTarget } from '../../broker/route/table.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import { createRouteController } from './route-controller.js'
import type { RouteController, RouteControllerDeps } from './route-controller.js'
import { createRouteHub } from './route-hub.js'
import type { RouteHub } from './route-hub.js'
import { createRouteSwitch } from './route-switch.js'
import type { RouteSwitch, RouteSwitchWorld } from './route-switch.js'
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
  /** The one path that turns an app's or a website's tunnel on or off. */
  readonly routeSwitch: RouteSwitch
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
  /** The apps installed here, asked only while the store cannot say what was set. */
  readonly installed?: () => readonly string[]
  /** Whether the whole browser goes through the tunnel unless an origin says otherwise; off until the browser-wide setting exists. */
  readonly everywhere?: () => boolean
  /** What the switch reads about the world: the app's files held here, its origin written to disk, and a website's own storage. */
  readonly switchWorld?: RouteSwitchWorld
  readonly electron: Omit<RouteControllerDeps, 'hub'>
}

export function createRouteService (options: RouteServiceOptions): RouteService {
  let current = options.savedProxy
  const proxy = (): RouteTarget | undefined => parseProxyAddress(current)
  const hub = createRouteHub({ store: options.store, proxy, ...(options.installed === undefined ? {} : { installed: options.installed }), ...(options.everywhere === undefined ? {} : { everywhere: options.everywhere }) })
  const controller = createRouteController({ ...options.electron, hub })
  const routeSwitch = createRouteSwitch({ proxy, store: options.store, controller, hub }, options.switchWorld ?? { isPinned: () => false, isPersistable: () => false })
  return {
    hub,
    controller,
    store: options.store,
    routeSwitch,
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
