// What the rest of the browser sees of the routes: the hub (which apps are routed, their route and front), the
// controller (what that does to Chromium) and the store. Built once by `routeSubsystem`; Electron-free.

import { isolationCredentials } from '../../broker/route/socks5.js'
import type { RouteProvider } from '../../broker/route/provider.js'
import type { RouteTarget } from '../../broker/route/table.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import { createRouteController } from './route-controller.js'
import type { RouteController, RouteControllerDeps } from './route-controller.js'
import { createRouteHub } from './route-hub.js'
import type { RouteHub } from './route-hub.js'
import { createNymProvider, isNymTarget, NYM_TARGET } from './nym-provider.js'
import type { NymSubsystem } from './nym-subsystem.js'
import type { RouteStore } from './route-store.js'

export type RouteKind = 'nym' | 'socks5'

/** The part of the settings store the proxy is read from. */
export interface ProxySettings {
  get: ((key: 'network.route.proxy') => string) & ((key: 'network.route.kind') => RouteKind)
  onChange: (listener: (change: { readonly key: string }) => void) => () => void
}

export interface RouteService {
  readonly hub: RouteHub
  readonly controller: RouteController
  readonly store: RouteStore
  /** Where routed traffic leaves now: Nym's target, the SOCKS5 address, or undefined when the choice is an address and none is set or it is not one. */
  proxy: () => RouteTarget | undefined
  /** The provider for a target that is not a SOCKS5 address (Nym), or undefined for one that is. */
  providerFor: (key: string, target: RouteTarget) => RouteProvider | undefined
  /** The Nym tunnel: asked for by every route that leaves through it. */
  readonly nym: NymSubsystem
  /** An app was taken away: its route is cleared, and its front and sessions are let go. A route that cannot be cleared stays. */
  forget: (origin: string) => void
  /** Reads the proxy from the settings store from now on, and tells the hub when it changes. Call once the settings are read. */
  followSettings: (settings: ProxySettings) => void
}

const KEY = 'network.route.proxy'
const KIND_KEY = 'network.route.kind'

export interface RouteServiceOptions {
  readonly store: RouteStore
  /** The saved proxy setting, read before the settings store is: what applies until `followSettings`. */
  readonly savedProxy: string
  /** The saved choice of where routed traffic leaves, read the same way. */
  readonly savedKind: RouteKind
  readonly nym: NymSubsystem
  /** The apps installed here, asked only while the store cannot say which are routed. */
  readonly installed?: () => readonly string[]
  readonly electron: Omit<RouteControllerDeps, 'hub'>
}

export function createRouteService (options: RouteServiceOptions): RouteService {
  let current = options.savedProxy
  let kind = options.savedKind
  const proxy = (): RouteTarget | undefined => kind === 'nym' ? NYM_TARGET : parseProxyAddress(current)
  // The user name is the same hash of the key the SOCKS5 provider sends, so Nym isolates by app as a SOCKS5 proxy would.
  const isolation = isolationCredentials()
  const providerFor = (key: string, target: RouteTarget): RouteProvider | undefined => isNymTarget(target) ? createNymProvider(options.nym, isolation(key).userId) : undefined
  const hub = createRouteHub({ store: options.store, proxy, providerFor, ...(options.installed === undefined ? {} : { installed: options.installed }) })
  const controller = createRouteController({ ...options.electron, hub })
  return {
    hub,
    controller,
    store: options.store,
    proxy,
    providerFor,
    nym: options.nym,
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
        const address = settings.get(KEY)
        const chosen = settings.get(KIND_KEY)
        if (address === current && chosen === kind) return
        // An address typed while Nym is the choice changes no route.
        const moved = chosen !== kind || (kind === 'socks5' && address !== current)
        current = address
        kind = chosen
        if (moved) hub.proxyChanged()
      }
      read()
      settings.onChange((change) => { if (change.key === KEY || change.key === KIND_KEY) read() })
    }
  }
}
