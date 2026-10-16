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
import type { NymEndpoint, NymSubsystem } from './nym-subsystem.js'
import type { RouteEndpoint } from '../../protocols/local-node/protocol.js'
import type { NymPrivacy } from '../../protocols/nym-tunnel/protocol.js'
import { createRouteSwitch } from './route-switch.js'
import type { RouteSwitch, RouteSwitchWorld } from './route-switch.js'
import type { RouteStore } from './route-store.js'
import type { TunnelKind } from './route-state.js'

/** The part of the settings store the proxy, the choice of tunnel and the browser-wide setting are read from. */
export interface ProxySettings {
  get: ((key: 'network.route.proxy') => string) & ((key: 'network.route.kind') => TunnelKind) & ((key: 'network.tunnel.everywhere') => boolean) & ((key: 'network.nym.privacy') => NymPrivacy) & ((key: 'network.nym.enabled') => boolean)
  onChange: (listener: (change: { readonly key: string }) => void) => () => void
}

export interface RouteService {
  readonly hub: RouteHub
  readonly controller: RouteController
  readonly store: RouteStore
  /** The one path that turns an app's or a website's tunnel on or off. */
  readonly routeSwitch: RouteSwitch
  /** Where traffic of the default tunnel leaves now: Nym's target, the SOCKS5 address, or undefined when the choice is an address and none is set or it is not one. Orivon's own requests and the local nodes leave here. */
  proxy: () => RouteTarget | undefined
  /** Where traffic of the tunnel `kind` leaves now: Nym's target, or the SOCKS5 address saved (undefined when none is set or it is not one). */
  targetOf: (kind: TunnelKind) => RouteTarget | undefined
  /** Whether the whole browser goes through the tunnel unless an origin is set to off: the setting as it stands now. */
  everywhere: () => boolean
  /** The tunnel the person chose for everything that has no choice of its own: the setting as it stands now. */
  defaultKind: () => TunnelKind
  /** The provider for a target that is not a SOCKS5 address (Nym), or undefined for one that is. */
  providerFor: (key: string, target: RouteTarget) => RouteProvider | undefined
  /** Where the local node named `key` leaves while the whole browser is on the tunnel: the tunnel's SOCKS5 address with a sign-in of its own. Rejects, in words, when the tunnel cannot carry it. */
  nodeEndpoint: (key: string) => Promise<RouteEndpoint>
  /** Called when the person chooses the other tunnel as the default. Returns the unsubscribe. */
  onDefaultKindChange: (listener: () => void) => () => void
  /** Called when an address `nodeEndpoint` handed out stops being the tunnel's. Returns the unsubscribe. */
  onNodeRouteMoved: (listener: () => void) => () => void
  /** The Nym tunnel: asked for by every route that leaves through it. */
  readonly nym: NymSubsystem
  /** An app was taken away: its route is cleared, and its front and sessions are let go. A route that cannot be cleared stays. */
  forget: (origin: string) => void
  /** Reads the proxy from the settings store from now on, and tells the hub when it changes. Call once the settings are read. */
  followSettings: (settings: ProxySettings) => void
}

const KEY = 'network.route.proxy'
const KIND_KEY = 'network.route.kind'
const EVERYWHERE_KEY = 'network.tunnel.everywhere'
const PRIVACY_KEY = 'network.nym.privacy'
const NYM_KEY = 'network.nym.enabled'

export interface RouteServiceOptions {
  readonly store: RouteStore
  /** The saved proxy setting, read before the settings store is: what applies until `followSettings`. */
  readonly savedProxy: string
  /** The saved choice of where routed traffic leaves, read the same way. */
  readonly savedKind: TunnelKind
  readonly nym: NymSubsystem
  /** The apps installed here, asked only while the store cannot say what was set. */
  readonly installed?: () => readonly string[]
  /** The saved browser-wide setting, read before the settings store is: what applies until `followSettings`. */
  readonly savedEverywhere?: boolean
  /** Overrides the browser-wide setting; for a test. */
  readonly everywhere?: () => boolean
  /** What the switch reads about the world: the app's files held here, its origin written to disk, and a website's own storage. */
  readonly switchWorld?: RouteSwitchWorld
  readonly electron: Omit<RouteControllerDeps, 'hub'>
}

export function createRouteService (options: RouteServiceOptions): RouteService {
  let current = options.savedProxy
  let kind = options.savedKind
  let everywhereNow = options.savedEverywhere ?? false
  const everywhere = options.everywhere ?? (() => everywhereNow)
  const targetOf = (which: TunnelKind): RouteTarget | undefined => which === 'nym' ? NYM_TARGET : parseProxyAddress(current)
  const proxy = (): RouteTarget | undefined => targetOf(kind)
  // The user name is the same hash of the key the SOCKS5 provider sends, so Nym isolates by app as a SOCKS5 proxy would.
  const isolation = isolationCredentials()
  const providerFor = (key: string, target: RouteTarget): RouteProvider | undefined => isNymTarget(target) ? createNymProvider(options.nym, isolation(key).userId) : undefined
  let handedOut: NymEndpoint | undefined
  const nodeEndpoint = async (key: string): Promise<RouteEndpoint> => {
    const target = proxy()
    if (target === undefined) throw new Error('the tunnel has no address set')
    const credentials = isolation(`local-node:${key}`)
    if (!isNymTarget(target)) return { host: target.host, port: target.port, userId: credentials.userId, password: credentials.password }
    try {
      handedOut = await options.nym.ensure()
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Nym is not available')
    }
    return { host: '127.0.0.1', port: handedOut.port, userId: credentials.userId, password: handedOut.secret }
  }
  const onNodeRouteMoved = (listener: () => void): (() => void) => options.nym.onChange(() => {
    if (handedOut === undefined || options.nym.endpoint() === handedOut) return
    handedOut = undefined
    listener()
  })
  const defaultKind = (): TunnelKind => kind
  const kindListeners = new Set<() => void>()
  const hub = createRouteHub({ store: options.store, targetOf, defaultKind, providerFor, everywhere, ...(options.electron.isApp === undefined ? {} : { isApp: options.electron.isApp }), ...(options.installed === undefined ? {} : { installed: options.installed }) })
  const controller = createRouteController({ ...options.electron, hub })
  const routeSwitch = createRouteSwitch({ targetOf, defaultKind, store: options.store, controller, hub }, options.switchWorld ?? { isPinned: () => false, isPersistable: () => false })
  return {
    hub,
    controller,
    store: options.store,
    routeSwitch,
    proxy,
    targetOf,
    everywhere,
    defaultKind,
    providerFor,
    nodeEndpoint,
    onNodeRouteMoved,
    onDefaultKindChange: (listener) => { kindListeners.add(listener); return () => { kindListeners.delete(listener) } },
    nym: options.nym,
    forget: (origin) => {
      try {
        // An unreadable list holds no entry to clear, and cannot be written to.
        if (!options.store.unreadable()) options.store.setEntry(origin, undefined)
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
        const previous = kind
        const addressMoved = address !== current
        current = address
        kind = chosen
        if (chosen !== previous) {
          hub.defaultKindChanged(previous)
          for (const listener of [...kindListeners]) listener()
        }
        // Only what goes through the proxy hears of its address; an address typed while Nym is the only choice in use changes no route.
        if (addressMoved) hub.addressChanged()
      }
      const readEverywhere = (): void => {
        const next = settings.get(EVERYWHERE_KEY)
        if (next === everywhereNow) return
        const previous = everywhereNow
        everywhereNow = next
        hub.everywhereChanged(previous)
      }
      const readNym = (): void => { options.nym.setEnabled(settings.get(NYM_KEY)) }
      read()
      readEverywhere()
      readNym()
      options.nym.setPrivacy(settings.get(PRIVACY_KEY))
      settings.onChange((change) => {
        if (change.key === KEY || change.key === KIND_KEY) read()
        else if (change.key === EVERYWHERE_KEY) readEverywhere()
        else if (change.key === NYM_KEY) readNym()
        else if (change.key === PRIVACY_KEY) options.nym.setPrivacy(settings.get(PRIVACY_KEY))
      })
    }
  }
}
