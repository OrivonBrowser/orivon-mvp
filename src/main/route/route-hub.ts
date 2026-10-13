// Which origins (installed apps and websites alike) go through the proxy, and what each needs running for it: its
// route (read by the broker and the loader), its loopback front (read by Chromium) and its health (read by the Settings
// page and the site-info popover). Electron-free. A routed origin with no proxy set gets a route that refuses: it never
// falls back to a direct one. When the store cannot say what the person set, every origin is routed while a tunnel is set.

import type { Route, RouteFor, RouteProvider } from '../../broker/route/provider.js'
import { createSocks5Provider, isolationCredentials, routeAnswered } from '../../broker/route/socks5.js'
import { createRouteFor } from '../../broker/route/table.js'
import type { RouteTarget } from '../../broker/route/table.js'
import { fail } from '../../broker/errors.js'
import { startRouteFront } from './front.js'
import type { RouteFront } from './front.js'
import type { RouteStore } from './route-store.js'
import { differsFromDefault, tunnelStateOf } from './route-state.js'

export type RouteChangeCause = 'switch' | 'proxy'

/** What the Settings page and the popover say about an app's route: `idle` is a route nothing has used yet. */
export type RouteState = 'off' | 'no-proxy' | 'idle' | 'ok' | 'down'

export interface RouteHubOptions {
  readonly store: RouteStore
  /** The proxy the person set, read on every use. */
  readonly proxy: () => RouteTarget | undefined
  /** Whether the whole browser goes through the tunnel unless an origin says otherwise: the default an origin with no entry follows. Off until the browser-wide setting exists. */
  readonly everywhere?: () => boolean
  /** The apps installed on this computer, asked when the proxy changes while the store cannot say what was set, so their sessions are pointed again. */
  readonly installed?: () => readonly string[]
  /** Builds the provider for one app and proxy where the proxy is not a SOCKS5 address (Nym); undefined falls back to SOCKS5 with a distinct username and password per app. */
  readonly providerFor?: (key: string, target: RouteTarget) => RouteProvider | undefined
}

export interface RouteHub {
  /** For `CreateBrokerOptions.routeFor` and the loader's reach path. */
  readonly routeFor: RouteFor
  isRouted: (origin: string) => boolean
  /** Whether a website at `origin` runs in a session of its own: its state differs from the default, or the store cannot be read. */
  usesOwnSession: (origin: string) => boolean
  /** Whether the list of tunnel settings could not be read, so that every origin counts as routed while a tunnel is set. */
  unreadable: () => boolean
  state: (origin: string) => RouteState
  /** The app's front, started on first use. Rejects for an app that is not routed. */
  front: (origin: string) => Promise<RouteFront>
  /** The credentials the front listening on `port` expects, for the proxy challenge Chromium answers through the app. */
  credentialsForPort: (port: number) => { readonly username: string, readonly password: string } | undefined
  /** Call when the proxy setting changed. */
  proxyChanged: () => void
  /** Ends every tunnel the app has through its front. */
  closeTunnels: (origin: string) => void
  /** Called when an app's route was switched on or off, and for every routed app when the proxy changed. */
  onChange: (listener: (origin: string, routed: boolean, cause: RouteChangeCause) => void) => () => void
  /** Resolves when the fronts of switched-off apps have stopped. */
  settled: () => Promise<void>
  dispose: () => Promise<void>
}

const REFUSING_PROVIDER: RouteProvider = {
  connect: async () => { throw fail('unreachable', 'no proxy is set for this app') }
}
const REFUSING_ROUTE: Route = { provider: REFUSING_PROVIDER }

export function createRouteHub (options: RouteHubOptions): RouteHub {
  const { store } = options
  const everywhere = options.everywhere ?? (() => false)
  const credentials = isolationCredentials()
  const health = new Map<string, 'ok' | 'down'>()
  const fronts = new Map<string, Promise<RouteFront>>()
  /** The fronts that are listening, which is what a challenge's port can name. */
  const started = new Map<string, RouteFront>()
  const stopping = new Set<Promise<void>>()
  const listeners = new Set<(origin: string, routed: boolean, cause: RouteChangeCause) => void>()
  const emit = (origin: string, routed: boolean, cause: RouteChangeCause): void => { for (const listener of [...listeners]) listener(origin, routed, cause) }

  /** Everything that goes through an app's route, from any caller, counts toward its health. */
  const tracked = (key: string, provider: RouteProvider): RouteProvider => ({
    ...provider,
    connect: async (host, port, signal) => {
      try {
        const socket = await provider.connect(host, port, signal)
        health.set(key, 'ok')
        return socket
      } catch (error) {
        // A proxy that refused one destination is up; only a route that could not be used says down.
        if (!signal.aborted) health.set(key, routeAnswered(error) ? 'ok' : 'down')
        throw error
      }
    }
  })
  const build = (key: string, target: RouteTarget): RouteProvider => options.providerFor?.(key, target) ?? createSocks5Provider({ host: target.host, port: target.port, credentials: credentials(key) })
  /** An unreadable list is not "nothing routed": with a proxy set, every origin is. */
  const unreadableWithProxy = (): boolean => store.unreadable() && options.proxy() !== undefined
  const routed = (origin: string): boolean => unreadableWithProxy() || tunnelStateOf(store.stateOf(origin), everywhere()) === 'on'
  const table = createRouteFor({
    targetFor: (key) => routed(key) ? options.proxy() : undefined,
    providerFor: (key, target) => tracked(key, build(key, target))
  })
  const routeFor: RouteFor = (key) => routed(key) ? table(key) ?? REFUSING_ROUTE : undefined

  const stopFront = (origin: string): void => {
    const running = fronts.get(origin)
    if (running === undefined) return
    fronts.delete(origin)
    started.delete(origin)
    const stopped = running.then(async (front) => { await front.close() }, () => {}).finally(() => { stopping.delete(stopped) })
    stopping.add(stopped)
  }

  store.onChange((origin, entry, previous) => {
    health.delete(origin)
    const now = tunnelStateOf(entry, everywhere()) === 'on'
    // An entry that says what the default already says changes nothing for the origin.
    if (now === (tunnelStateOf(previous, everywhere()) === 'on')) return
    if (!now) stopFront(origin)
    emit(origin, now, 'switch')
  })

  return {
    routeFor,
    isRouted: routed,
    usesOwnSession: (origin) => unreadableWithProxy() || differsFromDefault(store.stateOf(origin), everywhere()),
    unreadable: () => store.unreadable(),
    state: (origin) => {
      if (!routed(origin)) return 'off'
      if (options.proxy() === undefined) return 'no-proxy'
      return health.get(origin) ?? 'idle'
    },
    front: async (origin) => {
      if (!routed(origin)) throw new Error('this origin is not routed')
      let running = fronts.get(origin)
      if (running === undefined) {
        // Recorded as listening only while it is still the app's front: one that was switched off meanwhile is closing.
        const starting: Promise<RouteFront> = startRouteFront({
          provider: () => options.proxy() === undefined ? undefined : routeFor(origin)?.provider,
          // Its secret answers a proxy challenge for its port alone, so it goes with the port: a program that takes the port next is never answered.
          onClosed: () => { void starting.then((front) => { if (started.get(origin) === front) { started.delete(origin); fronts.delete(origin) } }, () => {}) }
        }).then((front) => { if (fronts.get(origin) === starting) started.set(origin, front); return front })
        running = starting
        fronts.set(origin, starting)
        starting.catch(() => { if (fronts.get(origin) === starting) fronts.delete(origin) })
      }
      return await running
    },
    credentialsForPort: (port) => {
      for (const front of started.values()) if (front.port === port) return { username: front.username, password: front.secret }
      return undefined
    },
    proxyChanged: () => {
      health.clear()
      // With the list unreadable, setting or clearing the proxy changes which origins are routed at all.
      const affected = new Set([...store.origins(), ...fronts.keys(), ...(store.unreadable() ? options.installed?.() ?? [] : [])])
      for (const origin of affected) {
        void fronts.get(origin)?.then((front) => { front.closeTunnels() }, () => {})
        const now = routed(origin)
        if (!now) stopFront(origin)
        emit(origin, now, 'proxy')
      }
    },
    closeTunnels: (origin) => { void fronts.get(origin)?.then((front) => { front.closeTunnels() }, () => {}) },
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    settled: async () => { await Promise.all([...stopping]) },
    dispose: async () => {
      for (const origin of [...fronts.keys()]) stopFront(origin)
      await Promise.all([...stopping])
    }
  }
}
